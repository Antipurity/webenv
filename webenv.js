// This was pretty easy, coded in 8 days.
//   +3 days of debugging.



const puppeteer = require('puppeteer')

const Observations = Float32Array

exports.init = docs(`Function. Pass in numeric interfaces (and optionally the homepage at the end), receive a promise.
The extensible creator of numeric Web interfaces, for machine learning: a truly general environment for AGI.

Without interfaces, this is next to useless.
All other members of this module either are such interfaces (such as \`webenv.defaults\`) or create them.
    Some are mostly observations, some are mostly actions, some are mostly agents (connecting observations to actions).
    Agents are called in a loop, which maximizes throughput.

The result is a promise for an object with:
- \`relink(...interfaces)\`: changes interfaces at run-time. Agents might get confused. (Prefer \`result.relink(MODIFY(result._all))\` to remembering the initial interfaces, to handle dynamic links.)
- \`reads:Number\`: how many observations are available as floats.
- \`writes:Number\`: how many actions are available as floats.
- Low-level:
    - \`read()=>Promise<Observations>\`: returns observations as -1…1 32-bit floats, NaN where not provided.
    - \`write(Actions)=>Promise<void>\`: accepts the numeric actions, and performs them.
- \`close()=>Promise<void>\`: ends this session.

Ideally, you should not treat observations/actions as anything other than vectors of approximately -1..1 32-bit floats. (Not necessarily square, not necessarily an image. Likely multimodal.)

To write new interfaces, look at the pre-existing interfaces.
    An interface is an object (or an array of interfaces) that may define:
    - \`.init(page, env)=>state\`, \`.deinit(page, state)\` (not called on browser relaunching);
    - \`.reads:Number\`, \`.read(page, state, obs)\` (modify \`obs\` in-place);
        - \`.observerInput(page, state)=>obsInput\`,
        - \`.observer(obsInput, video:{grab(x,y,w,h)=>pixels}, audio:{grab(sampleN=2048, sampleRate=44100)=>samples}, obsOutput)\` (before reading, these are collected from an extension, -1…1);
    - \`.writes:Number\`, \`.write(page, state, pred, act)\` (\`pred\` can predict the next read \`obs\`; do read from \`act\` and act on that);
    - \`.agent(obs, pred, act)=>continues\` (return false to unlink the agent);
    - \`priority:Number\` (for example, interfaces that read actions at write-time have priority of -1, to always go after action-fillers);
    - \`visState(page, state)=>vState\` (the result must be JSON-serializable, sent once at init-time), \`.visualize(obs, pred, elem, vState)\` (serialized into web-views to visualize data there, so write the function out fully).
    All functions are potentially asynchronous, and will be \`await\`ed if needed.
`, async function init(...interfaces) {
    // *Probably* don't need customization for the language, since it hardly even works.
    const lang = 'en-US,en'

    let stall = null // When we're re-launching a browser, this is a promise.

    class ObsNumber {
        // A number that estimates some other number, independent of context (unlike a NN).
        constructor(x, momentum = .99) { this.x = +x, this.m = +momentum }
        valueOf() { return this.x }
        set(x) { return this.x = this.m * this.x + (1 - this.m) * Math.max(-this.x, Math.min(x, this.x*2)) }
    }
    const performance = require('perf_hooks').performance
    let maxStepsNow = 16 // Controlled by WEBENV_SIMULTANEOUS_STEPS.
    const lowball = .95
    const res = {
        homepage: interfaces.find(x => typeof x == 'string'),
        _all:null, _allState:[],
        reads:0, writes:0,
        _lastStepEnd:performance.now(),
        _period:new ObsNumber(0), // Actual time between two consecutive steps.
        _stepsNow:0, // Throughput is maximized by lowballing time-between-steps, but without too many steps at once.
        async read() {
            // It might happen that a new read might get scheduled before an old one is finished.
            //   For these cases, make sure to only not modify internal buffers between `await`s, only modify in synchronous code.
            if (this._closed) throw new Error('Cannot read from a closed environment')
            relaunchIfNeeded()
            if (!this.reads) return
            // Collect extension-side observer results, then webenv-side reads.
            try {
                // Call observers. The extension will call `gotObserverData` for future frames.
                //   (No `await`: the observer stream is a bit delayed, for lower latency.)
                const obsInputs = _allocArray(this._observerIndices.length)
                for (let i = 0; i < this._observerIndices.length; ++i) {
                    const inAll = this._observerIndices[i], o = this._all[inAll]
                    if (o && typeof o.observerInput == 'function')
                        obsInputs[i] = o.observerInput(this._page, this._allState[inAll])
                    else obsInputs[i] = undefined
                }
                if (this._extPage.isClosed()) return
                this._extPage.evaluate(ins => void setTimeout(readObservers, 0, ins), obsInputs).catch(doNothing)
                // Defer observations to interfaces.
                const inds = this._obsInds, p = this._page, a = this._all, s = this._allState
                const obs = this._obsSlice
                const tmp = _allocArray(0)
                for (let i = 0; i < inds.length; ++i) {
                    const r = a[inds[i]].read(p, s[inds[i]], obs[i])
                    if (r instanceof Promise) tmp.push(r)
                }
                // Await all promises at once.
                for (let i = 0; i < tmp.length; ++i) await tmp[i]
                _allocArray(tmp)
                return this._obsFloats
            } catch (err) { if (!stall) throw err }
        },
        async write(acts) {
            if (this._closed) throw new Error('Cannot write to a closed environment')
            relaunchIfNeeded()
            if (!this.writes) return
            // Copy acts to our buffer.
            if (!(acts instanceof Observations))
                throw new Error('Expected a float array')
            if (acts.length !== this.writes)
                throw new Error(`Expected ${this.writes} actions but got ${acts.length}`)
            try {
                if (acts !== this._actFloats) this._actFloats.set(acts)
                // Defer actions to interfaces.
                const inds = this._actInds, p = this._page, a = this._all, s = this._allState
                const pred = this._predSlice, act = this._actSlice
                const tmp = _allocArray(0)
                for (let i = 0; i < inds.length; ++i) {
                    if (!a[inds[i]]) return
                    const r = a[inds[i]].write(p, s[inds[i]], pred[i], act[i])
                    if (r instanceof Promise) tmp.push(r)
                }
                // Await all promises at once.
                for (let i = 0; i < tmp.length; ++i) await tmp[i]
                _allocArray(tmp)
                // Return nothing, apart from a promise.
            } catch (err) { if (!stall) throw err }
        },
        async relink(...interfaces) {
            // Remember where old interfaces were.
            const oldIndices = new Map
            if (this._all)
                for (let i = 0; i < this._all.length; ++i)
                    oldIndices.set(this._all[i], i)

            // Flatten the interface tree.
            const all = [], indices = new Map
            async function track(o) {
                if (o instanceof Promise) o = await o
                if (typeof o == 'string') return res.homepage = o
                if (Array.isArray(o)) return o.forEach(track)
                if (!o || typeof o != 'object') throw new Error('All must be webenv interfaces')
                all.push(o)
            }
            await track(interfaces, 0)
            // Respect priorities, but do not shuffle needlessly.
            for (let i = 0; i < all.length; ++i) {
                if (indices.has(all[i])) throw new Error('Repeated interface')
                indices.set(all[i], i)
            }
            all.sort((a,b) => ((b.priority || 0) - (a.priority || 0)) || (indices.get(a) - indices.get(b)))
            const rInds = [], wInds = [], agentInds = [], allState = []
            for (let i = 0; i < all.length; ++i) {
                const o = all[i]
                if (typeof o.read == 'function') rInds.push(i)
                if (typeof o.write == 'function') wInds.push(i)
                if (typeof o.agent == 'function') agentInds.push(i)
            }

            // Initialize the new, move state of both old and new, and deinitialize the old.
            //   Also listen to WEBENV_SIMULTANEOUS_STEPS.
            let reads = 0, writes = 0
            const allReadOffsets = [], allWriteOffsets = []
            const seen = new Set
            for (let i = 0; i < all.length; ++i) {
                const o = all[i], prev = oldIndices.get(o)
                seen.add(o)
                if (typeof o.init == 'function')
                    allState[i] = prev === undefined ? o.init(this._page, res) : this._allState[prev]
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
                if (typeof o.WEBENV_SIMULTANEOUS_STEPS == 'number')
                    maxStepsNow = o.WEBENV_SIMULTANEOUS_STEPS >>> 0
            }
            for (let i = 0; i < all.length; ++i)
                if (allState[i] instanceof Promise)
                    allState[i] = await allState[i]
            if (this._all) {
                const p = this._page, a = this._all, s = this._allState
                const tmp = _allocArray(0)
                for (let i = 0; i < a.length; ++i) {
                    if (seen.has(a[i]) || typeof a[i].deinit != 'function') continue
                    const r = a[i].deinit(p, s[i])
                    if (r instanceof Promise) tmp.push(r)
                }
                // Await all promises at once.
                for (let i = 0; i < tmp.length; ++i) await tmp[i]
                _allocArray(tmp)
            }

            // Relink extension-side observers.
            const observerIndices = _allocArray(0)
            const observers = _allocArray(0)
            for (let i = 0; i < all.length; ++i) {
                const o = all[i]
                if (typeof o.observer == 'function' || typeof o.observer == 'string')
                    observerIndices.push(i),
                    observers.push({read:''+o.observer, offset:allReadOffsets[i], length:o.reads || 0})
            }
            const w = this.width || 0
            const h = this.height || 0
            await this._extPage.evaluate((o,w,h) => updateObservers(o,w,h), observers, w, h)

            // Resize observations/actions.
            //   (Technically, could move observations to correct positions, but why?)
            const obsFloats = new Observations(reads)
            const predFloats = new Observations(reads)
            const actFloats = new Observations(writes)
            obsFloats.fill(NaN), predFloats.fill(NaN), actFloats.fill(NaN)
            for (let i = 0, reads = 0, writes = 0; i < all.length; ++i) {
                const o = all[i]
                if (typeof o.reads == 'number')
                    reads += o.reads
                if (typeof o.writes == 'number')
                    writes += o.writes
            }

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
                const args = [] // obs, pred, act
                args.push(typeof o.reads == 'number' ? new Observations(obsFloats.buffer, r * bpe, o.reads) : obsFloats)
                args.push(typeof o.reads == 'number' ? new Observations(predFloats.buffer, r * bpe, o.reads) : predFloats)
                args.push(typeof o.writes == 'number' ? new Observations(actFloats.buffer, w * bpe, o.writes) : actFloats)
                agentArgs[i] = args
            }

            // Schedule the interpreter loop if there are now agents.
            const looped = !!(this._agentInds && this._agentInds.length)
            const looping = !!agentInds.length
            if (!this._stepsNow && !looped && looping)
                ++this._stepsNow, setTimeout(step, 0)

            // Finalize what we computed here.
            this.reads = reads, this.writes = writes
            this._allReadOffsets = allReadOffsets, this._allWriteOffsets = allWriteOffsets
            this._all = all, this._obsInds = rInds, this._actInds = wInds, this._agentInds = agentInds, this._allState = allState
            this._observerIndices = observerIndices
            this._obsFloats = obsFloats
            this._predFloats = predFloats, this._actFloats = actFloats
            this._obsSlice = obsSlice, this._predSlice = predSlice
            this._actSlice = actSlice
            this._agentArgs = agentArgs
        },
        _closed:false,
        async close() {
            if (this._closed) return
            clearInterval(watchdogCheckId)
            this._closed = true
            const p = this._page, a = this._all, s = this._allState
            const tmp = _allocArray(0)
            for (let i = 0; i < a.length; ++i) {
                const r = typeof a[i].deinit == 'function' ? a[i].deinit(p, s[i]) : null
                if (r instanceof Promise) tmp.push(r)
            }
            // Await all promises at once.
            for (let i = 0; i < tmp.length; ++i) await tmp[i]
            _allocArray(tmp)
            // Close the browser.
            await this._browser.close()
            // Return nothing, apart from a promise.
        },
    }
    // This watchdog timer is easier than fixing rare-hang-on-navigation bugs.
    const watchdogCheckId = setInterval(() => {
        if (performance.now()-res._lastStepEnd < 20000) return
        retry()
    }, 20000)
    const unlink = new Set
    await retry()
    return res
    function relaunchIfNeeded() {
        if (res._closed) return
        if (!res._browser || res._browser.isConnected() && !res._page.isClosed()) return
        if (stall) return // No double-relaunching please.
        return retry()
    }
    async function retry(n = 32, func = relaunch, arg = res) { // Only for `func=relaunch`.
        let then, prevStall = stall;  stall = new Promise(t => then = t);  await prevStall
        try {
            for (let i = 1; i < n; ++i)
                try { return await func(arg) }
                catch (err) { console.error('launch error', err) }
            return await func(arg)
        } catch (err) { res && res._browser && res._browser.close();  throw err }
        finally { then(), stall = null }
    }
    async function relaunch(res) {
        // Close the previous browser.
        if (res._browser) {
            const b = res._browser
            res._browser = null
            await b.close()
        }

        const ext = require('path').join(__dirname, 'extension')
        const profId = Math.random() * 16 | 0 // In case Chromiums overlap.
        const dataDir = require('path').join(__dirname, 'puppeteer-chrome-profile', 'p'+profId)

        // Remove folders that may be problematic for long-term stability. (Things never just work.)
        const fs = require('fs')
        function rm(...p) {
            const path = require('path').join(dataDir, ...p)
            return new Promise(then => fs.rm(path, { force:true, recursive:true }, then))
        }
        await Promise.all([rm('Crashpad', 'reports'), rm('BrowserMetrics'), rm('ShaderCache')])

        // Open the new browser.
        const _browser = res._browser = await puppeteer.launch({
            headless:false,
            defaultViewport:null,
            waitForInitialPage:false,
            args:[
                '--allow-file-access-from-files',
                '--autoplay-policy=no-user-gesture-required',
                '--load-extension=' + ext,
                '--disable-extensions-except=' + ext,
                '--whitelisted-extension-id=clmfcdjojibdkmjpbfbddhjiolfjhcgn',
                '--lang='+lang,
                '--disable-notifications',
                '--user-data-dir=' + dataDir,
                '--allow-profiles-outside-user-dir',
            ],
            ignoreDefaultArgs:[
                '--mute-audio',
                '--disable-gpu',
            ],
        })
        const _page = res._page = await _browser.newPage()
        _page.on('error', err => { throw err })
        closeAllPagesExcept(_browser, _page)
        const langParts = lang.split(',')
        ;[ // Thanks, async/await, very helpful for efficiency via parallelization. (Sarcasm.)
            res._cdp,
            res._chromeWidth,
            res._chromeHeight,
            res._extPage,
        ] = await Promise.all([
            _page.target().createCDPSession(),
            _page.evaluate(() => outerWidth - innerWidth),
            _page.evaluate(() => outerHeight - innerHeight),
            _browser.waitForTarget(t => t.type() === 'background_page' && t._targetInfo.title === 'capture').then(t => t.page()),
            _page.setUserAgent(''),
            _page.evaluateOnNewDocument(langParts => {
                Object.defineProperty(navigator, 'language', { value:langParts[0] })
                Object.defineProperty(navigator, 'languages', { value:langParts })
            }, langParts),
            _page.setExtraHTTPHeaders({ 'Accept-Language': langParts[langParts.length-1] }),
        ])
        const oldInters = res._all || interfaces
        res._all = [] // Call all initializers again, to re-attach event listeners.
        res._agentInds = [] // Re-launch the step loop if we have agents.
        const rlP = res.relink(...oldInters)
        let pP
        if (res.homepage)
            // Browser crahes are far more frequent if we don't wait at least a bit.
            pP = Promise.race([
                ...(await Promise.all([
                    _page.goto(res.homepage, {waitUntil:'domcontentloaded'}).then(() => res._cdp.send('Page.resetNavigationHistory')).catch(doNothing),
                    res._cdp.send('Page.resetNavigationHistory').catch(doNothing),
                ])),
                new Promise(then => setTimeout(then, 10000)),
            ])
        await res._extPage.exposeFunction('gotObserverData', gotObserverData)
        await rlP, await pP
        res._lastStepEnd = performance.now()
    }
    async function step() {
        // Read, think, write.
        // Each agent takes f32 observations (to read) and predictions and actions (to write).
        // It returns a promise, which must resolve to `true`, else its loop will stop.
        try {
            if (res._closed) return
            relaunchIfNeeded()
            if (!res._agentInds.length) return

            // Don't schedule too many steps at once. If all die, end-of-step will schedule anyway.
            if (res._stepsNow < maxStepsNow)
                ++res._stepsNow, setTimeout(step, Math.max(0, +res._period * lowball))

            try {
                await res.read()

                const results = _allocArray(res._agentInds.length).fill()
                for (let i = 0; i < results.length; ++i)
                    try { results[i] = res._all[res._agentInds[i]].agent(...res._agentArgs[i]) }
                    catch (err) {} // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (results[i] instanceof Promise)
                        try { results[i] = await results[i] }
                        catch (err) { results[i] = undefined } // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (!results[i])
                        unlink.add(res._all[res._agentInds[i]])
                _allocArray(results)

                await res.write(res._actFloats)
            } catch (err) {
                if (!stall) console.error(err)
            } finally {
                // Unlink the agents that do not want to live on.
                if (unlink.size) {
                    let prevStall = stall;  stall = res.relink(res._all.filter(o => !unlink.has(o))), unlink.clear();  await prevStall
                    prevStall = stall;  stall = null;  await prevStall
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
                ++res._stepsNow, setTimeout(step, Math.max(0, +res._period * lowball))
        }
    }
    function _allocArray(a) {
        // _allocArray(length)⇒array; _allocArray(array) de-allocates it.
        // Don't make mistakes: double-free or use-after-free.
        if (!_allocArray.free) _allocArray.free = []
        if (typeof a == 'number' && a === a>>>0) { // Allocate.
            const arr = _allocArray.free.length ? _allocArray.free.pop() : []
            arr.length = a
            return arr
        }
        if (!Array.isArray(a)) throw new Error("Expected array length or an array")
        a.length = 0
        if (_allocArray.free.length > 100) return // Prevent madness.
        _allocArray.free.push(a)
    }
    function gotObserverData(b64) {
        // Yeah, sure, u16 per color per pixel is 2× the inefficiency. But. Audio.
        const obsBuf = Buffer.from(b64 || '', 'base64') // Int16; decode into floats.
        const obsLen = obsBuf.byteLength / Int16Array.BYTES_PER_ELEMENT | 0
        decodeInts(new Int16Array(obsBuf.buffer, obsBuf.byteOffset, obsLen), res._obsFloats)
    }
})
async function closeAllPagesExcept(browser, page) {
    const bad = browser.targets().filter(t => t.type() === 'page' && t !== page.target()).map(t => t.page())
    for (let p of bad) (await p).close().catch(doNothing)
}



exports.viewport = docs(`Sets viewport size on init.
Pass in a JS object with at least \`{ width:640, height:480 }\`, or nothing.
The same as https://pptr.dev/#?product=Puppeteer&version=v5.2.1&show=api-pagesetviewportviewport`, function viewport(opt = {}) {
    if (!opt || typeof opt != 'object') throw new Error('Not an object')
    if (opt.width == null) opt.width = 640
    if (opt.height == null) opt.height = 480
    return {
        env:null, boundsArgs:null, prevPage:null,
        async init(page, env) {
            // Resize browser window (for tab capture), and set viewport.
            if (env.width && env.width !== opt.width || env.height && env.height !== opt.height)
                throw new Error('Can only have one viewport')
            this.env = env
            env.width = opt.width
            env.height = opt.height
            const targetId = (await env._cdp.send('Target.getTargets')).targetInfos[0].targetId
            const windowId = (await env._cdp.send('Browser.getWindowForTarget', {targetId})).windowId
            await env._cdp.send('Browser.setWindowBounds', this.boundsArgs = {
                bounds: {
                    width: env.width + env._chromeWidth,
                    height: env.height + env._chromeHeight,
                },
                windowId,
            })
            return page.setViewport(opt)
        },
        read(page, state, obs) {
            if (this.prevPage !== page || Math.random() < .1)
                this.env._cdp.send('Browser.setWindowBounds', this.boundsArgs).catch(doNothing)
            this.prevPage = page
        },
    }
})



exports.const = docs(`\`webenv.const(value = 1, obsCount = 1, actCount = 0)\`
Tired of coding bias neurons?
Just create a constant input.
Also useful for not confusing agents when removing interfaces by not shifting others: \`webenv.const(value, interface)\`.
`, function(value = 1, obsCount = 1, actCount = 0) {
    if (typeof obsCount != 'number')
        actCount = obsCount.writes || 0, obsCount = obsCount.reads || 0
    return {
        reads: obsCount,
        read(page, state, obs) { obs.fill(value) },
        writes: actCount,
    }
})



exports.loopback = docs(`\`webenv.loopback(count = 1)\`
Writes the most recent action as its observation.
Agents might use this to compensate for latency.
`, function(count = 1) {
    let lastAct = null // No queue. Observation is always the most-recent action.
    return {
        reads: count,
        read(page, state, obs) { lastAct && obs.set(lastAct) },
        writes: count,
        write(page, state, pred, act) { lastAct = act },
    }
})



exports.image = docs(`Observations of the whole viewport; each pixel R/G/B is a number, -1..1.
Provide a mask color (0xRRGGBB) to mask exact matches, or \`null\` to disable that. Non-black-and-white masks may get distorted by video compression, and thus become unusable.
Slloooooooow.
`, function image(maskColor = 0xfafafa) {
    return {
        init(page, env) {
            this.width = env.width, this.height = env.height
            this.reads = this.width * this.height * 3
            return { width:this.width, height:this.height }
        },
        reads:'computed',
        observerInput(page, state) { return { w:this.width, h:this.height, mask:maskColor } },
        observer: function(input, video, audio, obs) {
            const d = video.grab(0, 0, input.w, input.h, input.w, input.h)
            const maskColor = input.mask
            // Normalize and write.
            for (let i = 0, from = 0, to = 0; to < obs.length; ) {
                const R = d[from++], G = d[from++], B = d[from++], A = d[from++]
                const masked = maskColor != null && ((R<<16) | (G<<8) | B) === maskColor
                obs[to++] = masked ? NaN : (2*R - 255) / 255
                obs[to++] = masked ? NaN : (2*G - 255) / 255
                obs[to++] = masked ? NaN : (2*B - 255) / 255
            }
        },
        visState(page, state) { return state },
        visualize:visualizePageScreenshot,
    }
})



function visualizePageScreenshot(obs, pred, elem, vState) {
    if (obs.length % 3) throw new Error('Bad length: ' + obs.length)
    if (!elem.firstChild) {
        const width = vState.width, height = vState.height
        const obsC = elem.appendChild(document.createElement('canvas'))
        obsC.width = width, obsC.height = height
        elem.obsCtx = obsC.getContext('2d', {desynchronized:false})
        elem.obsData = elem.obsCtx.createImageData(width, height)
        const predC = elem.appendChild(document.createElement('canvas'))
        predC.width = width, predC.height = height
        elem.predCtx = predC.getContext('2d', {desynchronized:false})
        elem.predData = elem.predCtx.createImageData(width, height)
    }
    let d = elem.obsData.data
    for (let from = 0, to = 0; to < d.length; from += 3) {
        d[to++] = toByte(obs[from+0], pred[from+0])
        d[to++] = toByte(obs[from+1], pred[from+1])
        d[to++] = toByte(obs[from+2], pred[from+2])
        d[to++] = 255
    }
    elem.obsCtx.putImageData(elem.obsData, 0, 0)
    d = elem.predData.data
    for (let from = 0, to = 0; to < d.length; ) {
        d[to++] = toByte(pred[from++])
        d[to++] = toByte(pred[from++])
        d[to++] = toByte(pred[from++])
        d[to++] = 255
    }
    elem.predCtx.putImageData(elem.predData, 0, 0)
    function toByte(x, nan = -1) {
        return Math.round(((x !== x ? nan : x) + 1) * (255/2))
    }
}



exports.imageRect = docs(`\`webenv.imageRect(width = 100, height = width, quantize = 1, maskColor = 0xfafafa)\`

Observations of a rect around the mouse; each pixel R/G/B is a number, -1..1.

The effective mouse position will be altered to have both coordinates divisible by \`quantize\`, to reduce drift.

Provide a mask color (0xRRGGBB) to mask exact matches, or \`null\` to disable that.

(A moving viewpoint acts as a crop of the image. And since web pages are typically consistent, this acts as the well-known augmentation for training visual models: two crops of the same image should have a very similar representation. No zooming like electromagnetic sensors in 3D environments get for free, though.)
`, function imageRect(width = 100, height = width, quantize = 1, maskColor = 0xfafafa) {
    let env
    return {
        reads: width * height * 3,
        init(page, e) { env = e },
        observerInput(page, state) {
            let x = page.mouseX || 0, y = page.mouseY || 0
            x -= x % quantize, y -= y % quantize
            return { x, y, w:width, h:height, mask:maskColor, maxW: env.width, maxH:env.height }
        },
        observer: function(input, video, audio, obs) {
            const x = input.x - ((input.w / 2) | 0), y = input.y - ((input.h / 2) | 0)
            const d = video.grab(x, y, input.w, input.h, input.maxW, input.maxH)
            const maskColor = input.mask
            // Normalize and write.
            for (let i = 0, from = 0, to = 0; to < obs.length; ++i) {
                const R = d[from++], G = d[from++], B = d[from++], A = d[from++]
                const masked = maskColor != null && ((R<<16) | (G<<8) | B) === maskColor
                obs[to++] = masked ? NaN : (2*R - 255) / 255
                obs[to++] = masked ? NaN : (2*G - 255) / 255
                obs[to++] = masked ? NaN : (2*B - 255) / 255
            }
        },
        visState(page, state) { return { width, height } },
        visualize:visualizePageScreenshot,
    }
})



exports.imageFovea = docs(`\`webenv.imageFovea(radius = 200, numPoints = 20000, quantize = 1, RNG = mulberry32(53299), density = x=>x*x*x, maskColor = 0xfafafa)\`

Observations around the mouse, the closer the more detail. Usually too blurry to make out text.

The effective mouse position will be altered to have both coordinates divisible by \`quantize\`, to reduce drift.

By default, the 0..1 random number generator is https://gist.github.com/tommyettinger/46a874533244883189143505d203312c.

Each pixel R/G/B is a number, -1..1.

Provide a mask color (0xRRGGBB) to mask exact matches, or \`null\` to disable that.
`, function imageFovea(radius = 200, numPoints = 20000, quantize = 1, RNG = mulberry32(53299), density = x=>x*x*x, maskColor = 0xfafafa) {
    const diam = 2*radius
    const points = getFoveatedCoords(radius, numPoints, RNG, density) // (x<<16) | y
    const closestPoint = invertFoveatedCoords(radius, points)
    let env
    return {
        reads: numPoints * 3,
        init(page, e) { env = e },
        observerInput(page, state) {
            let x = page.mouseX || 0, y = page.mouseY || 0
            x -= x % quantize, y -= y % quantize
            return { x, y, w:diam, h:diam, mask:maskColor, maxW: env.width, maxH: env.height }
        },
        observer: (''+function observeFovea(input, video, audio, obs) {
            if (!observeFovea.invert) { // Prepare data, if not prepared already.
                const p = observeFovea.invert = JSON.parse(INVERT_FOVEA)
                let max = 0
                for (let i = 0; i < p.length; ++i) max = Math.max(max, p[i])
                const numPoints = max + 1
                observeFovea.pointSum = new Float32Array(numPoints * 3)
                observeFovea.pointNum = new Int32Array(numPoints)
            }
            // Get image data.
            const x = input.x - (input.w / 2 | 0), y = input.y - (input.h / 2 | 0)
            const d = video.grab(x, y, input.w, input.h, input.maxW, input.maxH)
            const maskColor = input.mask
            const closestPoint = observeFovea.invert
            const pointSum = observeFovea.pointSum, pointNum = observeFovea.pointNum
            // Normalize, average, and write.
            pointSum.fill(0), pointNum.fill(0)
            for (let i = 0, from = 0; from < d.length; ++i) {
                const R = d[from++], G = d[from++], B = d[from++], A = d[from++]
                const to = closestPoint[i] * 3
                const masked = maskColor != null && ((R<<16) | (G<<8) | B) === maskColor ? 1 : 0
                pointSum[to+0] += masked ? NaN : (2*R - 255) / 255
                pointSum[to+1] += masked ? NaN : (2*G - 255) / 255
                pointSum[to+2] += masked ? NaN : (2*B - 255) / 255
                ++pointNum[closestPoint[i]]
            }
            for (let i = 0, to = 0; to < obs.length; ++i) {
                obs[to+0] = Math.max(-1, Math.min(pointSum[to+0] / pointNum[i], 1))
                obs[to+1] = Math.max(-1, Math.min(pointSum[to+1] / pointNum[i], 1))
                obs[to+2] = Math.max(-1, Math.min(pointSum[to+2] / pointNum[i], 1))
                to += 3
            }
        }).replace('INVERT_FOVEA', '`' + JSON.stringify(Array.from(closestPoint)) + '`'),
        visState(page, state) { return Array.from(closestPoint) },
        // JSON doesn't even transmit u32 data.
        // I made a better data format a few times, but it's easier to use built-ins.
        visualize:function visualizePageFovea(obs, pred, elem, closestPoint) {
            if (obs.length % 3) throw new Error('Bad length: ' + obs.length)
            const diam = Math.sqrt(closestPoint.length) | 0
            if (!elem.firstChild) {
                const obsC = elem.appendChild(document.createElement('canvas'))
                obsC.style.borderRadius = '50%'
                obsC.width = obsC.height = diam
                elem.obsCtx = obsC.getContext('2d', {desynchronized:false})
                elem.obsData = elem.obsCtx.createImageData(diam, diam)
                const predC = elem.appendChild(document.createElement('canvas'))
                predC.style.borderRadius = '50%'
                predC.width = predC.height = diam
                elem.predCtx = predC.getContext('2d', {desynchronized:false})
                elem.predData = elem.predCtx.createImageData(diam, diam)
            }
            let d = elem.obsData.data
            for (let j = 0, to = 0; to < d.length; ++j) {
                const i = closestPoint[j]*3
                d[to++] = toByte(obs[i+0], pred[i+0])
                d[to++] = toByte(obs[i+1], pred[i+1])
                d[to++] = toByte(obs[i+2], pred[i+2])
                d[to++] = 255
            }
            elem.obsCtx.putImageData(elem.obsData, 0, 0)
            d = elem.predData.data
            for (let j = 0, to = 0; to < d.length; ++j) {
                const i = closestPoint[j]*3
                d[to++] = toByte(pred[i+0])
                d[to++] = toByte(pred[i+1])
                d[to++] = toByte(pred[i+2])
                d[to++] = 255
            }
            elem.predCtx.putImageData(elem.predData, 0, 0)
            function toByte(x, nan = -1) {
                return Math.round(((x !== x ? nan : x) + 1) * (255/2))
            }
        },
    }
    function getFoveatedCoords(radius, numPoints, RNG, density) {
        if (numPoints > Math.PI * radius*radius / 2)
            throw new Error('More points than the radius can reasonably allow')
        const points = new Set
        while (points.size < numPoints) {
            const angle = RNG() * 2*Math.PI, distance = density(RNG()) * radius
            const x = (Math.cos(angle) * distance | 0) + radius
            const y = (Math.sin(angle) * distance | 0) + radius
            const hash = (x<<16) | y
            if (points.has(hash)) continue
            points.add(hash)
        }
        return [...points].sort()
    }
    function invertFoveatedCoords(radius, points) {
        // `image`, returned: from x+radius + 2*radius*(y+radius) to the index into `points`.
        // Here, we perform a BFS from points to fill the closest-point-to-here array properly.
        const diam = 2*radius
        const image = new Uint32Array(diam*diam)
        image.fill(points.length)
        const nextPos = []
        for (let i = 0; i < points.length; ++i) {
            const p = points[i], x = p >>> 16, y = p & 65535
            considerNeighbor(i, x, y)
        }
        for (let i = 0; i < nextPos.length; ++i) {
            const pos = nextPos[i]
            const x = pos % diam | 0, y = pos / diam | 0
            considerNeighbor(image[pos], x-1, y)
            considerNeighbor(image[pos], x+1, y)
            considerNeighbor(image[pos], x, y-1)
            considerNeighbor(image[pos], x, y+1)
        }
        function considerNeighbor(source, x, y) {
            if (x < 0 || x >= diam) return
            if (y < 0 || y >= diam) return
            const pos = x + diam*y
            if (image[pos] === points.length) image[pos] = source, nextPos.push(pos)
        }
        return image
    }
})
function mulberry32(a) {
    return function() {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}



exports.audio = docs(`\`webenv.audio(samples = 2048, sampleRate = 44100)\`
Observations of most-recent audio data, as \`samples\` interleaved-channel numbers in -1..1, \`sampleRate\` numbers per second per channel.
To calculate \`samples\`, divide \`sampleRate\` by the expected frames-per-second and multiply by how many channels there are (2), then round up to the nearest power-of-2.
`, function imageRect(samples = 2048, sampleRate = 44100) {
    return {
        reads: samples,
        observerInput(page, state) { return { samples, sampleRate } },
        observer: function(input, video, audio, obs) {
            // A copy, but this is small-time compared to `webenv.image(...)`.
            obs.set(audio.grab(input.samples, input.sampleRate))
        },
        visState(page, state) { return sampleRate },
        visualize:function(obs, pred, elem, vState) {
            let sumSqr = 0
            for (let i=0; i < obs.length; ++i) sumSqr += obs[i] * obs[i]
            elem.textContent = `Volume: ${(-20 * Math.log(1 / Math.sqrt(sumSqr))).toFixed(2)} dB`
            elem.style.fontFamily = 'monospace'
        },
    }
})



exports.webView = docs(`\`webenv.webView(port = 1234, httpsOptions = null, path = '')\`
Allows visualizing the observation streams as they are read, by opening \`localhost:1234/path\` or similar in a browser.
Optionally, specify key and certificate in \`httpsOptions\`: https://nodejs.org/en/knowledge/HTTP/servers/how-to-create-a-HTTPS-server/
To prevent others from seeing observations, use random characters as \`path\`.
`, function webView(port = 1234, httpsOptions = null, path = '') {
    const http = require('http'), https = require('https')
    const server = !httpsOptions ? (f => http.createServer(f)) : (f => https.createServer(httpsOptions, f))
    return {
        connections:[],
        server:null,
        end:0, interfaces:null,
        env:null,
        lastPred:null, // Not perfectly synchronized like a queue would be, but who cares. Sync requires copies anyway, so, too slow.
        init(page, env) {
            this.env = env
            if (!this.server) {
                this.server = server((req, res) => {
                    if (req.url === '/'+path) {
                        // Serve the base visualization page.
                        res.statusCode = 200
                        res.setHeader('Content-Type', 'text/html')
                        res.end(`<!DOCTYPE html><style>html>div{text-align:center}</style><script>${createBaseJS()}</script>`)
                    } else if (req.url === '/observations' + (path ? '/'+path : '')) {
                        // Remember to later send events to here whenever observations arrive.
                        this.connections.push(res)
                        res.on('close', () => this.connections.splice(this.connections.indexOf(res), -1))
                        res.writeHead(200, {
                            'Content-Type': 'text/event-stream',
                            'Cache-Control': 'no-cache',
                            Connection: 'keep-alive',
                        })
                        sendRelink.call(this, this.env._page, this.connections)
                    } else res.statusCode = 404
                })
                return new Promise(then => this.server.listen(port, then))
            }
        },
        deinit(page, state) {
            const server = this.server;  this.server = null
            return new Promise(then => server.close(then))
        },
        priority:-1,
        read(page, state, obs) {
            const to = this.connections
            if (!to.length) return
            if (this.interfaces !== this.env._all) {
                sendRelink.call(this, page, to)
                this.interfaces = this.env._all
            }
            sendObservation(obs, this.lastPred, to)
        },
        write(page, state, pred, act) {
            // Remember prediction to send later, unless it's all-zeros|NaN.
            if (!pred) return
            let empty = true
            for (let i = 0; i < pred.length; ++i)
                if (pred[i] === pred[i]) { empty = false;  break }
            this.lastPred = empty ? null : pred
        },
    }
    function sendRelink(page, to) {
        let end = 0
        for (let inter of this.env._all)
            if (typeof inter.reads == 'number')
                end += inter.reads
        const vis = createExtendJS(page, this.env._all, this.env._allState, end)
        to.forEach(res => res.write(`event:relink\ndata:${vis}\n\n`))
    }
    function sendObservation(obs, pred, to) {
        // 33% + 8 bytes of memory overhead per obs, due to base64 and Server-Sent Events.
        if (!(obs instanceof Observations)) throw new Error('Observation is not f32')
        if (pred && !(pred instanceof Observations)) throw new Error('Prediction is not f32')
        // Read all observations, not just ours.
        const obs64 = toLittleEndian(obs, Observations.BYTES_PER_ELEMENT).toString('base64')
        const pred64 = pred ? toLittleEndian(pred, Observations.BYTES_PER_ELEMENT).toString('base64') : ''
        const toWrite = `data:${obs64} ${pred64}\n\n`
        to.forEach(res => res.write(toWrite))
    }
    function createBaseJS() {
        // Receive & decode observation and prediction, then defer to currently-linked visualizers.
        const bpe = Observations.BYTES_PER_ELEMENT
        return `let state = null, root = document.documentElement.appendChild(document.createElement('div'))
const source = new EventSource('/observations${path ? '/'+path : ''}')
source.addEventListener('relink', function(evt) {
    while (root.lastChild) root.removeChild(root.lastChild)
    new Function('state', evt.data)(state = {}, root)
})
let knob = null
source.onmessage = function(evt) {
    if (!state) return
    Promise.resolve(evt.data).then(data => {
        const binary = data.split(' ').map(atob)
        binary[0] && decode(binary[0], state.OBS_BYTES)
        binary[1] && decode(binary[1], state.PRED_BYTES)
        state.VISUALIZE(state)
    })
}
function decode(str, into) {
    const end = Math.min(into.length * ${bpe}, str.length)
    if (endian() === 'LE')
        for (let i=0; i < end; ++i) into[i] = str.charCodeAt(i)
    else
        for (let i=0; i+${bpe-1} < end; i += ${bpe})
            ${new Array(bpe).fill().map((_,j) => `into[i+${j}] = str.charCodeAt(i+${bpe-j-1})`).join(', ')}
}
${endian}
`
    }
    function createExtendJS(page, inters, states, end) {
        // Return the function body, which accepts `state` and `root` to fill them.
        let n = 0
        const visInits = [], visualizers = []
        let start = 0
        const bpe = Observations.BYTES_PER_ELEMENT
        visInits.push(`state.OBS=new ${Observations.name}(${end})`)
        visInits.push(`state.OBS_BYTES=new Uint8Array(state.OBS.buffer, state.OBS.byteOffset, state.OBS.byteLength)`)
        visInits.push(`state.PRED=new ${Observations.name}(${end})`)
        visInits.push(`state.PRED_BYTES=new Uint8Array(state.PRED.buffer, state.PRED.byteOffset, state.PRED.byteLength)`)
        for (let i = 0; i < inters.length; ++i) {
            const inter = inters[i], state = states[i]
            if (typeof inter.reads == 'number') start += inter.reads
            if (typeof inter.visualize != 'function') continue
            const elem = 'state.v'+n++, vState = 'state.v'+n++
            const obs = 'state.v'+n++, pred = 'state.v'+n++, vis = 'state.v'+n++
            visInits.push(`${elem}=root.appendChild(document.createElement('div'))`)
            if (inter.visState !== undefined) {
                const f = inter.visState
                const v = JSON.stringify(typeof f == 'function' ? f.call(inter, page, state) : f)
                visInits.push(`${vState}=JSON.parse(\`${v.replace(/`/g, '``')}\`)`)
            } else visInits.push(`${vState}=undefined`)
            const r = inter.reads || 0, realStart = start - r
            visInits.push(`${obs}=new ${Observations.name}(state.OBS.buffer, state.OBS.byteOffset + ${realStart*bpe}, ${r})`)
            visInits.push(`${pred}=new ${Observations.name}(state.PRED.buffer, state.PRED.byteOffset + ${realStart*bpe}, ${r})`)
            visInits.push(`${vis}=${inter.visualize}`)
            visualizers.push(`${vis}(${obs},${pred},${elem},${vState})`)
        }
        visInits.push(`state.VISUALIZE = function(state) { ${visualizers.join('\n')} }`)
        return visInits.join('\n').replace(/\n/g, '\ndata:')
    }
    function toLittleEndian(f32, bpe) {
        // Different processors can have different endian-ness (byte-order). This func allows ensuring that parses/serializations with different byte-orders arrive at the same values.
        if (endian() === 'LE') return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
        f32 = f32.slice()
        return swapBytes(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), bpe)
    }
})
function endian() {
    return endian.cache || (endian.cache = (new Uint8Array(new Uint16Array([1]).buffer))[0] === 1 ? 'LE' : 'BE')
}
function swapBytes(buf, bpe = 4) {
    if (bpe === 8) buf.swap64()
    else if (bpe === 4) buf.swap32()
    else if (bpe === 2) buf.swap16()
    return buf
}



exports.io = docs(`\`webenv.io(intSize = 0)\`
Makes the actual agent reside in another process, connected through standard IO. (Useful for isolation and parallelization.)

Communication protocol details:
- Specify \`intSize\` to decrease precision and increase throughput: \`0\` if all values use float32, \`1\` if int8, \`2\` if int16.
    - To decode int8, \`v = x === -128 ? NaN : v / 127\`.
    - To encode int8, \`x = v !== v ? -128 : round(clamp(v, -1, 1) * 127)\`.
    - To decode int16, \`v = x === -65536 ? NaN : x / 32767\`.
    - To encode int16, \`x = v !== v ? -65536 : round(clamp(v, -1, 1) * 32767)\`.
- Here, "environment" means this process, "agent" means the controlling process that receives its observations and feeds it (predictions and) actions.
- At init, the agent sends the magic u32 number \`0x01020304\`.
    - (This allows the environment to perform all endianness conversions, simplifying the agent.)
- Loop:
    - The agent receives:
        - u32 observation length,
        - then observation (that many values),
        - then u32 expected action length.
    - (The agent schedules a computation, which goes from observations to actions.)
        - (The agent should replace NaN observations with its own predictions of them. This is in-agent for differentiability.)
    - The agent sends:
        - u32 prediction length (feel free to make this 0, which would disable its visualization),
        - then observation prediction (that many values),
        - then u32 action length,
        - then the action (that many values),
        - then flushes buffers to ensure sending.
        (Do not worry about matching requested lengths exactly, focus on throughput.)
        (Non-specified values are NaN, or 0 where NaN does not make sense.)
`, function io(intSize = 0) {
    if (intSize !== 0 && intSize !== 1 && intSize !== 2) throw new Error('Bad intSize')
    const cons = intSize === 0 ? Float32Array : intSize === 1 ? Int8Array : Int16Array
    const thens = [], reqs = []
    let writeLock = null, readLock = null, initialized = false
    function onDrain() {
        thens.forEach(f => f()), thens.length = 0
    }
    function onReadable() {
        while (reqs.length) { // [..., len, then, ...]
            const chunk = process.stdin.read(reqs[0])
            if (!chunk) return
            reqs.splice(0,2)[1](chunk)
        }
    }
    function readBytes(len) { // len>0
        if (len <= 0) throw 'no'
        return new Promise(resolve => {
            reqs.push(len, resolve), onReadable()
        })
    }
    return {
        obsCoded: new cons(0),
        async init(page, env) {
            if (initialized) return // STDIO is once per process.
            process.stdin.on('readable', onReadable)
            const magic = (await readFromStream(readBytes, 1, Uint32Array, false))[0]
            if (magic === 0x01020304)
                this.byteswap = false
            else if (magic === 0x04030201)
                this.byteswap = true
            else
                throw new Error('Bad magic number:', magic)
            process.stdout.on('drain', onDrain)
            initialized = true
        },
        async agent(obs, pred, act) {
            // Write observation, atomically.
            if (!initialized) return true
            const bs = this.byteswap
            let oldW = writeLock, thenW;
            writeLock = new Promise(f => thenW=f);  await oldW
            const to = process.stdout
            await writeArray(to, this.obsCoded = encodeInts(obs, this.obsCoded), bs)
            await writeToStream(to, act.length, bs, thens)
            thenW()
            // Read prediction then action, atomically.
            let oldR = readLock, thenR;
            readLock = new Promise(f => thenR=f);  await oldR
            const predData = await readArray(cons, bs)
            const actData = await readArray(cons, bs)
            decodeInts(predData, pred), decodeInts(actData, act)
            thenR()
            return true
        },
    }
    async function writeArray(stream, data, byteswap = false) {
        // Length then data.
        await writeToStream(stream, data.length, byteswap, thens)
        await writeToStream(stream, data, byteswap, thens)
    }
    async function readArray(format, byteswap = false) {
        // Length then data.
        const len = (await readFromStream(readBytes, 1, Uint32Array, byteswap))[0]
        const data = await readFromStream(readBytes, len, format, byteswap)
        return data
    }
})
function encodeInts(d, into) {
    // -1…1|NaN floats to i8/i16.
    // This can return a different object as `into` to resize; store it.
    if (into === null || into instanceof Float32Array) return d
    if (!(d instanceof Float32Array)) throw new Error('Not floats')
    const intSize = into instanceof Int8Array ? 1 : into instanceof Int16Array ? 2 : null
    if (intSize === null) throw new Error('Unrecognized int format')
    if (into.length !== d.length) // Resize.
        into = new into.constructor(d.length)
    const scale = 2 ** (intSize * 8 - 1) - 1, masked = -(2 ** (intSize * 8 - 1))
    const end = Math.min(d.length, into.length)
    for (let i = 0; i < end; ++i) // Encode.
        into[i] = d[i] !== d[i] ? masked : Math.round(Math.max(-1, Math.min(d[i], 1)) * scale)
    return into
}
function decodeInts(d, into) {
    // i8/i16 to -1…1|NaN floats.
    // On size mismatch, this only writes the beginning.
    if (!(into instanceof Float32Array)) throw new Error('Not floats')
    if (d instanceof Float32Array) return overwriteArray(into, d)
    const intSize = d instanceof Int8Array ? 1 : d instanceof Int16Array ? 2 : null
    if (intSize === null) throw new Error('Unrecognized int format: ' + d.constructor.name)
    const scale = 2 ** (intSize * 8 - 1) - 1, masked = -(2 ** (intSize * 8 - 1))
    const end = Math.min(d.length, into.length)
    for (let i = 0; i < end; ++i) // Decode.
        into[i] = d[i] === masked ? NaN : d[i] / scale
    if (d.length < into.length) into.fill(NaN, d.length)
}
function overwriteArray(arr, next) {
    // This doesn't sweat size differences, not touching numbers at the end.
    if (!next) return
    if (next.length <= arr.length)
        arr.set(next)
    else
        arr.set(new arr.constructor(next.buffer, next.byteOffset, arr.length))
}
function writeToStream(stream, data, byteswap = false, thens) {
    if (typeof data == 'number') data = new Uint32Array([data])
    if (byteswap) data = data.slice()
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    byteswap && swapBytes(buf, data.constructor.BYTES_PER_ELEMENT)
    stream.cork()
    process.nextTick(() => stream.uncork())
    if (!stream.write(buf) && thens) // If wrote too much, wait until the stream is drained.
        return new Promise(then => thens.push(then))
}
async function readFromStream(readBytes, len, Format = Float32Array, byteswap = false) {
    // Returns either a Buffer or a Promise of it, for convenience.
    if (!len) return new Format(0)
    const buf = await readBytes(len * Format.BYTES_PER_ELEMENT)
    if (!buf || buf.length < len * Format.BYTES_PER_ELEMENT)
        throw new Error('Unexpected end-of-stream')
    byteswap && swapBytes(buf, Format.BYTES_PER_ELEMENT)
    return new Format(buf.buffer, buf.byteOffset, len)
}



exports.directLink = docs(`\`webwenv.directLink(name = 'directLink', maxReads = 1*2**20, maxWrites = 1*2**20, maxLinks = 1024)\`
Allows web pages to dynamically establish a high-bandwidth connection, via calling \`directLink\`.
    (Abusing this feature will cause agents to get very confused, as they have no way to know about format changes apart from prediction.)

In a page, \`directLink(PageAgent, Inputs = 0, Outputs = 0)\` will return (a promise of) \`true\` if successfully established, else \`false\`.
\`PageAgent\` will be called automatically, until it returns a non-\`true\` value.
\`PageAgent(Act, Obs)\` synchronously reads \`Act\` (of length \`Inputs\`) and writes to \`Obs\` (of length \`Outputs\`). All values are 32-bit floats, \`-1\`…\`1\` or \`NaN\`.
    (Access to observation predictions is forbidden.)

(The closest analogue of a real-time data channel that has equal read and write capabilities for humans is music, which can be used to capture and convey the neural feel of arbitrary neural computations. Research music 2.0, preferably if you have a direct neural link device.)
`, function directLink(name = 'directLink', maxReads = 1*1024*1024, maxWrites = 1*1024*1024, maxLinks = 1024) {
    // Data communication is not quite as optimized as it could be,
    //   since this sends/receives float32 instead of int16.
    return {
        init(page, env) {
            page.evaluateOnNewDocument((name, maxReads, maxWrites, maxLinks) => {
                const agents = {}
                let reads = 0, writes = 0
                self[name] = directLink
                directLink.evalAgent = (agentId, act, actBuf, obsBuf, toBinaryString, fromBinaryString) => {
                    fromBinaryString(atob(act), actBuf)
                    let result
                    try { result = agents[agentId].call(null, actBuf, obsBuf) }
                    catch (err) { document.body.append(err.message, document.createElement('br'), err.stack) }
                    if (result !== true) return delete agents[agentId], null
                    return btoa(toBinaryString(obsBuf))
                }
                function directLink(agent, ins = 0, outs = 0) {
                    if (typeof agent != 'function') throw new Error('Not a func')
                    if (typeof ins != 'number' || typeof outs != 'number')
                        throw new Error('Not a number')
                    if (reads + outs > maxReads) throw new Error('Too many reads')
                    if (writes + ins > maxWrites) throw new Error('Too many writes')
                    if (agents.length + 1 > maxLinks) throw new Error('Too many direct links')
                    let id = 0
                    while (agents[id]) ++id
                    agents[id] = agent, reads += outs, writes += ins
                    _directLinkRegister(id, ins, outs)
                    return true
                }
            }, name, maxReads, maxWrites, maxLinks)
            let agentCount = 0, reads = 0, writes = 0
            return page.exposeFunction('_directLinkRegister', async (agentId, ins = 0, outs = 0) => {
                if (typeof agentId != 'number') return false
                if (typeof ins != 'number' || typeof outs != 'number') return false
                if (reads + outs > maxReads) return false
                if (writes + ins > maxWrites) return false
                if (agentCount + 1 > maxLinks) return false
                ++agentCount, reads += outs, writes += ins
                let continues = true, initialized = false
                const doHandle = await page.evaluateHandle(name => self[name].evalAgent, name)
                const actHandle = await page.evaluateHandle(sz => new Float32Array(sz), ins)
                const obsHandle = await page.evaluateHandle(sz => new Float32Array(sz), outs)
                const toBinaryStringHandle = await page.evaluateHandle('('+toBinaryString+')')
                const fromBinaryStringHandle = await page.evaluateHandle('('+fromBinaryString+')')
                await env.relink(env._all, {
                    queue:[], // This can't be a real word.
                    priority:-1000,
                    reads:outs,
                    writes:ins,
                    init(page, env) { initialized && (continues = false), initialized = true },
                    async read(page, state, obs) {
                        if (!continues) return
                        if (!this.queue.length) return
                        const obsSource = this.queue.shift()
                        overwriteArray(obs, obsSource)
                    },
                    agent(obs, pred, act) { return continues },
                    async write(page, state, pred, act) {
                        if (env._page !== page) continues = false
                        if (!continues) return
                        if (page.isClosed()) return
                        // Call the page-agent with our action, to get observation.
                        const actBase64 = Buffer.from(act.buffer, act.byteOffset, act.byteLength).toString('base64')
                        let result
                        try {
                            result = await page.evaluate((f, ...a) => f(...a), doHandle, agentId, actBase64, actHandle, obsHandle, toBinaryStringHandle, fromBinaryStringHandle)
                        } catch (err) {}
                        if (typeof result != 'string')
                            return continues = false
                        const obsBuf = Buffer.from(result, 'base64')
                        const obs = new Observations(obsBuf.buffer, obsBuf.byteOffset, obsBuf.byteLength / Observations.BYTES_PER_ELEMENT | 0)
                        for (let i = 0; i < obs.length; ++i)
                            obs[i] = obs[i] !== obs[i] ? NaN : Math.max(-1, Math.min(obs[i], 1))
                        this.queue.push(obs)
                    },
                    deinit(page, state) {
                        if (!continues) return
                        try {
                            doHandle.dispose()
                            actHandle.dispose()
                            obsHandle.dispose()
                            toBinaryStringHandle.dispose()
                            fromBinaryStringHandle.dispose()
                        } catch (err) {}
                        this.queue.length = 0
                    },
                })
                return true
            })
        },
    }
    // We communicate via base64, to deal with JSON de/serialization.
    // No endianness conversions, because it's all on the same processor.
    function toBinaryString(buf) {
        // A Blob is faster than this, for big enough strings.
        if (!(buf instanceof Uint8Array))
            buf = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        const tmp = toBinaryString.tmp || (toBinaryString.tmp = [])
        tmp.length = buf.length
        for (let i = 0; i < buf.length; ++i)
            tmp[i] = String.fromCharCode(buf[i])
        return tmp.join('')
    }
    function fromBinaryString(str, into) {
        const Format = into.constructor
        const buf = Format === Uint8Array ? into : new Uint8Array(into.buffer, into.byteOffset, into.byteLength)
        if (str.length !== buf.length) throw new Error('Buffer and binary-string lengths mismatch')
        for (let i = 0; i < buf.length; ++i)
            buf[i] = str.charCodeAt(i)
        if (Format === Uint8Array) return buf
        return new Format(buf.buffer, buf.byteOffset, buf.length / Format.BYTES_PER_ELEMENT | 0)
    }
})



exports.randomAgent = docs(`\`webenv.randomAgent(relative = 0)\`
Simply puts random -1..1 floats as actions on each step, for testing.
If \`relative\` is not \`0\`, the agent meanders its action instead of jumping constantly.
`, function(relative = 0) {
    const orders = 3
    const derivatives = []
    return {
        priority:1,
        agent(obs, pred, act) { return true },
        write(page, state, pred, act) {
            if (!relative)
                for (let i = 0; i < act.length; ++i)
                    act[i] = Math.random()*2-1
            else
                for (let i = 0; i < act.length; ++i)
                    act[i] = relativeStep(act[i], i)
            return true
        },
    }
    function relativeStep(x, i) {
        if (derivatives.length < i) derivatives.length = i
        const d = derivatives[i] || (derivatives[i] = [])
        d[0] = x
        const order = Math.random() * orders | 0
        d[order] = (d[order] + (Math.random()*2-1)*relative) * .9
        if (Math.random() < 1/derivatives.length) d[order] = Math.random()*2-1
        for (let j = orders; j >= 2; --j) {
            let speed = d[j-1] || 0, pos = (d[j-2] || 0) + speed
            if (pos < -1 && speed < 0) speed = -speed/2, pos = -1
            if (pos > 1 && speed > 0) speed = -speed/2, pos = 1
            d[j-1] = speed, d[j-2] = pos
        }
        return d[0]
    }
})



exports.scrollBy = docs(`\`webenv.scrollBy(sensitivity = 100)\`
Exposes 2 actions, which add to viewport scroll position (in pixels).
`, function(sensitivity = 100) {
    return {
        writes:2,
        write(page, state, pred, act) {
            if (page.isClosed()) return
            const dx = sensitivity * Math.max(-1, Math.min(act[0], 1))
            const dy = sensitivity * Math.max(-1, Math.min(act[1], 1))
            page.evaluate((dx, dy) => scrollBy(dx, dy), dx, dy).catch(doNothing)
        },
    }
})



exports.interval = docs(`\`webenv.interval(func, ms = 60000)\`
Runs a func on an interval, with page and env as args (for example, use \`webenv.triggers.homepage\`, especially if that opens a random page).
`, function(func, ms = 60000) {
    let id = null
    return {
        init(page, env) { clearInterval(id), id = setInterval(func, ms, page, env) },
        deinit(page, state) { clearInterval(id), id = null },
    }
})



exports.triggers = docs(`\`webenv.triggers([...start], [...stop], { threshold=.5, resetOnNewPage=true, maxAtOnce=0, cooldown=0, priority=0 })\`
Exposes a group of triggers, such as keys on a keyboard.
For example: \`webenv.triggers([page => page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ')], null, { maxAtOnce:1, cooldown:600 })\` (the cooldown is in frames)
`, function(start, stop, opt) {
    if (!Array.isArray(start) || stop && (!Array.isArray(stop) || start.length !== stop.length))
        throw new Error('Bad start/end triggers')
    const triggers = start.length
    const threshold = get(opt, 'threshold', .5)
    const resetOnNewPage = get(opt, 'resetOnNewPage', true)
    const maxAtOnce = get(opt, 'maxAtOnce', 0)
    const cooldown = get(opt, 'cooldown', 0)
    const prev = new Uint8Array(triggers)
    const next = new Uint8Array(triggers)
    const sorted = new Observations(triggers)
    const framesUntilReady = new Uint8Array(maxAtOnce || triggers)
    return {
        init(page, env) {
            this.env = env
            if (!resetOnNewPage) return
            page.on('framenavigated', frame => frame === page.mainFrame() && prev.fill(0))
            page.on('domcontentloaded', () => prev.fill(0))
        },
        priority: typeof opt.priority == 'number' ? opt.priority : 0,
        writes:triggers,
        write(page, state, pred, act) {
            if (page.isClosed()) return
            let oldThreshold = threshold, oldMax = maxAtOnce || triggers
            let newThreshold = threshold, newMax = maxAtOnce || triggers
            // Disallow new triggers when we don't have enough cooled-down slots.
            if (cooldown) {
                let free = 0
                for (let j = 0; j < framesUntilReady.length; ++j)
                    if (framesUntilReady[j] === 0) ++free
                newMax = Math.min(newMax, free)
            }
            // Handle `maxAtOnce`.
            if (oldMax < triggers || newMax < triggers) {
                sorted.set(act), sorted.sort()
                oldThreshold = Math.max(oldThreshold, oldMax ? sorted[sorted.length - oldMax] : Infinity)
                newThreshold = Math.max(newThreshold, newMax ? sorted[sorted.length - newMax] : Infinity)
            }
            // Read what is triggered.
            if (oldMax > 0)
                for (let i = 0; i < triggers; ++i)
                    next[i] = act[i] >= (prev[i] ? oldThreshold : newThreshold) ? 1 : 0
            else
                next.fill(0)
            // Allocate new triggers, and cooldown.
            if (cooldown) {
                let newTriggers = 0
                for (let i = 0; i < triggers; ++i)
                    if (!prev[i] && next[i]) ++newTriggers
                for (let j = 0; j < framesUntilReady.length; ++j)
                    if (framesUntilReady[j] === 0)
                        newTriggers && (framesUntilReady[j] = cooldown, --newTriggers)
                    else --framesUntilReady[j]
            }
            // Un/trigger.
            for (let i = 0; i < triggers; ++i)
                if (!prev[i] && next[i]) start[i](page, this.env)
                else if (stop && prev[i] && !next[i]) stop[i](page, this.env)
            prev.set(next)
        },
    }
    function get(obj, at, def) { return obj && obj[at] !== undefined ? obj[at] : def }
})



exports.triggers.homepage = docs(`\`webenv.triggers([webenv.triggers.homepage])\`
Back to homepage, please.
`, function(page, env) {
    page.mouseX = env.width/2 | 0, page.mouseY = env.height/2 | 0
    return page.goto(env.homepage, {waitUntil:'domcontentloaded'}).catch(doNothing)
})



exports.triggers.goBack = docs(`\`webenv.triggers([webenv.triggers.goBack])\`
Back to the previous page, please.
`, function(page, env) { return page.goBack().catch(doNothing) })



exports.triggers.randomLink = docs(`\`webenv.triggers([webenv.triggers.randomLink])\`
Picks a random file: or http: or https: link on the current page, and follows it.
`, async function(page, env) {
    let place = page.url(), i = place.lastIndexOf('#')
    if (i >= 0) place = place.slice(0, i) // `URL#ID` → `URL`
    const selector = 'a'
    let urls
    try { urls = await page.$$eval(selector, links => links.map(a => a.href)) }
    catch (err) { return }
    urls = urls.filter(u => {
        if (u.slice(0, place.length) === place && u[place.length] === '#') return false
        if (u.slice(0,7) === 'file://') return true
        if (u.slice(0,7) === 'http://') return true
        if (u.slice(0,8) === 'https://') return true
        // Relative links are already resolved by .href.
    })
    if (!urls.length) return
    const url = urls[Math.random() * urls.length | 0]
    return page.goto(url, {waitUntil:'domcontentloaded'}).catch(doNothing)
})



exports.triggers.randomInCache = docs(`\`webenv.triggers([webenv.triggers.randomInCache])\`
Navigates to a random previously-visited URL (most of the time), which is preserved in cache.
Must only be used with \`webenv.filter\`, with a string \`cache\` path.

(This is a very open-ended action. If the agent's loss averages outcomes, then predictions with this trigger would be quite gray and nonsensical; make sure to maximize plausibility instead, so particular outcomes don't get penalized.)
`, async function(page, env) {
    if (typeof page.cache !== 'string') throw new Error('But there is no .cache')
    const maxAttempts = 32 // Why maintain a separate main-URL index when you can just retry.
    const fs = require('fs/promises'), path = require('path')
    const navs = new Array(maxAttempts).fill(page.cache).map(getRandomNav)
    for (let nav of navs)
        if (nav = await nav)
            return page.goto(nav, {waitUntil:'domcontentloaded'}).catch(doNothing)
    async function getRandomNav(name) {
        // Return a random URL deeply in `name` (assumed to be a `webenv.filter` cache),
        //   or `null` if not found.
        // Luckily, `webenv.filter`'s cache leaves navigation URLs around, just for us.
        const names = await fs.readdir(name)
        if (names.indexOf('HEAD') >= 0 && names.indexOf('BODY') >= 0) {
            if (names.indexOf('NAV') >= 0)
                try { return await fs.readFile(path.join(name, 'NAV'), { encoding:'utf8', flag:'r' }) }
                catch (err) { return null }
            return null
        }
        if (!names.length) return
        const picked = names[Math.floor(Math.random() * names.length)]
        return getRandomNav(path.join(name, picked))
        // The FS API forces a quadratic-time path-constructing algorithm on us.
        //   Sure hope no one creates outrageously deep URLs.
    }
})



exports.keyboard = docs(`\`webenv.keyboard(Options={maxAtOnce:3}, Keys='...')\`
Exposes the keyboard as actions. https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values
For more details on \`Options\`, see \`webenv.triggers\`.
\`Keys\` is a space-separated string of keys or \`'Spacebar'\`. (Shift does not modify keys, so, with-Shift versions have to be manually included.)
`, function(opt = {maxAtOnce:3}, kb = 'Alt Control Shift Enter Tab Spacebar ArrowDown ArrowLeft ArrowRight ArrowUp End Home PageDown PageUp Backspace Delete Escape ` ~ 1 2 3 4 5 6 7 8 9 0 ! @ # $ % ^ & * ( ) q w e r t y u i o p [ ] \\ a s d f g h j k l ; \' z x c v b n m , . / Q W E R T Y U I O P { } | A S D F G H J K L : " Z X C V B N M < > ?') {
    const keys = kb.split(' ').map(k => k === 'Spacebar' ? ' ' : k)
    return exports.triggers(
        keys.map(k => page => page.keyboard.down(k, k.length > 1 ? undefined : {text:k}).catch(doNothing)),
        keys.map(k => page => page.keyboard.up(k).catch(doNothing)),
        opt
    )
})



exports.mouse = docs(`\`webenv.mouse(Options)\`
Exposes all mouse-related actions.
\`Options\` is, by default, \`{ left=true, right=false, middle=false, wheel=0, absolute=true, relative=0 }\`.
    \`relative\` specifies the max fraction of screen-space that one action can move the mouse by.
    \`wheel\` specifies the max CSS pixels for one action.

(Neural networks have trouble distinguishing per-pixel differences in page offsets, so a non-learned loss makes predictions very blurry, even when the RNN has settled into a point-like attractor.)
`, function(opt = {}) {
    const start = [], stop = [], inters = []
    if (opt.wheel && typeof opt.wheel == 'number') {
        const sensitivity = opt.wheel
        inters.push({
            writes:2,
            write(page, state, pred, act) {
                if (page.isClosed()) return
                const dx = Math.max(-1, Math.min(act[0], 1)) * sensitivity
                const dy = Math.max(-1, Math.min(act[1], 1)) * sensitivity
                page.mouse.wheel({ deltaX:dx, deltaY:dy }).catch(doNothing)
            },
        })
    }
    if (opt.absolute !== false)
        inters.push({
            init(page, env) {
                this.env = env, page.mouseX = env.width/2 | 0, page.mouseY = env.height/2 | 0
            },
            writes:2,
            write(page, state, pred, act) {
                if (page.isClosed()) return
                const width = this.env.width, height = this.env.height
                const ax = Math.max(-1, Math.min(act[0], 1))
                const ay = Math.max(-1, Math.min(act[1], 1))
                page.mouseX = (ax + 1) * .5 * (width-1) | 0
                page.mouseY = (ay + 1) * .5 * (height-1) | 0
                page.mouse.move(page.mouseX, page.mouseY).catch(doNothing)
            },
        })
    if (opt.relative && typeof opt.relative == 'number') {
        const sensitivity = opt.relative
        inters.push({
            init(page, env) {
                this.env = env, page.mouseX = env.width/2 | 0, page.mouseY = env.height/2 | 0
            },
            writes:2,
            write(page, state, pred, act) {
                if (page.isClosed()) return
                const width = this.env.width, height = this.env.height
                const ax = Math.max(-1, Math.min(act[0], 1))
                const ay = Math.max(-1, Math.min(act[1], 1))
                page.mouseX = Math.max(0, Math.min(page.mouseX + sensitivity * ax, width-1)) | 0
                page.mouseY = Math.max(0, Math.min(page.mouseY + sensitivity * ay, height-1)) | 0
                page.mouse.move(page.mouseX, page.mouseY).catch(doNothing).catch(doNothing)
            },
        })
    }
    let curButtons = 0
    if (opt.left !== false)
        start.push((page, env) => mouseButton(env, 1, true)),
        stop.push((page, env) => mouseButton(env, 1, false))
    if (opt.right === true)
        start.push((page, env) => mouseButton(env, 2, true)),
        stop.push((page, env) => mouseButton(env, 2, false))
    if (opt.middle === true)
        start.push((page, env) => mouseButton(env, 4, true)),
        stop.push((page, env) => mouseButton(env, 4, false))
    if (start.length) inters.push(exports.triggers(start, stop, {...opt, priority:-2}))
    return inters
    function mouseButton(env, button, pressed) {
        // `page.mouse.down(...)`/`.up(...)` have proven unreliable, so, CDP.
        if (pressed) curButtons |= button
        env._cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: env._page.mouseX,
            y: env._page.mouseY,
            button: button===1 ? 'left' : button===2 ? 'right' : button===4 ? 'middle' : 'none',
            buttons: curButtons,
            clickCount: 1,
        }).catch(doNothing)
        if (!pressed) curButtons &= ~button
    }
})



exports.frameTime = docs(`\`webenv.frameTime(fps = 20, maxMs = 1000)\`
Provides an observation of the time between frames, relative to the expected-Frames-Per-Second duration, in (less-than-1) multiples of \`maxMs\`.
`, function(fps = 20, maxMs = 1000) {
    const performance = require('perf_hooks').performance
    let prevFrame = performance.now()
    return {
        reads:1,
        read(page, state, obs) {
            const nextFrame = performance.now()
            const duration = (nextFrame - prevFrame) - 1 / fps
            obs[0] = Math.max(-1, Math.min(duration / maxMs, 1))
            prevFrame = nextFrame
        },
        visState(page, state) { return { fps, maxMs, runningAvg:null } },
        visualize:function(obs, pred, elem, vState) {
            if (!elem.firstChild) {
                elem.appendChild(document.createElement('div'))
                elem.firstChild.style.width = '1.2em'
                elem.firstChild.style.height = '1.2em'
                elem.firstChild.style.borderRadius = '50%'
                elem.firstChild.style.display = 'inline-block'
                elem.appendChild(document.createElement('div'))
                elem.lastChild.style.fontFamily = 'monospace,monospace'
                elem.frame = false
            }
            const frames = obs[0] * vState.maxMs + 1 / vState.fps
            if (vState.runningAvg == null) vState.runningAvg = frames
            vState.runningAvg = .95 * vState.runningAvg + (1-.95) * frames
            elem.firstChild.style.backgroundColor = (elem.frame = !elem.frame) ? 'lightgray' : 'darkgray'
            elem.lastChild.textContent = (1000 / vState.runningAvg).toFixed(1) + ' FPS'
        },
    }
})



exports.fps = docs(`\`webenv.fps(fps = 30)\`
Replaces real time with virtual time, for semi-consistent time-per-frame.
This does not change video playback speed, but does control when JS timeouts fire.
`, function(fps = 30) {
    const budget = 1000 / fps
    let prevFrame = null, prevThen = null
    function resolveFrame() {
        const then = prevThen;  prevFrame = prevThen = null, then && then()
    }
    return {
        init(page, env) {
            env._cdp.on('Emulation.virtualTimeBudgetExpired', resolveFrame)
            return env._cdp
        },
        deinit(page, state) {
            state.off('Emulation.virtualTimeBudgetExpired', resolveFrame)
        },
        async read(page, state, obs) {
            if (prevFrame) await prevFrame // Break pipelining if frames are taking too long.
            state.send('Emulation.setVirtualTimePolicy', {
                policy:'advance', budget
            }).catch(doNothing)
            return prevFrame = new Promise(then => prevThen = then)
        },
    }
})



exports.filter = docs(`\`webenv.filter(allowURL = ..., cache = null, maxCacheSize = 30 * 2**30)\`
Intercepts requests, allowing to disallow some URLs and to cache.
Example: \`webenv.filter(null, 'cached')\`

==========
Arguments:
- \`allowURL\`: Either \`null\` or a regular expression or a function from URL and request object and the Puppeteer page to either \`null\` (to disallow) or an object (to allow); see https://pptr.dev/#?product=Puppeteer&version=v5.2.1&show=api-httprequestcontinueoverrides
    (By default, this disallows file: URLs unless they read the same directory as the current file: URL, for safety.)
    \`robots.txt\` is ignored.
- \`cache\`: If a string, this is the name of the directory that most successful GET HTTP/S requests will end up in. If a function, takes request and the \`allowURL\` object, and handles caching and responding.
    (For when the default browser cache is not aggressive enough.)
- \`maxCacheSize\`: if \`cache\` is a string, this is the max cache size (compressed).
    (30GB by default.)
    (The eviction policy is very simple: a random origin is deleted until the size is good.)
`, function(allowURL = null, cache = null, maxCacheSize = 30*1024*1024*1024) {
    if (allowURL === null) {
        allowURL = (url, req, page) => {
            if (page.isClosed()) return
            if (req.isNavigationRequest()) return {url}
            const cur = page.url()
            const curFile = cur.slice(0,7) === 'file://', needFile = url.slice(0,7) === 'file://'
            if (!curFile) return needFile ? undefined : {url}
            if (!needFile) return {url}
            if (url.indexOf('..') >= 0) return
            const dir = cur.slice(0, cur.lastIndexOf('/'))
            if (url.slice(0, dir.length) === dir) return {url}
        }
    }
    let cacheFunc
    if (typeof cache == 'string') {
        if (!cache) throw new Error('Please specify a directory to put cache into')
        const path = require('path'), fs = require('fs/promises')
        const http = require('http'), https = require('https')
        const zlib = require('zlib')
        let curCacheSize = bytesInDirectory(cache)
        const maxEntrySize = maxCacheSize / 100 | 0 // Each entry must be no more than 1%.
        cacheFunc = async function(req, overrides) {
            if (req.method().toUpperCase() !== 'GET')
                return req.continue(overrides)
            if (!/document|stylesheet|image|font|script|texttrack|manifest/g.test(req.resourceType()))
                // Allow non-resource GET requests, non-cached.
                //   Circumventable by pages, but this is a cache, not a sandbox.
                return req.continue(overrides)
            const url = overrides.url
            if (url.slice(0,7) !== 'http://' && url.slice(0,8) !== 'https://')
                return req.continue(overrides)
            const parts = url.slice(url.indexOf('://')+3).toLowerCase().split('/')
            const dirpath = [cache, ...parts.map(s => encodeURIComponent(s).replace(/\*/g, '%2A')).filter(x => x)]
            const filepath = path.join(...dirpath, 'BODY')
            const headpath = path.join(...dirpath, 'HEAD')
            const navpath = path.join(...dirpath, 'NAV')
            try {
                // Read & return the cached body.
                const content = await decompress(await fs.readFile(filepath, { flag:'r' }))
                const headers = JSON.parse(await fs.readFile(headpath, { encoding:'utf8', flag:'r' }))
                if (!content) req.abort('failed')
                else req.respond({ headers, body:content })
            } catch (err) {
                // Mirror the request to the Web, and cache the body and return the response.
                const protocol = url.slice(0,7) === 'http://' ? http : https
                const req2 = protocol.request(url, { method:req.method(), headers:req.headers() })
                req2.on('error', e => req.abort('failed'))
                req2.on('response', res => {
                    const chunks = []
                    res.on('data', chunk => chunks.push(chunk))
                    res.on('error', e => req.abort('failed'))
                    res.on('end', async () => {
                        let content = Buffer.concat(chunks)
                        const headers = JSON.stringify(res.headers)
                        const nav = req.isNavigationRequest() ? url : ''
                        req.respond({ headers:res.headers, body:content })
                        if (req.statusCode !== 200) return // Only cache full & successful reqs.
                        content = await compress(content)
                        // A very simple cache eviction policy: while it's too big, evict a random origin.
                        const toWrite = content.length + headers.length + nav.length
                        if (toWrite > maxEntrySize) return
                        if (curCacheSize instanceof Promise) curCacheSize = await curCacheSize
                        while (curCacheSize + toWrite > maxCacheSize) {
                            const entries = await fs.readdir(cache, { withFileTypes:true })
                            const dirs = entries.filter(e => e.isDirectory())
                            const dir = path.join(cache, dirs[Math.floor(Math.random() * dirs.length)])
                            curCacheSize -= await bytesInDirectory(dir)
                            await fs.rm(dir, { force:true, recursive:true })
                        }
                        // Write our entry to the cache.
                        try {
                            await fs.mkdir(path.join(...dirpath), { recursive:true })
                            await fs.writeFile(filepath, content, { flag:'w' })
                            await fs.writeFile(headpath, headers, { encoding:'utf8', flag:'w' })
                            if (nav) await fs.writeFile(navpath, nav, { encoding:'utf8', flag:'w' })
                        } catch (err) {} // Too-long filenames won't get saved.
                    })
                })
                req.postData() && req2.write(req.postData())
                req2.end()
            }
        }
        function compress(data) {
            return new Promise((resolve, reject) => {
                zlib.deflate(data, (err, result) => err ? reject(err) : resolve(result))
            })
        }
        function decompress(data) {
            return new Promise((resolve, reject) => {
                zlib.inflate(data, (err, result) => err ? reject(err) : resolve(result))
            })
        }
        async function bytesInDirectory(at) {
            let files
            try { files = await fs.readdir(at) }
            catch (err) { return 0 }
            const sizes = await Promise.all(files.map(async f => {
                const fullPath = path.join(at, f)
                const stats = await fs.lstat(fullPath)
                if (stats.isFile()) return stats.size
                else if (stats.isDirectory()) return bytesInDirectory(fullPath)
                else return 0
            }))
            let sum = 0
            for (let i = 0; i < sizes.length; ++i)
                sum += sizes[i]
            return sum
        }
    } else if (cache !== null && typeof cache != 'function')
        throw new Error('Cache must be function or string')
    else
        cacheFunc = cache
    let mainPage = null
    return {
        init(page, env) {
            if (page.cache !== undefined) throw new Error('There can only be one .filter')
            page.cache = cache
            mainPage = page
            this.env = env
            page.setRequestInterception(true)
            page.on('request', modifyReq)
        },
        deinit(page, state) {
            page.off('request', modifyReq)
            page.setRequestInterception(false)
            mainPage = undefined
            page.cache = undefined
        },
    }
    async function modifyReq(req) {
        const url = req.url()
        if (allowURL instanceof RegExp && !allowURL.test(url)) return req.abort('accessdenied')
        const allowed = typeof allowURL == 'function' ? await allowURL(url, req, mainPage) : { url }
        if (!allowed) return req.abort('accessdenied')
        if (cacheFunc) cacheFunc(req, allowed)
        else req.continue()
    }
})



exports.stability = docs(`\`webenv.stability(timeout = 10, noCookies = true)\`
A few utilities to increase stability of the environment. Always include this.

In particular, this:
- Closes new tabs.
- Tries to enable ad blocking, because ML models shouldn't need that.
- Closes all dialogs opened by page JS.
- Opens new tabs in the main tab, so that there is only ever one tab, and image/audio capture doesn't break.
- Deletes cookies if \`noCookies\`, to be more stateless.
- Discards JS console entries, in case they accumulate and cause bother.
- To prevent infinite loops and/or heavy memory thrashing, if \`timeout\` (seconds) is non-zero: periodically checks whether JS takes too long to execute, and if so, re-launches the browser.
`, function(timeout = 10, deleteCookies = true) {
    const performance = require('perf_hooks').performance
    let env = null, lastStamp = performance.now(), intervalID = null, state = 'void'
    return {
        async init(page, E) {
            env = E
            await env._cdp.send('Page.enable')
            await env._cdp.send('Page.setDownloadBehavior', { behavior:'deny' }) // Deprecated, but so much better.
            env._cdp.send('Page.setAdBlockingEnabled', { enabled:true })
            env._browser.on('targetcreated', onNewTarget)
            page.on('dialog', onDialog)
            page.on('popup', onPopup)
            let expectedEnv = env
            ;(function waitMore(ch) {
                ch && typeof ch.cancel == 'function' && ch.cancel()
                if (env !== expectedEnv) return
                expectedEnv = env
                // With the default timeout,
                //   closing and auto-reopening the browser causes an infinite loop in Puppeteer internals.
                page.waitForFileChooser({ timeout:0 }).then(waitMore, waitMore)
            })()
            deleteCookies && page.on('load', noCookies)
            deleteCookies && page.on('framenavigated', noCookies)
            clearInterval(intervalID), intervalID = setInterval(maybeKillBrowser, timeout/2)
            state = 'initialized'
        },
        async deinit(page, state) {
            clearInterval(intervalID), intervalID = null
            deleteCookies && page.off('framenavigated', noCookies)
            deleteCookies && page.off('load', noCookies)
            page.off('popup', onPopup)
            page.off('dialog', onDialog)
            env._browser.off('targetcreated', onNewTarget)
            env._cdp.send('Page.setAdBlockingEnabled', { enabled:false })
            await env._cdp.send('Page.disable')
            env = null
        },
        read(page, state, obs) {
            if (env._page.isClosed()) return lastStamp = performance.now()
            if (Math.random() > .1 && performance.now() - lastStamp < timeout*(1000/2)) return
            // Discard console entries, and try to evaluate some JS;
            //   if it takes too long, re-launch the browser.
            //   (Re-launching can spam the console with unhandled promise rejection warnings.)
            if (!env || env._page.isClosed() || !env._browser.isConnected()) return
            env._cdp.send('Runtime.discardConsoleEntries').catch(doNothing)
            if (timeout)
                env._page.evaluate(() => 0).then(() => lastStamp = performance.now()).catch(doNothing)
            if (state === 'initialized') state = 'ready'
        },
    }
    function maybeKillBrowser() {
        if (!timeout || state !== 'ready' || performance.now() - lastStamp <= timeout*1000) return
        state = 'void'
        lastStamp = performance.now()
        env && env._browser && env._browser.isConnected() && env._browser.close()
    }
    function onPopup(newPage) {
        // A new tab opens up.
        // Tab capture is still capturing the old tab, so redirect newcomers to the old tab.
        const newURL = newPage.url()
        newPage.close()
        try {
            env._page && newURL && env._page.goto(newURL, {waitUntil:'domcontentloaded'}).catch(doNothing)
        } catch (err) { console.error('Bad URL of a popup:', newURL) }
    }
    function onDialog(dial) {
        // Who cares about questions and answers,
        //   dialogs are outdated UI that we refuse to re-implement numerically.
        dial.dismiss()
    }
    async function noCookies() {
        if (!env._page || env._page.isClosed()) return
        try {
            await env._page.deleteCookie(...(await env._page.cookies()))
        } catch (err) {}
    }
    function onNewTarget() {
        lastStamp = performance.now()
        closeAllPagesExcept(env._browser, env._page)
    }
})
function doNothing() {}



exports.injectScript = docs(`\`webenv.injectScript(...functions)\`
Executes JS functions on every new document.

See this object's properties for examples of \`functions\`.
`, function(...funcs) {
    if (!funcs.every(f => typeof f == 'function' || typeof f == 'string'))
        throw new Error('Not-a-function cannot be injected')
    const source = funcs.map(f => '(' + (''+f) + ')();').join('\n')
    return {
        priority:1,
        async init(page, env) {
            this.env = env
            this.script = (await this.env._cdp.send('Page.addScriptToEvaluateOnNewDocument', {
                source, worldName:'webenvJS',
            })).identifier
        },
        deinit(page, state) {
            this.env._cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.script })
        },
    }
})



exports.injectScript.augmentations = docs(`\`webenv.injectScript(webenv.injectScript.augmentations(severity = 1, transition = 1))\`
Some DOM-aware image augmentations: random transforms and filters.
\`severity\` is the multiplier for many effects.
\`transition\` is the max duration of smooth transitions in seconds.

(This makes every frame very open-ended. Losses that average outcomes would blur all predictions; make sure to use plausibility-maximizing losses instead.)
`, function(SEVERITY = 1, TRANSITION = 1) {
    return String(async function aug() {
        while (!document.body)
            await new Promise(requestAnimationFrame)
        const transforms = [
            ['matrix', num, num, num, num, num, num],
            ['translate', px, px],
            ['translateX', px],
            ['translateY', px],
            ['scale', num, num],
            ['scaleX', num],
            ['scaleY', num],
            ['rotate', rad],
            ['skew', rad, rad],
            ['skewX', rad],
            ['skewY', rad],
            ['matrix3d', num, num, num, num, num, num, num, num, num, num, num, num, num, num, num, num],
            ['translate3d', px, px, px],
            ['scale3d', num, num, num],
            ['rotate3d', num, num, num, rad],
            ['perspective', px],
        ]
        const filters = [
            ['blur', smallPx],
            ['brightness', perc],
            ['contrast', perc],
            ['grayscale', smallPerc],
            ['hue-rotate', rad],
            ['invert', smallPerc],
            ['opacity', perc],
            ['saturate', perc],
            ['sepia', smallPerc],
        ]
        augmentLater()
        function one(a) {
            return typeof a == 'number' ? Math.floor(Math.random() * a) : a[one(a.length)]
        }
        function augmentLater() {
            setTimeout(augment, Math.random() * 1000 * (1/SEVERITY))
        }
        function augment() {
            // Apply a random augmentation to a random element, then repeat.
            augmentLater()
            const el = randomElem()
            if (!el.style) return
            const aug = randomAug()
            const prop = Object.keys(aug)[0]
            if (el.style[prop] || el.style.transition) return
            el.style.setProperty(prop, aug[prop])
            const duration = Math.random() * TRANSITION
            if (duration) el.style.setProperty('transition', `${prop} ${duration}s`)
            setTimeout(() => {
                el.style.removeProperty(prop)
                if (duration)
                    setTimeout(() => el.style.removeProperty('transition'), duration * 1000)
            }, Math.random() * 10000 * SEVERITY)
        }
        function randomElem() {
            // Descend randomly, accumulating the parent array, then pick a random parent.
            let el = document.body, p = []
            while (el && el.firstChild) p.push(el = one(el.childNodes))
            return one(p)
        }
        function randomAug() {
            const source = one(2) ? transforms : filters
            let str = ''
            while (!str || one(2)) {
                const t = one(source)
                str += (str ? ' ' : '') + `${t[0]}(${t.slice(1).map(f => f()).join(',')})`
            }
            return source === transforms ? { transform:str } : { filter:str }
        }
        function px() { return Math.random()*50*SEVERITY + 'px' }
        function rad() { return (Math.random()-.5)*2*Math.PI*SEVERITY  + 'rad' }
        function num() { return (Math.random()-.5)*3*SEVERITY + '' }
        function smallPx() { return Math.random()*10*SEVERITY + 'px' }
        function smallPerc() { return Math.random()*SEVERITY*100 + '%' }
        function perc() { return Math.random()*2*SEVERITY*100 + '%' }
    }).replace(/SEVERITY/g, SEVERITY).replace(/TRANSITION/g, TRANSITION)
})



exports.directScore = docs(`\`webenv.directScore(hidden=false, maxHorizon=100000, maxUrls=1000000, scoreFile='', saveInterval=300, name='directScore')\`

Exposes a function that allows web pages to rate the agent's performance with a number, the higher the better.

The agents can access the normalized-to-\`-1\`…\`1\` \`obs[0]\` unless \`hidden\`, and model & maximize it. (Normalized so that there is no preference for pages, only in-page performance. And to be in a sane range.)

Please create web pages that use \`typeof directScore!=''+void 0 && directScore(x)\`, if applicable.

To view the latest improvement (the running average of normalized scores), access \`env=webenv.init(…),  env.score.ALL[1]\` in a WebEnv instance.

Args:
- \`hidden\`: if \`false\`, exposes 1 number to the agent at the beginning: the average score since the last frame, or \`NaN\`.
- \`maxHorizon\`: approximately how many most-recent samples to average over.
- \`maxUrls\`: how many statistics of reward streams to remember. No infinite memory allocation.
- \`scoreFile\`, for example, \`'scores.json'\`: the file to save per-page scores to.
- \`saveInterval\`: how often to save scores (and limit URL count), in seconds.
- \`name\`: the name of the exposed-to-pages function.
`, async function(hidden=false, maxHorizon=100000, maxUrls=1000000, scoreFile='', saveInterval=300, name='directScore') {
    const maxRawMagnitude = 1e9
    const fs = require('fs/promises')
    let data = Object.create(null) // Running-average scores, both normalized-total ("ALL") and per-URL.
    if (scoreFile)
        try { data = JSON.parse(await fs.readFile(scoreFile, { encoding:'utf8' })) }
        catch (err) {}
    let timeoutID = null, active = false
    let scoreSum = 0, scoreNum = 0, updated = false
    return {
        priority: 999999999,
        reads: hidden ? undefined : 1,
        read(page, state, obs) {
            const v = scoreSum / scoreNum // NaN if no scores since the last frame.
            scoreSum = scoreNum = 0
            const u = page.url()

            const norm = signalNormalize(v, data[u])
            if (v === v) // Update the page's reward-stream statistics, and cross-page improvement.
                data[u] = signalUpdate(v, data[u], maxHorizon),
                data.ALL = signalUpdate(norm, data.ALL, maxHorizon)
            if (!hidden) obs[0] = norm
        },
        init(page, env) {
            env.score = data
            if (timeoutID === null)
                active = true, timeoutID = setTimeout(saveData, saveInterval*1000)
            return page.exposeFunction(name, async score => {
                if (typeof score != 'number' || score !== score) return false
                scoreSum += Math.max(-maxRawMagnitude, Math.min(score, maxRawMagnitude))
                ++scoreNum
                return updated = true
            })
        },
        deinit(page, state) {
            return active = false, saveData(true)
        },
    }
    async function saveData(stop = false) {
        limitStreamCount()
        const prevID = timeoutID
        timeoutID = null
        if (scoreFile && updated && prevID != null) {
            updated = false
            if (n) await fs.writeFile(scoreFile, JSON.stringify(data), { encoding:'utf8' })
        }
        if (active && !stop) timeoutID = setTimeout(saveData, saveInterval*1000)
        if (stop) clearTimeout(prevID)
    }
    function limitStreamCount() {
        const size = Object.keys(data).length
        const delta = size - (maxUrls+1)
        if (delta <= 0) return
        const keys = Object.keys(data)
        for (let i = 0; i < delta; ++i) {
            let u = null, pop = 0
            for (let j = 0; j < 3; ++j) { // Pick some unpopular stream.
                const u2 = keys[Math.random() * keys.length | 0]
                if (!data[u2] || u2 === 'ALL') continue
                if (u == null || data[u2][0] < pop) u = u2, pop = data[u2][0]
            }
            if (u != null) delete data[u] // And kill it.
        }
    }
})
function signalUpdate(value, moments = [0,0,0], maxHorizon = 10000) {
    // Updates count & mean & variance estimates of `moments` in-place.
    //   (Make sure that `value` is sane, such as `-1e9`…`1e9`. And not normalized.)
    const prevMean = moments[1], n1 = moments[0], n2 = n1+1, d = value - moments[1]
    if (moments[0] + 1 <= maxHorizon)
        moments[0] = n2
    moments[1] += d / n2
    moments[2] = (moments[2] * n1 + d * (value - prevMean)) / n2
    if (!isFinite(moments[1]) || !isFinite(moments[2]))
        moments[0] = moments[1] = moments[2] = 0
    return moments
}
function signalNormalize(value, moments, mean = 0, stddev = .33, maxMagnitude = 3*stddev) {
    // Makes mean & variance of a signal's value roughly the same.
    if (moments) {
        const m1 = moments[1], m2 = Math.max(Math.sqrt(Math.max(0, moments[2])), 1e-6)
        value = ((value-m1)/m2 * stddev) + mean
    }
    return Math.max(-maxMagnitude, Math.min(value, maxMagnitude))
}



exports.fetchSlice = docs(`\`webenv.fetchSlice()\`
This replaces a dataset server for \`file:\` pages, for convenience.

Pages should wrap the uses of the exposed \`_fetchLocalFileSlice\` in the following:
\`\`\`js
async function fetchSlice(url, start = 0, end = null) {
    if (location.protocol !== 'file:') {
        const response = await fetch(new URL(url, ''+location) + '?start='+start+'&end='+end)
        return new Uint8Array(await response.arrayBuffer())
    }
    if (typeof _fetchLocalFileSlice != ''+void 0) { // Use WebEnv.
        const bin = atob(await _fetchLocalFileSlice(url, start, end))
        const data = new Uint8Array(bin.length)
        for (let i = 0; i < data.length; ++i) data[i] = bin.charCodeAt(i)
        return data
    } else { // File API has .slice, so, if a dataset page is opened directly, ask for assistance.
        if (!fetchSlice.fileCache) fetchSlice.fileCache = Object.create(null)
        const cache = fetchSlice.fileCache
        const file = cache[url] instanceof Promise ? (cache[url] = await cache[url]) : cache[url] || await (cache[url] = getFile(url))
        return new Promise(resolve => {
            const R = new FileReader
            R.onload = () => resolve(new Uint8Array(R.result))
            R.readAsArrayBuffer(file.slice(start, end !== null ? end : file.size))
        })
        function getFile(url) {
            return new Promise(resolve => {
                addEventListener('click', function userActed() {
                    removeEventListener('click', userActed)
                    const el = document.createElement('input')
                    el.type = 'file'
                    if (url.lastIndexOf('.') >= 0) el.accept = url.slice(url.lastIndexOf('.'))
                    el.onchange = () => resolve(el.files[0])
                    el.click()
                })
            })
        }
    }
}
\`\`\`
`, function() {
    const fs = require('fs/promises')
    return {
        init(page, env) {
            return page.exposeFunction('_fetchLocalFileSlice', async function(url, start = 0, end = null) {
                if (page.url().slice(0,7) !== 'file://')
                    throw new Error('Non-file: protocols are not supported')
                if (typeof url != 'string')
                    throw new Error('URL must be a string')
                if (url.indexOf('..') >= 0 || url.indexOf(':') >= 0 || url[0] === '/' || url[0] === '\\')
                    throw new Error('Bad URL: ' + url)
                if (typeof start != 'number' || start !== start>>>0)
                    throw new Error('Start must be a number')
                if (end !== null && (typeof end != 'number' || end !== end>>>0))
                    throw new Error('End must be null or a number')
                if (end !== null && end < start)
                    throw new Error('End must be after start')
                if (end !== null && (end - start > 20 * 2**20))
                    throw new Error('Max slice size is 20MB')
                const resolved = new URL(url, page.url())
                const buf = Buffer.alloc(end - start)
                const file = await fs.open(resolved, 'r')
                try {
                    if (end === null) end = (await file.stat()).size
                    await file.read(buf, 0, end-start, start)
                } finally { await file.close() }
                return buf.toString('base64')
            })
        },
    }
})



exports.mainPage = docs(`\`webenv.mainPage(url)\`
The URL that is navigated-to whenever the browser re/launches.
`, x => x)



exports.userAgent = docs(`\`webenv.userAgent(agent = 'WebEnv')\`
Specifies the User-Agent string.
Identify yourself and include contact information to overcome some of the prejudice against bots on the Web: https://www.w3.org/wiki/Bad_RDF_Crawlers
`, function(agent = 'WebEnv') {
    return {
        init(page, env) {
            return page.setExtraHTTPHeaders({ 'User-Agent': agent })
        },
    }
})



exports.simultaneousSteps = docs(`\`webenv.simultaneousSteps(n = 16)\`
Overrides how many steps WebEnv is allowed to run at once (at most).
Set this to \`1\` to fully synchronize on each step, which makes visualization nicer but introduces stalling.
`, function(n = 16) { return { WEBENV_SIMULTANEOUS_STEPS:n } })



function docs(str, fun) { fun.docs = str;  return fun }



exports.defaults = [
    exports.stability(),
    exports.directLink(),
    exports.directScore(),
    exports.userAgent(),
    exports.fetchSlice(),
    exports.webView(),
    exports.filter(null, 'cached'),
    exports.viewport(),
    exports.const(),
    exports.loopback(),
    exports.frameTime(),
    exports.imageFovea(100, 5000, 1),
    exports.scrollBy(),
    exports.mouse({ absolute:false, relative:50 }),
    exports.keyboard(),
    exports.injectScript(exports.injectScript.augmentations()),
    exports.interval(exports.triggers.homepage),
    exports.triggers(
        [exports.triggers.goBack, exports.triggers.randomLink],
        null,
        { maxAtOnce:1, cooldown:3600 }),
    'http://random.whatsmyip.org/',
]