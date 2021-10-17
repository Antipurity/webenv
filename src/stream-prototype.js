// Here lies the prototype for all WebEnv-side streams.



const { signalUpdate, signalNormalize } = require('./signal-stats.js')
const { overwriteArray } = require('./int-encoding.js')



const Observations = exports.Observations = Float32Array
const performance = exports.performance = require('perf_hooks').performance



// (`Object.freeze`ing this would have been good, if it didn't prevent children from defining their own `lang` and such.)
exports.streamPrototype = {
    docs:`This encapsulates all information about one stream of data.

To create a new stream from this prototype, use \`stream = await streamPrototype.create(relaunch = null).open(env, index)\`.

The result is a promise for the environment, which is an object with:
- \`await relink(...interfaces)\`: changes interfaces at run-time. Agents might get confused, since they likely rely on positions. (Use \`stream.relink(MODIFY(stream.interfaces))\` to handle dynamic links.)
- \`reads:Number\`: how many observations are available as floats.
- \`writes:Number\`: how many actions are available as floats.
- Low-level:
    - \`await read()\`: returns observations as -1…1 32-bit floats, NaN where not provided.
    - \`await write(Actions)\`: accepts the numeric actions, and performs them.
- \`await close()\`: ends this stream. \`env\` is not notified.`,

    // Public interface.
    interfaces: null,
    env: null, index: null,
    reads: 0,
    writes: 0,
    settings: null,
    // May always remain null, if using a non-Puppeteer backend.
    browser: null, page: null, cdp: null, extensionPage: null,

    // Non-`settings` parameters, hidden from view.
    lang: 'en-US,en',
    lowball: .5, // Timer is run this much faster than it seems to need.
    maxRelaunchAttempts: 32,
    maxIOArraySize: 0, // Would be terrible if hackers can just make us allocate 16GB on demand.
    IOArraySizeReserve: 0,

    create(relaunch = null) {
        // Factory function: creates an object, and returns it.
        //   (JS classes are boring.)
        const res = Object.create(this)
        res._relaunch = relaunch
        return res
    },

    async open(env, index) {
        // Public interface. (More efficient to set this to defaults than to have many object shapes.)
        this.interfaces = null
        this.env = env, this.index = index
        this.reads = 0, this.writes = 0
        this.settings = Object.create(null)
        this.browser = null, this.page = null, this.cdp = null, this.extensionPage = null
        // Default settings.
        Object.assign(this.settings, {
            homepage: 'about:blank',
            simultaneousSteps: 16,
            width: 640,
            height: 480,
            userProfile: stream => require('path').join(__dirname, '..', 'puppeteer-chrome-profile-' + stream.index),
            hidePredictions: false,
        })
        // Private state.
        this._stall = null // A promise when a `relaunch` is in progress.
        this._watchdogCheckId = setInterval(() => { // This watchdog timer is easier than fixing rare-hang-on-navigation bugs.
            if (!this.env || performance.now()-this._lastStepEnd < 15000) return
            this._relaunchRetrying()
        }, 30000)
        this._lastStepEnd = performance.now() // For measuring time between steps.
        this._stepsNow = 0 // Throughput is maximized by lowballing time-between-steps, but without too many steps at once.
        this._stepId = 0 // Incremented with rollover each step.
        this._lastStepId = 0 // When a step completes, it sets this to what `._stepId` was at its beginning.
        this._killed = false // `.close()` will set this to true.
        await this._relaunchRetrying()
        return this
    },
    async read() {
        // Collect webenv-side reads.
        // To prevent torn writes, `await end()` right before the last synchronous write.
        if (this._killed) throw new Error('Cannot read from a closed environment')
        this._relaunchIfNeeded()
        if (!this.reads) return
        let then
        try {
            // Defer observations to interfaces.
            let waitingOn = 0, endPromise = new Promise(f => then=f)
            const inds = this._obsInds, a = this._all, v = this._views
            const tmp = this._allocArray(0)
            waitingOn = inds.length
            for (let i = 0; i < inds.length; ++i) {
                const j = inds[i]
                if (!a[j]) continue
                const r = a[j].read(this, v[j].obs, end)
                if (r instanceof Promise) tmp.push(r.then(end))
                else end()
            }
            // Await all promises at once.
            for (let i = 0; i < tmp.length; ++i) await tmp[i]
            this._allocArray(tmp)
            return this._obsFloats
            function end() {
                // Resolve if the last end, and always return a promise.
                --waitingOn // (Ending a spot multiple times should not matter because of how `end` should be used.)
                if (!waitingOn) then()
                return endPromise
            }
        } catch (err) { then && then();  if (!this._stall) throw err }
    },
    async write(acts) {
        if (this._killed) throw new Error('Cannot write to a closed environment')
        this._relaunchIfNeeded()
        if (!this.writes) return
        // Copy acts to our buffer.
        if (!(acts instanceof Observations))
            throw new Error('Expected a float array')
        if (acts.length !== this.writes)
            throw new Error(`Expected ${this.writes} actions but got ${acts.length}`)
        try {
            if (acts !== this._actFloats) this._actFloats.set(acts)
            // Defer actions to interfaces.
            const inds = this._actInds, a = this._all, v = this._views
            const tmp = this._allocArray(0)
            for (let i = 0; i < inds.length; ++i) {
                const j = inds[i]
                if (!a[j]) continue
                const r = a[j].write(this, v[j].pred, v[j].act)
                if (r instanceof Promise) tmp.push(r)
            }
            // Await all promises at once.
            for (let i = 0; i < tmp.length; ++i) await tmp[i]
            this._allocArray(tmp)
            // Return nothing, apart from a promise.
        } catch (err) { if (!this._stall) throw err }
    },
    async relink(...interfaces) {
        // Remember where old interfaces were.
        const oldIndices = new Map
        if (this._all)
            for (let i = 0; i < this._all.length; ++i)
                oldIndices.set(this._all[i], i)
        const ownInterfaces = []

        // Flatten the interface tree.
        const all = [], indices = new Map
        let own
        async function track(o) {
            if (o instanceof Promise) o = await o
            if (Array.isArray(o)) return Promise.all(o.map(track))
            if (!o || typeof o != 'object') throw new Error('All must be webenv interfaces, got '+o)
            if (indices.has(o)) return // De-duplicate.
            indices.set(o, all.length)
            all.push(o)
            if (own) ownInterfaces.push(o)
        }
        own = false, await track(this.env.interfaces)
        own = true, await track(interfaces)
        // Respect priorities, but do not shuffle needlessly.
        all.sort((a,b) => ((b.priority || 0) - (a.priority || 0)) || (indices.get(a) - indices.get(b)))
        const rInds = [], wInds = [], agentInds = []
        for (let i = 0; i < all.length; ++i) {
            const o = all[i]
            if (typeof o.read == 'function') rInds.push(i)
            if (typeof o.write == 'function') wInds.push(i)
            if (typeof o.agent == 'function') agentInds.push(i)
        }

        // Initialize the new, move state of both old and new, and deinitialize the old.
        //   Also listen to settings.
        let reads = 0, writes = 0
        const allReadOffsets = [], allWriteOffsets = []
        const seen = new Set
        const tmp = this._allocArray(0)
        for (let i = 0; i < all.length; ++i) {
            const o = all[i], prev = oldIndices.get(o)
            seen.add(o)
            if (typeof o.init == 'function')
                try {
                    const r = prev === undefined && o.init(this)
                    if (r instanceof Promise) tmp.push(r)
                } catch (err) { console.error(err) }
            allReadOffsets[i] = reads, allWriteOffsets[i] = writes
            if (typeof o.reads == 'number') {
                if (o.reads < 0 || o.reads !== o.reads>>>0)
                    throw new Error('Bad input count: '+o.reads)
                reads += o.reads
            }
            if (typeof o.writes == 'number') {
                if (o.writes < 0 || o.writes !== o.writes>>>0)
                    throw new Error('Bad output count: '+o.writes)
                writes += o.writes
            }
            if (o.settings && typeof o.settings == 'object')
                Object.assign(this.settings, o.settings)
        }
        this.maxIOArraySize = Math.max(1024, reads, writes) + this.IOArraySizeReserve
        for (let i = 0; i < tmp.length; ++i)
            try { await tmp[i] }
            catch (err) { console.error(err) }
        this._allocArray(tmp)
        if (this._all) {
            const a = this._all, tmp = this._allocArray(0)
            for (let i = 0; i < a.length; ++i) {
                if (seen.has(a[i]) || typeof a[i].deinit != 'function') continue
                const r = a[i].deinit(this)
                if (r instanceof Promise) tmp.push(r)
            }
            // Await all promises at once.
            for (let i = 0; i < tmp.length; ++i) await tmp[i]
            this._allocArray(tmp)
        }

        // Schedule the interpreter loop if there are now agents.
        const looped = !!(this._agentInds && this._agentInds.length)
        const looping = !!agentInds.length
        if (!this._stepsNow && !looped && looping)
            ++this._stepsNow, setTimeout(this._step, 0, this)

        // Finalize what we computed here.
        this.interfaces = ownInterfaces
        this._all = all, this._allReadOffsets = allReadOffsets, this._allWriteOffsets = allWriteOffsets
        this._obsInds = rInds, this._actInds = wInds, this._agentInds = agentInds

        this.resize(reads, writes)
    },
    resize(reads, writes) {
        // This is for `directLink` only.
        // Resizes reads/writes, making the last interface access more or less.
        const chR = !this._views || this.reads !== reads, chW = !this._views || this.writes !== writes
        if (!chR && !chW) return
        this.maxIOArraySize = Math.max(1024, reads, writes) + this.IOArraySizeReserve

        const all = this._all, allReadOffsets = this._allReadOffsets, allWriteOffsets = this._allWriteOffsets

        // Resize observations/actions. Preserve previous data if possible.
        const obsFloats  = chR ? new Observations(reads).fill(NaN) : this._obsFloats
        const predFloats = chR ? new Observations(reads).fill(NaN) : this._predFloats
        const actFloats  = chW ? new Observations(writes).fill(0) : this._actFloats
        chR && overwriteArray(obsFloats, this._obsFloats)
        chR && overwriteArray(predFloats, this._predFloats)
        chW && overwriteArray(actFloats, this._actFloats)

        // Pre-compute observation/action slices.
        const _ = undefined
        const views = new Array(all.length).fill()
        for (let i = 0; i < all.length; ++i) {
            const o = all[i]
            const ro = allReadOffsets[i], wo = allWriteOffsets[i]
            const re = o.reads !== 'rest' ? ro + o.reads : _, we = o.writes !== 'rest' ? wo + o.writes : _
            views[i] = {
                obs:  chR ? (o.reads  !== _ ?  obsFloats.subarray(ro, re) :  obsFloats) : this._views[i].obs,
                pred: chR ? (o.reads  !== _ ? predFloats.subarray(ro, re) : predFloats) : this._views[i].pred,
                act:  chW ? (o.writes !== _ ?  actFloats.subarray(wo, we) :  actFloats) : this._views[i].act,
            }
        }

        this.reads = reads, this.writes = writes
        this._obsFloats = obsFloats, this._predFloats = predFloats, this._actFloats = actFloats
        this._views = views
    },
    async close() {
        if (this._killed) return
        clearInterval(this._watchdogCheckId)
        this._killed = true
        if (this._all) {
            const a = this._all, tmp = this._allocArray(0)
            for (let i = 0; i < a.length; ++i) {
                if (typeof a[i].deinit != 'function') continue
                const r = a[i].deinit(this)
                if (r instanceof Promise) tmp.push(r)
            }
            // Await all promises at once.
            for (let i = 0; i < tmp.length; ++i) await tmp[i]
            this._allocArray(tmp)
        }
        // Close the browser.
        if (this.browser) await this.browser.close()
        // Return nothing, apart from a promise.
    },
    _relaunchIfNeeded() {
        if (typeof this._relaunch != 'function') return
        if (this._killed) return
        if (!this.browser || this.browser.isConnected() && !this.page.isClosed()) return
        if (this._stall) return // No double-relaunching please.
        return this._relaunchRetrying()
    },
    async _relaunchRetrying(n = this.maxRelaunchAttempts) {
        if (typeof this._relaunch != 'function') return
        let then, prevStall = this._stall;  this._stall = new Promise(t => then = t);  await prevStall
        try {
            for (let i = 1; i < n; ++i)
                try { return await this._relaunch() }
                catch (err) { console.error('launch error', err) }
            return await this._relaunch()
        } catch (err) { this.browser && this.browser.close();  throw err }
        finally { then(), this._stall = null }
    },
    async _step(res) {
        // Read, think, write.
        // Each agent takes f32 observations (to read) and predictions and actions (to write).
        // It returns a promise, which must resolve to `true`, else its loop will stop.
        try {
            if (res._killed) return
            res._relaunchIfNeeded()
            if (!res._agentInds.length) return

            // Don't schedule too many steps at once. If all die, end-of-step will schedule anyway.
            if (res._stepsNow < res.settings.simultaneousSteps)
                ++res._stepsNow, setTimeout(res._step, Math.max(0, +res.env._period * res.lowball), res)

            const stepId = res._stepId
            res._stepId = (res._stepId + 1)>>>0

            try {
                await res.read()

                const results = res._allocArray(res._agentInds.length).fill()
                for (let i = 0; i < results.length; ++i)
                    try {
                        const j = res._agentInds[i], o = res._all[j]
                        results[i] = o.agent(res, res._views[j])
                    } catch (err) { console.error(err) } // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (results[i] instanceof Promise)
                        try { results[i] = await results[i] }
                        catch (err) { console.error(err),  results[i] = undefined } // Unlink on exception.
                res._allocArray(results)

                await res.write(res._actFloats)
            } catch (err) {
                if (!res._stall) console.error(err)
                // Do not let exceptions kill us.
            }

            res.env._period.set(performance.now() - res._lastStepEnd)
            res._lastStepEnd = performance.now()
            res._lastStepId = stepId
        } finally {
            --res._stepsNow

            // Don't let the fire die out.
            //   (If +env._period is too low, this trigger can get hit, and stall the pipeline.)
            //   (If +env._period is mostly accurate, there should be a steady stream of new-steps.)
            if (!res._stepsNow)
                ++res._stepsNow, setTimeout(res._step, Math.max(0, +res.env._period * res.lowball), res)
        }
    },
    _allocArray:function fn(a) {
        // this._allocArray(length)⇒array; this._allocArray(array) de-allocates it.
        // Don't make mistakes: double-free or use-after-free.
        if (!fn.free) fn.free = []
        if (typeof a == 'number' && a === a>>>0) { // Allocate.
            const arr = fn.free.length ? fn.free.pop() : []
            arr.length = a
            return arr
        }
        if (!Array.isArray(a)) throw new Error("Expected array length or an array")
        a.length = 0
        if (fn.free.length > 32) return // Prevent madness.
        fn.free.push(a)
    },
}