// Here lies the prototype for all WebEnv-side streams.



const { signalUpdate, signalNormalize } = require('./signal-stats.js')



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
            port: 1234,
            httpsOptions: null,
        })
        // Private state.
        this._stall = null // A promise when a `relaunch` is in progress.
        this._unlink = new Set, this._pendingUnlink = new WeakSet
        this._watchdogCheckId = setInterval(() => { // This watchdog timer is easier than fixing rare-hang-on-navigation bugs.
            if (performance.now()-this._lastStepEnd < 15000) return
            this._relaunchRetrying()
        }, 30000)
        this._lastStepEnd = performance.now() // For measuring time between steps.
        this._period = new class ObsNumber { // Measuring time between steps.
            // A number that estimates some other number, independent of context (unlike a NN).
            // `webenv.frameTime` visualizes this.
            constructor(maxHorizon = 10000) {
                this.m = [0,0,0], this.maxHorizon = +maxHorizon
            }
            valueOf() { return this.m[1] }
            set(x) {
                signalUpdate(x, this.m, this.maxHorizon)
                return this.m[1]
            }
        }()
        if (env && env.streams && env.streams[0]) this._period.set(+env.streams[0]._period)
        this._stepsNow = 0 // Throughput is maximized by lowballing time-between-steps, but without too many steps at once.
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
            const inds = this._obsInds, a = this._all, obs = this._obsSlice
            const tmp = this._allocArray(0)
            waitingOn = inds.length
            for (let i = 0; i < inds.length; ++i) {
                if (!a[inds[i]] || this._pendingUnlink.has(a[inds[i]])) continue
                const r = a[inds[i]].read(this, obs[i], end)
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
            const inds = this._actInds, a = this._all
            const pred = this._predSlice, act = this._actSlice
            const tmp = this._allocArray(0)
            for (let i = 0; i < inds.length; ++i) {
                if (!a[inds[i]] || this._pendingUnlink.has(a[inds[i]])) continue
                const r = a[inds[i]].write(this, pred[i], act[i])
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
            if (typeof o.init == 'function') {
                const r = prev === undefined && o.init(this)
                if (r instanceof Promise) tmp.push(r)
            }
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
        for (let i = 0; i < tmp.length; ++i) await tmp[i]
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

        // Resize observations/actions.
        //   (Technically, could move obs/pred/act to new correct positions, but why?)
        const obsFloats = new Observations(reads)
        const predFloats = new Observations(reads)
        const actFloats = new Observations(writes)
        obsFloats.fill(NaN), predFloats.fill(NaN), actFloats.fill(NaN)

        // Pre-compute observation/action slices.
        const obsSlice = new Array(rInds.length).fill()
        const predSlice = new Array(rInds.length).fill()
        const bpe = Observations.BYTES_PER_ELEMENT
        const _ = undefined
        for (let i = 0; i < rInds.length; ++i) {
            const nr = allReadOffsets[rInds[i]]
            const r = all[rInds[i]].reads
            obsSlice[i] = r !== _ ? new Observations(obsFloats.buffer, nr * bpe, r) : obsFloats
        }
        const actSlice = new Array(wInds.length).fill()
        for (let i = 0; i < wInds.length; ++i) {
            const nr = allReadOffsets[wInds[i]], nw = allWriteOffsets[wInds[i]]
            const r = all[wInds[i]].reads, w = all[wInds[i]].writes
            predSlice[i] = r !== _ ? new Observations(predFloats.buffer, nr * bpe, r) : predFloats
            actSlice[i] = w !== _ ? new Observations(actFloats.buffer, nw * bpe, w) : actFloats
        }

        // Pre-compute agent args.
        const agentArgs = new Array(agentInds.length).fill()
        for (let i = 0; i < agentInds.length; ++i) {
            const j = agentInds[i], bpe = Observations.BYTES_PER_ELEMENT
            const o = all[j], r = allReadOffsets[j], w = allWriteOffsets[j]
            const args = [] // stream, obs, pred, act
            args.push(this)
            args.push(typeof o.reads == 'number' ? new Observations(obsFloats.buffer, r * bpe, o.reads) : obsFloats)
            args.push(typeof o.reads == 'number' ? new Observations(predFloats.buffer, r * bpe, o.reads) : predFloats)
            args.push(typeof o.writes == 'number' ? new Observations(actFloats.buffer, w * bpe, o.writes) : actFloats)
            agentArgs[i] = args
        }

        // Schedule the interpreter loop if there are now agents.
        const looped = !!(this._agentInds && this._agentInds.length)
        const looping = !!agentInds.length
        if (!this._stepsNow && !looped && looping)
            ++this._stepsNow, setTimeout(this._step, 0, this)

        // Finalize what we computed here.
        this.reads = reads, this.writes = writes
        this.interfaces = ownInterfaces
        this._allReadOffsets = allReadOffsets, this._allWriteOffsets = allWriteOffsets
        this._all = all, this._obsInds = rInds, this._actInds = wInds, this._agentInds = agentInds, 
        this._obsFloats = obsFloats
        this._predFloats = predFloats, this._actFloats = actFloats
        this._obsSlice = obsSlice, this._predSlice = predSlice
        this._actSlice = actSlice
        this._agentArgs = agentArgs
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
                ++res._stepsNow, setTimeout(res._step, Math.max(0, +res._period * res.lowball), res)

            try {
                await res.read()

                const results = res._allocArray(res._agentInds.length).fill()
                for (let i = 0; i < results.length; ++i)
                    try {
                        const o = res._all[res._agentInds[i]]
                        results[i] = !res._pendingUnlink.has(o) && o.agent(...res._agentArgs[i])
                    } catch (err) { console.error(err) } // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (results[i] instanceof Promise)
                        try { results[i] = await results[i] }
                        catch (err) { console.error(err),  results[i] = undefined } // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (!results[i]) {
                        const o = res._all[res._agentInds[i]]
                        res._unlink.add(o), res._pendingUnlink.add(o)
                    }
                res._allocArray(results)

                await res.write(res._actFloats)
            } catch (err) {
                if (!res._stall) console.error(err)
                // Do not let exceptions kill us.
            } finally {
                // Unlink the agents that do not want to live on.
                //   (Unless they're copied from the top-level, because, too much work to support that.)
                if (res._unlink.size) {
                    const bad = new Set(res._unlink)
                    res._unlink.clear()
                    let prevStall = res._stall;  res._stall = res.relink(res.interfaces.filter(o => !bad.has(o)));  await prevStall
                    prevStall = res._stall;  res._stall = null;  await prevStall
                    bad.forEach(o => res._pendingUnlink.delete(o))
                }
            }

            res._period.set(performance.now() - res._lastStepEnd)
            res._lastStepEnd = performance.now()
        } finally {
            --res._stepsNow

            // Don't let the fire die out.
            //   (If +res._period is too low, this trigger can get hit, and stall the pipeline.)
            //   (If +res._period is mostly accurate, there should be a steady stream of new-steps.)
            if (!res._stepsNow)
                ++res._stepsNow, setTimeout(res._step, Math.max(0, +res._period * res.lowball), res)
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