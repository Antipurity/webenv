// Here are all WebEnv interface modules, in chronological order.
//   To go to a particular interface, search for `exports.XXXXX =`.



const channels = require('./src/data-channels.js')
const { signalUpdate, signalNormalize } = require('./src/signal-stats.js')
const { Observations, performance, streamPrototype } = require('./src/stream-prototype.js')
const { observers, handleUpgrade } = require('./src/observers.js')
const { compileSentJS } = require('./src/compile-sent-js.js')
const { encodeInts, decodeInts } = require('./src/int-encoding.js')
const { writeToChannel, readFromChannel, swapBytes } = channels



exports.init = docs(`Function. Pass in numeric streams and/or interfaces, receive a promise of an object that manages bidirectional numeric data streams: Env.

See \`webenv.browser\` and \`webenv.remote\` for stream types.
All top-level non-stream interfaces will be copied into all streams.

(Uniting many streams in one allows agents to process streams in batches, which is good for performance in master-slave computing architectures such as CPU+GPU. Alternatively, launch separate WebEnv processes with separate computing-backends on separate machines, and synchronize parameter-updates manually.)

Env's methods:
- \`.reinit(...streams)\`: for dynamically changing the set of streams/interfaces; \`await\` it.
    - To modify \`env\`'s streams, use \`await env.reinit(MODIFY(env.streams))\`.
    - To close streams without closing NodeJS, use \`await env.reinit()\`.
- \`.listen(path='/', func)\`: router, for making the HTTP/S server listen at \`path\` (such as \`/observations/0\`), via \`func(req, res)\`; \`await\` it.
    - Returns \`null\` if path was already listening, else \`path\`.
    - If \`func\` is \`null\` but \`path\` is not, this cancels the subscription.
    - Port & HTTPS settings are taken from \`webenv.settings(…)\` of the first stream.
- \`.upgrade(path='/', func)\`: routes upgrade requests to \`func\`, for establishing Web Socket connections. Same semantics as \`.listen\`.

(This reacts to interface-module props \`settings:{port,httpsOptions}\` and \`streamsReinit(env)\` and \`countsAsAStream:true\`.)
`, async function init(...interfaces) {
    const env = {
        streams: [],
        interfaces: [],
        settings: { port:1234, httpsOptions:null },
        _reinitLock: null,
        _server: null,
        _listenPaths: Object.create(null),
        _upgradePaths: Object.create(null),
        _period: new class ObsNumber { // Measuring time between steps.
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
        }(),
        async listen(path='/', func) { return listen(this, this._listenPaths, path, func) },
        async upgrade(path='/', func) { return listen(this, this._upgradePaths, path, func) },
        async reinit(...interfaces) {
            let p = this._reinitLock, then
            this._reinitLock = new Promise(f => then=f)
            await p // Lock.
            try {
                // Kill the server if no interfaces.
                if (!interfaces.length) {
                    const server = this._server;  this._server = null
                    this._listenPaths = Object.create(null)
                    this._upgradePaths = Object.create(null)
                    await new Promise(then => server.close(then))
                }
                // Remember the top-level interfaces, in `.interfaces`.
                const next = [], nonStreams = []
                let anyStreams = false
                await (async function track(o) {
                    if (o instanceof Promise) o = await o
                    if (Array.isArray(o)) return Promise.all(o.map(track))
                    if (!o || typeof o != 'object') throw new Error('All must be webenv streams/interfaces, got '+o)
                    if (Object.getPrototypeOf(o) === streamPrototype) next.push(o), anyStreams = true
                    else nonStreams.push(o), o.countsAsAStream && (anyStreams = true)
                })(interfaces)
                nonStreams.forEach(x => x.settings && typeof x.settings=='function' && Object.assign(this.settings, x.settings))
                nonStreams.forEach(x => typeof x.streamsReinit=='function' && x.streamsReinit(this))
                this.interfaces = nonStreams
                if (!anyStreams)
                    next.push(this.streams[0] || (await exports.browser()))
                const newStreams = [], preservedStreams = new Set
                for (let s of next) { // Preserve the new+old.
                    if (s.index !== null && s.env !== this)
                        throw new Error('A stream already belongs to another env')
                    if (s.index !== null) newStreams[s.index] = s, preservedStreams.add(s)
                }
                const removed = this.streams.filter(s => !preservedStreams.has(s))
                this.streams = newStreams
                const tmp = []
                for (let s of next) // Allocate+open the new.
                    if (s.index === null) {
                        let i = 0
                        while (newStreams[i] !== undefined) ++i
                        newStreams[i] = s
                        tmp.push(s.open(this, i))
                    }
                await Promise.all(removed.map(s => s.close())) // Close the old.
                removed.forEach(s => s.env = s.index = null)
                await Promise.all(tmp) // Open the new.
                return this
            } finally { then() }
        },
    }
    return await env.reinit(...interfaces)
    async function listen(env, paths, path, func) {
        if (!env._server) await setupServer(env)
        const had = path in paths
        if (!func && path != null) delete paths[path]
        else if (typeof func != 'function')
            throw new Error('Listener is not a function')
        if (!had) paths[path] = func
        return had ? path : null
    }
    async function setupServer(env) {
        const opt = env.settings.httpsOptions
        const http = require('http'), https = require('https')
        const server = !opt ? (f => http.createServer(f)) : (f => https.createServer(opt, f))
        env._server = server((req, res) => {
            const u = req.url, paths = env._listenPaths
            if (u in paths) paths[u](req, res)
            else res.statusCode = 404, res.end()
        })
        env._server.on('upgrade', (req, socket, head) => {
            const u = req.url, paths = env._upgradePaths
            if (u in paths) paths[u](req, socket, head)
            else socket.end()
        })
        return new Promise(then => env._server.listen(env.settings.port, then))
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
        async read(stream, obs, end) { await end();  obs.fill(value) },
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
        async read(stream, obs, end) { await end();  lastAct && obs.set(lastAct) },
        writes: count,
        write(stream, pred, act) { lastAct = act },
    }
})



exports.image = docs(`Observations of the whole viewport; each pixel R/G/B is a number, -1..1.
Provide a mask color (0xRRGGBB) to mask exact matches, or \`null\` to disable that. Non-black-and-white masks may get distorted by video compression, and thus become unusable.
Slloooooooow.
`, function image(maskColor = 0xfafafa) {
    return [observers, {
        init(stream) {
            this.reads = stream.settings.width * stream.settings.height * 3
        },
        reads:'computed',
        observer: [async function image(media, {obs}, end, w, h, maskColor) {
            const d = await media.video(0, 0, w, h, w, h)
            // Normalize and write.
            await end()
            for (let from = 0, to = 0; to < obs.length; ) {
                const R = d[from++], G = d[from++], B = d[from++], A = d[from++]
                const masked = maskColor != null && ((R<<16) | (G<<8) | B) === maskColor
                obs[to++] = masked ? NaN : (2*R - 255) / 255
                obs[to++] = masked ? NaN : (2*G - 255) / 255
                obs[to++] = masked ? NaN : (2*B - 255) / 255
            }
        }, s => s.settings.width, s => s.settings.height, maskColor],
        visualize: [
            visualizePageScreenshot,
            s => -s.settings.width/2 | 0,
            s => -s.settings.height/2 | 0,
            s => s.settings.width,
            s => s.settings.height,
            s => s.settings.width,
            s => s.settings.height,
        ],
    }]
})



function visualizePageScreenshot(elem, obs, pred, x, y, width, height, maxW, maxH) {
    x -= (width/2) | 0, y -= (height/2) | 0
    if (obs.length % 3) throw new Error('Bad length: ' + obs.length)
    if (!elem.obs) {
        elem.obs = globalElem('div', 'imageObs')
        elem.pred = globalElem('div', 'imagePred')
        const obsC = elem.obs.appendChild(document.createElement('canvas'))
        obsC.width = width, obsC.height = height
        elem.obsCtx = obsC.getContext('2d', {desynchronized:false})
        elem.obsData = elem.obsCtx.createImageData(width, height)
        const predC = elem.pred.appendChild(document.createElement('canvas'))
        predC.width = width, predC.height = height
        elem.predCtx = predC.getContext('2d', {desynchronized:false})
        elem.predData = elem.predCtx.createImageData(width, height)
    }
    const style = { position:'absolute', left:x+'px', top:y+'px', }
    Object.assign(elem.obsCtx.canvas.style, style)
    Object.assign(elem.predCtx.canvas.style, style)
    put(elem.obsCtx, elem.obsData, obs, pred)
    put(elem.predCtx, elem.predData, pred)
    function toByte(x, nan = -1) {
        return Math.round(((x !== x ? nan : x) + 1) * (255/2))
    }
    function put(ctx, data, obs, fallback) {
        let d = data.data
        for (let from = 0, to = 0; to < d.length; from += 3) {
            d[to++] = toByte(obs[from+0], fallback ? fallback[from+0] : -1)
            d[to++] = toByte(obs[from+1], fallback ? fallback[from+1] : -1)
            d[to++] = toByte(obs[from+2], fallback ? fallback[from+2] : -1)
            d[to++] = 255
        }
        ctx.putImageData(data, 0, 0)
    }
    function globalElem(tag, withClass) {
        let e, q = elem.parentNode.querySelector(tag+'.'+withClass)
        if (q) return q
        e = elem.appendChild(document.createElement(tag)), e.className = withClass
        Object.assign(e.style, {
            position:'relative', display:'inline-block',
            width:maxW+'px', height:maxH+'px', overflow:'hidden',
            border:'1px solid',
        })
        return e
    }
}



exports.imageRect = docs(`\`webenv.imageRect(width = 100, height = width, quantize = 1, maskColor = 0xfafafa)\`

Observations of a rect around the mouse; each pixel R/G/B is a number, -1..1.

The effective mouse position will be altered to have both coordinates divisible by \`quantize\`, to reduce drift.

Provide a mask color (0xRRGGBB) to mask exact matches, or \`null\` to disable that.

(A moving viewpoint acts as a crop of the image. And since web pages are typically consistent, this acts as the well-known augmentation for training visual models: two crops of the same image should have a very similar representation. No zooming like electromagnetic sensors in 3D environments get for free, though.)
`, function imageRect(width = 100, height = width, quantize = 1, maskColor = 0xfafafa) {
    return [observers, {
        reads: width * height * 3,
        reactToObserver(stream, result) {
            if (typeof result != 'number' || result !== result>>>0) return
            stream._obsMouseX = result / 10000 | 0
            stream._obsMouseY = result % 10000
        },
        observer: [
            async function imageRect(media, {obs}, end, x, y, w, h, maxW, maxH, maskColor) {
                const result = x*10000 + y
                x -= (w/2) | 0, y -= (h/2) | 0
                const d = await media.video(x, y, w, h, maxW, maxH)
                // Normalize and write.
                await end()
                for (let i = 0, from = 0, to = 0; to < obs.length; ++i) {
                    const R = d[from++], G = d[from++], B = d[from++], A = d[from++]
                    const masked = maskColor != null && ((R<<16) | (G<<8) | B) === maskColor
                    obs[to++] = masked ? NaN : (2*R - 255) / 255
                    obs[to++] = masked ? NaN : (2*G - 255) / 255
                    obs[to++] = masked ? NaN : (2*B - 255) / 255
                }
                return result
            },
            s => (s.mouseX || 0) - (s.mouseX || 0) % quantize,
            s => (s.mouseY || 0) - (s.mouseY || 0) % quantize,
            width,
            height,
            s => s.settings.width,
            s => s.settings.height,
            maskColor,
        ],
        visualize: [
            visualizePageScreenshot,
            s => s._obsMouseX | 0,
            s => s._obsMouseY | 0,
            width,
            height,
            s => s.settings.width,
            s => s.settings.height,
        ],
    }]
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
    const closestPointArray = Array.from(closestPoint)
    return [observers, {
        reads: numPoints * 3,
        reactToObserver(stream, result) {
            if (typeof result != 'number' || result !== result>>>0) return
            stream._obsMouseX = result / 10000 | 0
            stream._obsMouseY = result % 10000
        },
        observer: [
            async function imageFovea(media, {obs}, end, closestPoint, x, y, w, h, maxW, maxH, maskColor) {
                const result = x*10000 + y
                x -= (w/2) | 0, y -= (h/2) | 0
                if (!imageFovea.pointSum) { // Prepare data, if not prepared already.
                    let max = 0
                    for (let i = 0; i < closestPoint.length; ++i)
                        max = Math.max(max, closestPoint[i])
                    const numPoints = max + 1
                    imageFovea.pointSum = new Float32Array(numPoints * 3)
                    imageFovea.pointNum = new Int32Array(numPoints)
                }
                // Get image data.
                const d = await media.video(x, y, w, h, maxW, maxH)
                const pointSum = imageFovea.pointSum, pointNum = imageFovea.pointNum
                // Normalize, average, and write.
                await end()
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
                return result
            },
            closestPointArray,
            s => (s.mouseX || 0) - (s.mouseX || 0) % quantize,
            s => (s.mouseY || 0) - (s.mouseY || 0) % quantize,
            diam,
            diam,
            s => s.settings.width,
            s => s.settings.height,
            maskColor,
        ],
        visualize: [
            function visualizePageFovea(elem, obs, pred, closestPoint, diam, x, y, maxW, maxH) {
                x -= (diam/2) | 0, y -= (diam/2) | 0
                if (obs.length % 3) throw new Error('Bad length: ' + obs.length)
                if (!elem.obs) {
                    elem.obs = globalElem('div', 'imageObs')
                    elem.pred = globalElem('div', 'imagePred')
                    const obsC = elem.obs.appendChild(document.createElement('canvas'))
                    obsC.style.borderRadius = '50%'
                    obsC.width = obsC.height = diam
                    elem.obsCtx = obsC.getContext('2d', {desynchronized:false})
                    elem.obsData = elem.obsCtx.createImageData(diam, diam)
                    const predC = elem.pred.appendChild(document.createElement('canvas'))
                    predC.style.borderRadius = '50%'
                    predC.width = predC.height = diam
                    elem.predCtx = predC.getContext('2d', {desynchronized:false})
                    elem.predData = elem.predCtx.createImageData(diam, diam)
                }
                const style = { position:'absolute', left:x+'px', top:y+'px', }
                Object.assign(elem.obsCtx.canvas.style, style)
                Object.assign(elem.predCtx.canvas.style, style)
                put(elem.obsCtx, elem.obsData, obs, pred)
                put(elem.predCtx, elem.predData, pred)
                function toByte(x, nan = -1) {
                    return Math.round(((x !== x ? nan : x) + 1) * (255/2))
                }
                function put(ctx, data, obs, fallback) {
                    let d = data.data
                    for (let j = 0, to = 0; to < d.length; ++j) {
                        const from = closestPoint[j]*3
                        d[to++] = toByte(obs[from+0], fallback ? fallback[from+0] : -1)
                        d[to++] = toByte(obs[from+1], fallback ? fallback[from+1] : -1)
                        d[to++] = toByte(obs[from+2], fallback ? fallback[from+2] : -1)
                        d[to++] = 255
                    }
                    ctx.putImageData(data, 0, 0)
                }
                function globalElem(tag, withClass) {
                    let e, q = elem.parentNode.querySelector(tag+'.'+withClass)
                    if (q) return q
                    e = elem.appendChild(document.createElement(tag)), e.className = withClass
                    Object.assign(e.style, {
                        position:'relative', display:'inline-block',
                        width:maxW+'px', height:maxH+'px', overflow:'hidden',
                        border:'1px solid',
                    })
                    return e
                }
            },
            closestPointArray,
            diam,
            s => s._obsMouseX | 0,
            s => s._obsMouseY | 0,
            s => s.settings.width,
            s => s.settings.height,
        ],
    }]
    function getFoveatedCoords(radius, numPoints, RNG, density) {
        if (numPoints > Math.PI * radius*radius / 2)
            throw new Error('More points than the radius can reasonably allow')
        const points = new Set
        while (points.size < numPoints) {
            const angle = RNG() * 2*Math.PI, distance = density(RNG()) * radius
            const x = (Math.cos(angle) * distance | 0) + radius
            const y = (Math.sin(angle) * distance | 0) + radius
            const hash = (y<<16) | x
            if (points.has(hash)) continue
            points.add(hash)
        }
        return [...points].sort((a,b) => { // Split into 16×16 blocks, and sort sort by x in each block.
            const ya = a>>>16, xa = a&65535, blocka = (ya>>>4)*200 + (xa>>>4)
            const yb = a>>>16, xb = a&65535, blockb = (yb>>>4)*200 + (xb>>>4)
            if (blocka===blockb) return a-b
            return blocka - blockb
        })
    }
    function invertFoveatedCoords(radius, points) {
        // `image`, returned: from x+radius + 2*radius*(y+radius) to the index into `points`.
        // Here, we perform a BFS from points to fill the closest-point-to-here array properly.
        const diam = 2*radius
        const image = new Uint32Array(diam*diam)
        image.fill(points.length)
        const nextPos = []
        for (let i = 0; i < points.length; ++i) {
            const p = points[i], x = p & 65535, y = p >>> 16
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
    return [observers, {
        reads: samples,
        observer: [async function audio(media, {obs}, end, samples, sampleRate) {
            // A copy, but this is small-time compared to `webenv.image(...)`.
            const data = await media.audio(samples, sampleRate)
            await end()
            obs.set(data)
        }, samples, sampleRate],
        visState(stream) { return sampleRate },
        visualize: [function(elem, obs, pred) {
            let obsSqr = 0, predSqr = 0
            for (let i=0; i < obs.length; ++i) obsSqr += obs[i] * obs[i] || 0
            for (let i=0; i < pred.length; ++i) predSqr += pred[i] * pred[i] || 0
            const obsDb = (-20 * Math.log(1 / Math.sqrt(obsSqr))).toFixed(2)
            const predDb = (-20 * Math.log(1 / Math.sqrt(predSqr))).toFixed(2)
            elem.textContent = `Volume: ${obsDb} dB real | ${predDb} dB predicted`
            elem.style.fontFamily = 'monospace, monospace'
        }],
    }]
})



exports.visualize = docs(`\`webenv.visualize(path = '')\`
Allows visualizing the observations and predictions, by opening \`localhost:1234/path\` or similar in a browser.
To prevent others from seeing observations, use random characters as \`path\`.
Other interfaces may define:
- \`.visualize: [(elem, obs, pred, ...args)=>…, ...args]\`.
    - Computed \`args\` get \`stream\`.
    - \`elem\` is a \`<div>\`, initially empty.
    - \`obs\` and \`pred\` are float32 arrays of equal size.
`, function visualize(path = '') {
    const serverSentEvents = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    }
    const pages = {
        'Cache-Control': 'max-age=' + (24*3600), // A kilobyte a day is a rite away.
        'Content-Type': 'text/html',
    }
    const key = visualize.key || (visualize.key = Symbol('visualize'))
    function Spot(o) { return o[key] || (o[key] = Object.create(null)) }
    function route(...p) { return '/' + p.filter(s=>s).join('/') }
    return {
        async streamsReinit(env) {
            await Promise.all([
                // API.
                env.listen(route('observations', path), (req, res) => {
                    // Live stream lists.
                    const spot = Spot(env)
                    const to = spot.connections || (spot.connections = new Set)
                    to.add(res), res.on('close', () => to.delete(res))
                    res.writeHead(200, serverSentEvents)
                    sendRestream(env, to)
                }),
                // UI.
                env.listen(route(path), (req, res) => {
                    // List all streams, and allow switching between them.
                    //   (Very simple HTML, inlined & hardcoded.)
                    const bpe = Observations.BYTES_PER_ELEMENT
                    res.writeHead(200, pages)
                    res.end(`
<!DOCTYPE html>
<style>
    html { display:flex; flex-flow:row wrap; height:100%; justify-content:center; align-items:center; overflow-x:hidden; }
    canvas { box-shadow: 0 0 .1em gray }
    button { border:none; width:2em; height:2em }
    button.active { background-color:#4dc1ed }
    @media (prefers-color-scheme: dark) {
        /* Glow-in-the-dark theme. */
        html { background-color:#1f1f1f; color:#e0e0e0 }
    }
    #buttonContainer { display:flex; flex-flow:column wrap; justify-content:center; align-items:center }
    #rootContainer { flex:1 1 auto; position:relative; height:100% }
    #rootContainer>div>div { text-align:center }
    .root { animation: .2s fade-in }
    .removed { position:absolute; left:0;top:0;width:100%; pointer-events:none;  animation: .2s fade-out both }
    @keyframes fade-in { from{ opacity:0; transform:translate(50em,0) } to{ opacity:1 } }
    @keyframes fade-out { from{ opacity:1 } to{ opacity:0; transform:translate(-50em,0) } }
</style>
<script>
// Selection.
const bc = document.documentElement.appendChild(document.createElement('div'))
const rc = document.documentElement.appendChild(document.createElement('div'))
bc.id = 'buttonContainer', rc.id = 'rootContainer'
const sources = new EventSource(${JSON.stringify(route('observations', path))})
const buttons = []
let selected
function select(btn) {
    selected && selected.classList.remove('active')
    const sameId = selected && selected.textContent === btn.textContent
    if ((selected = btn)) {
        if (!sameId) changeSourceTo(${JSON.stringify(route('observations', path)+'/')}+btn.textContent)
        selected.classList.add('active')
    }
}
sources.addEventListener('restream', function(evt) {
    const ids = JSON.parse(evt.data)
    buttons.forEach(b => b.remove())
    const prevSelected = selected && selected.textContent
    ids.forEach(id => {
        const b = document.createElement('button')
        b.textContent = ''+id
        b.setAttribute('key', ''+id)
        if (prevSelected === b.textContent) select(b)
        if (ids.length > 1) bc.appendChild(b)
        buttons.push(b)
    })
    if (!ids.length) select()
    else if (!selected || ids.length == 1) select(buttons[0])
})
onclick = evt => {
    if (!evt.target || evt.target.tagName !== 'BUTTON') return
    select(evt.target)
}
onkeydown = evt => {
    const b = document.querySelector(\`button[key="\${evt.key}"]\`)
    b && b.click()
}
// Stream visualization.
let RCV, source
function changeSourceTo(to) {
    source && source.close()
    source = new EventSource(to)
    source.addEventListener('relink', function(evt) {
        RCV = (new Function(evt.data))()
    })
    source.onmessage = function(evt) { // Receive, decode, defer.
        if (!RCV) return
        const parts = evt.data.split(' ')
        decode(parts[0], RCV.obs)
        decode(parts[1], RCV.pred)
        RCV(parts.slice(2).join(' '))
    }
    RCV = null
}
function decode(base64, into) {
    if (!base64) return
    const str = atob(base64)
    into = new Uint8Array(into.buffer, into.byteOffset, into.byteLength)
    const end = Math.min(into.length * ${bpe}, str.length)
    if (endian() === 'LE')
        for (let i=0; i < end; ++i) into[i] = str.charCodeAt(i)
    else
        for (let i=0; i+${bpe-1} < end; i += ${bpe})
            ${new Array(bpe).fill().map((_,j) => `into[i+${j}] = str.charCodeAt(i+${bpe-j-1})`).join(', ')}
}
${endian}
</script>`)
                }),
            ])
        },
        async init(stream) {
            const env = stream.env, id = stream.index
            sendRestream(env, Spot(env).connections) // Adding/removing many streams at once will send quadratically-many stream indices. Who cares.
            // API.
            await env.listen(route('observations', path, ''+id), (req, res) => {
                // Remember to later send events to here whenever observations arrive.
                const spot = Spot(stream)
                const to = spot.connections || (spot.connections = new Set)
                to.add(res), res.on('close', () => to.delete(res))
                res.writeHead(200, serverSentEvents)
                sendRelink(stream, to)
            })
        },
        async deinit(stream) {
            // '/observations/path' and '/path' never get unlinked,
            //   but the server gets stopped for closed envs, so no memory leak.
            const env = stream.env, id = stream.index
            sendRestream(env, Spot(env).connections)
            Spot(stream).connections && Spot(stream).connections.forEach(res => res.end())
            await env.listen(route('observations', path, ''+id))
        },
        priority:-1,
        async read(stream, obs, end) {
            const spot = Spot(stream)
            const to = spot.connections || (spot.connections = new Set)
            if (!to.size) return
            if (spot.interfaces !== stream.interfaces || !spot.SND) {
                spot.SND = 'waiting'
                spot.interfaces = stream.interfaces
                spot.interfaces.ID = Math.random()
                ;[spot.SND, spot.RCV] = await createExtendJS(stream)
                sendRelink(stream, to)
            }
            if (spot.SND === 'waiting') return
            const json = await spot.SND(stream)
            await end()
            sendObservation(obs, spot.pred, json, to)
        },
        write(stream, pred, act) {
            // Remember prediction to send later, unless it's all NaN.
            if (!pred) return
            const spot = Spot(stream)
            let empty = true
            for (let i = 0; i < pred.length; ++i)
                if (pred[i] === pred[i]) { empty = false;  break }
            spot.pred = empty ? null : pred // Only remember the last pred.
            // Not perfectly synchronized like a queue would be, but, who cares.
            //   (And `pred` changes in-place, so a queue would require expensive copies.)
        },
    }
    function sendRestream(env, to) {
        if (!to || !to.size) return
        const indices = []
        for (let i = 0; i < env.streams.length; ++i)
            if (env.streams[i]) indices.push(i)
        const toWrite = `event:restream\ndata:${JSON.stringify(indices)}\n\n`
        to.forEach(res => res.write(toWrite))
    }
    function sendRelink(stream, to) {
        const spot = Spot(stream)
        if (!to || !to.size || !spot.RCV) return
        const toWrite = `event:relink\ndata:${spot.RCV.replace(/\n/g, '\ndata:')}\n\n`
        to.forEach(res => res.write(toWrite))
    }
    function sendObservation(obs, pred, json, to) {
        // 33% + 8 bytes of memory overhead per obs, due to base64 and Server-Sent Events.
        if (!(obs instanceof Observations)) throw new Error('Observation is not f32')
        if (pred && !(pred instanceof Observations)) throw new Error('Prediction is not f32')
        // Read all observations, not just ours.
        const obs64 = toLittleEndian(obs, Observations.BYTES_PER_ELEMENT).toString('base64')
        const pred64 = pred ? toLittleEndian(pred, Observations.BYTES_PER_ELEMENT).toString('base64') : ''
        const toWrite = `data:${obs64} ${pred64} ${json}\n\n`
        to.forEach(res => res.write(toWrite))
    }
    async function createExtendJS(stream) { // → [SND, RCV]
        const inters = stream._all
        if (!inters) return ''
        const staticArgs = new Map, items = [], prelude = []
        // Remove old root. (Only a bit of unused memory is leaked for a bit, it's okay.)
        prelude.push(`const oldRoot = document.querySelector('.root')`)
        prelude.push(`if (oldRoot) oldRoot.className = 'removed', setTimeout(() => oldRoot.remove(), 2000)`)
        // Add new root.
        prelude.push(`const root = document.querySelector('#rootContainer').appendChild(document.createElement('div'))`)
        prelude.push(`root.className = 'root'`)
        // Re-use obs/pred arrays for a bit more efficiency.
        let reads = 0
        const bpe = Observations.BYTES_PER_ELEMENT, cons = Observations.name
        for (let inter of inters)
            if (typeof inter.reads == 'number')
                reads += inter.reads
        prelude.push(`const o = RCV.obs = new ${cons}(${reads})`)
        prelude.push(`const p = RCV.pred = new ${cons}(${reads})`)
        let n = 0, start = 0
        for (let inter of inters) {
            if (typeof inter.reads == 'number') start += inter.reads
            const item = inter.visualize
            if (!Array.isArray(item)) continue
            // Prepare elem,obs,pred for each visualized interface (item).
            const elem = 'v'+n++, o = 'v'+n++, p = 'v'+n++
            prelude.push(`const ${elem} = root.appendChild(document.createElement('div'))`)
            const r = inter.reads || 0, realStart = start - r
            prelude.push(`const ${o} = new ${cons}(o.buffer, o.byteOffset + ${realStart*bpe}, ${r})`)
            prelude.push(`const ${p} = new ${cons}(p.buffer, p.byteOffset + ${realStart*bpe}, ${r})`)
            items.push(item)
            staticArgs.set(item, `${elem},${o},${p}`)
        }
        return compileSentJS(staticArgs, items, prelude.join('\n'))
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



exports.io = docs(`\`webenv.io()\`
Makes the actual agent reside in another process, connected through standard IO. (Useful for isolation and parallelization.)

If one stream in an env has this, then all other streams there must have this too.

Communication protocol details, simple for easy adoption:
- Here, "environment" means this process, "agent" means the controlling process that receives its observations and feeds it (predictions and) actions.
- At init:
    - The agent sends the magic u32 number \`0x01020304\`.
        - (This allows the environment to perform all endianness conversions, simplifying the agent.)
    - The agent sends u32 int size: \`0\` for float32, \`1\` for int8, \`2\` for int16.
        - All that extra capacity is extra verification.
        - Allows decreasing precision and increasing throughput.
        - Values are encoded/decoded, but indices/lengths will still use unsigned int32.
            - To decode int8, \`v = x === -128 ? NaN : v / 127\`.
            - To encode int8, \`x = v !== v ? -128 : round(clamp(v, -1, 1) * 127)\`.
            - To decode int16, \`v = x === -65536 ? NaN : x / 32767\`.
            - To encode int16, \`x = v !== v ? -65536 : round(clamp(v, -1, 1) * 32767)\`.
- Loop:
    - The agent receives:
        - u32 stream index (minimal, so it can be used to index into a dense vector of stream states),
        - u32 observation length,
        - then observation (that many values),
        - then u32 expected action length (0xFFFFFFFF to indicate that this stream has ended, and its index will be reused later).
    - (The agent schedules a computation, which goes from observations to actions.)
        - (The agent should replace NaN observations with its own predictions of them. This is done in-agent for differentiability.)
    - In response, the agent sends:
        - u32 stream index,
        - u32 prediction length (feel free to make this 0, which would disable its visualization),
        - then observation prediction (that many values),
        - then u32 action length,
        - then the action (that many values),
        - then flushes buffers to ensure sending.
        (Mix up the response order if that is more efficient for you, but try not to. Never interleave individual messages unless you want a hang.)
        (Do not worry about matching requested lengths exactly, focus on throughput.)
        (Non-specified values are NaN, or 0 where NaN does not make sense.)

(Even though on WebEnv side, loops are separate, parallel processing on the agent side (rather than serial) should discourage resource starvation.)
`, function io() {
    if (!io.ch) io.ch = channels.streams() // STDIO
    let cons // Constructor for encoded arrays.
    let writeLock = null // No torn writes.
    async function readAllData(env, bs) {
        // Infinitely read STDIO.
        while (true) {
            try {
                const index = await readFromChannel(io.ch, 1, Number, bs)
                const predData = await readArray(cons, bs)
                const actData = await readArray(cons, bs)
                const s = env.streams[index]
                if (!s) continue
                const q = s._dataQueue || (s._dataQueue = { items:[], waiting:[] })
                const item = [predData, actData]
                if (q.items.length > s.settings.simultaneousSteps) q.items.shift()
                if (q.waiting.length) { // Resolve the first reader.
                    q.waiting.shift()(item)
                } else // Allow others to resolve the item.
                    q.items.push(item)
            } catch (err) { if (err !== 'skip') throw err }
        }
    }
    function getDataQueueItem(s) {
        const q = s._dataQueue || (s._dataQueue = { items:[], waiting:[] })
        if (!q.items.length)
            return new Promise(then => q.waiting.push(then))
        return q.items.shift()
    }
    return {
        obsCoded: null,
        async init(stream) {
            if (io.env && io.env !== stream.env)
                throw new Error('STDIO is once per process, but got another WebEnv trying to get in on the action')
            if (io.env) return // STDIO is once per process.
            io.env = stream.env
            const magic = await readFromChannel(io.ch, 1, Number, false)
            if (magic === 0x01020304)
                this.byteswap = false
            else if (magic === 0x04030201)
                this.byteswap = true
            else
                throw new Error('Bad magic number:', magic)
            const intSize = await readFromChannel(io.ch, 1, Number, this.byteswap)
            if (![0,1,2].includes(intSize)) throw new Error('Bad intSize: '+intSize)
            cons = intSize === 0 ? Float32Array : intSize === 1 ? Int8Array : Int16Array
            this.obsCoded = new cons(0)
            readAllData(stream.env, this.byteswap) // Fill those data queues.
        },
        async deinit(stream) {
            if (!io.env) return
            // Send a dealloc event.
            let oldW = writeLock, thenW
            writeLock = new Promise(f => thenW=f);  await oldW
            const bs = this.byteswap
            await writeToChannel(io.ch, stream.index, bs)
            await writeToChannel(io.ch, 0, bs)
            await writeToChannel(io.ch, 0xFFFFFFFF, bs)
            thenW()
        },
        async agent(stream, {obs, pred, act}) {
            // Write observation, atomically (no torn writes).
            if (!io.env) return
            let oldW = writeLock, thenW
            writeLock = new Promise(f => thenW=f);  await oldW
            const bs = this.byteswap
            await writeToChannel(io.ch, stream.index, bs)
            await writeArray(this.obsCoded = encodeInts(obs, this.obsCoded), bs)
            await writeToChannel(io.ch, act.length, bs)
            thenW()
            // Read from our data queue.
            const [predData, actData] = await getDataQueueItem(stream)
            decodeInts(predData, pred), decodeInts(actData, act)
        },
    }
    async function writeArray(data, byteswap = false) {
        // Length then data.
        await writeToChannel(io.ch, data.length, byteswap)
        await writeToChannel(io.ch, data, byteswap)
    }
    async function readArray(format, byteswap = false) {
        // Length then data.
        const len = await readFromChannel(io.ch, 1, Number, byteswap)
        return await readFromChannel(io.ch, len, format, byteswap)
    }
})



exports.directLink = docs(`\`webwenv.directLink(name = 'directLink', maxReads = 2**16, maxWrites = 2**16)\`
Allows web pages to dynamically establish a high-bandwidth connection, via calling \`directLink\`.
(Abusing this feature will cause agents to get very confused, as they have no way to know about format changes apart from prediction.)

(The closest analogue of a real-time data channel that has equal read and write capabilities for humans is music (high-effort art is too slow), which can be used to capture and convey the neural feel of arbitrary neural computations. Research music 2.0, preferably if you have a direct neural link device.)

In a page, \`directLink(PageAgent, Inputs = 0, Outputs = 0)\` will return \`true\` if successfully established, else \`false\`.
\`PageAgent\` will be called automatically, until it does not return \`true\` and gets canceled.
\`PageAgent(Act, Obs)\` synchronously reads \`Act\` (of length \`Inputs\`) and writes to \`Obs\` (of length \`Outputs\`). All values are 32-bit floats, \`-1\`…\`1\` or \`NaN\`.
(No predictions, and thus no iffiness about copyright.)
`, function directLink(name = 'directLink', maxReads = 2**16, maxWrites = 2**16) {
    // This goes for low-latency over reliability.
    //   Expect some frames to have extra obs/act (reads/writes) updates, or skip updates.

    // Test: `directLink((a,o) => console.log('step', a[0]) || (Math.random()>.001 ? (o[0]=.2,true) : false),1,1)`
    //   You might notice that `a[0]` is `0` for a few steps.
    // Test: `directLink(a => console.log('A', a[0]) || (Math.random()>.01 ? true : false),1), directLink(a => console.log('B', a[0]) || (Math.random()>.01 ? true : false),1)`
    const script = `
if (!window.${name}) {
    window.${name} = function link(agent, inputs=0, outputs=0) {
        if (typeof agent != 'function') throw new Error('Not a func')
        if (typeof inputs != 'number' || typeof outputs != 'number') throw new Error('Not a number')
        if (!link.obs) link.obs = new Float32Array(0)
        if (!link.act) link.act = new Float32Array(0)
        if (link.obs.length + outputs > ${maxReads} || link.act.length + inputs > ${maxWrites}) return false
        if (outputs) link.obs = new Float32Array(link.obs.length + outputs)
        if (inputs) link.act = new Float32Array(link.act.length + inputs)
        return (link.agents || (link.agents = [])).push({ agent, act:inputs, obs:outputs }), true
    }
    document.addEventListener('_directLinkAct', async function step(evt) { // Get acts, call agents, return obs.
        if (typeof evt.detail != 'string' || !window.${name}.agents || !window.${name}.agents.length) return
        let ag = window.${name}.agents, act = window.${name}.act, obs = window.${name}.obs
        fromBinStr(atob(evt.detail), act)
        let res = new Array(ag.length).fill()
        if (!step.blackList) step.blackList = new WeakSet
        for (let i=0, r=0, w=0; i < ag.length; r += ag[i].obs, w += ag[i].act, ++i)
            try {
                res[i] = !step.blackList.has(ag[i]) && ag[i].agent(act.subarray(w, w+ag[i].act), obs.subarray(r, r+ag[i].obs))
            } catch (err) { console.error(err), step.blackList.add(ag[i]) }
        for (let i=0; i < ag.length; ++i)
            try { res[i] = res[i] instanceof Promise ? await res[i] : res[i];  res[i] !== true && step.blackList.add(ag[i]) }
            catch (err) { console.error(err), step.blackList.add(ag[i]) }
        if (ag.some(x => step.blackList.has(x))) {
            const ag2 = window.${name}.agents = ag.filter(x => !step.blackList.has(x))
            const r = ag2.reduce((v,a) => v + a.obs, 0), w = ag2.reduce((v,a) => v + a.act, 0)
            obs = window.${name}.obs = new Float32Array(r), act = window.${name}.act = new Float32Array(w)
        }
        document.dispatchEvent(new CustomEvent('_directLinkObs', { detail: act.length+' '+btoa(toBinStr(new Uint8Array(obs.buffer, obs.byteOffset, obs.byteLength))) }))
    })
    function fromBinStr(s, into) {
        const b = new Uint8Array(into.buffer, into.byteOffset, into.byteLength)
        const end = s.length - (s.length % into.BYTES_PER_ELEMENT)
        for (let i = 0; i < b.length && i < end; ++i) b[i] = s.charCodeAt(i)
        return into
    }
    function toBinStr(b) {
        let s = '', d = Object.create(null)
        for (let i = 0; i < b.length; ++i) s += d[b[i]] || (d[b[i]] = String.fromCharCode(b[i]))
        return s // The loop above is optimized by JS engines, so no quadratic time/space complexity.
    }
}`
    return {
        reads:'rest',
        writes:'rest',
        init(s) {
            if (s._directLinkAct !== undefined) s.IOArraySizeReserve = 0 // For relaunching.
            s._directLinkObs = s._directLinkAct = 0, s.IOArraySizeReserve += Math.max(maxReads, maxWrites)
        },
        deinit(s) { s._directLinkObs = s._directLinkAct = undefined, s.IOArraySizeReserve -= Math.max(maxReads, maxWrites) },
        priority: -999999999,
        reactToObserver(stream, result) {
            // Resize observations + actions.
            let [obsLen, actLen] = Array.isArray(result) && result.length == 2 ? result : [0,0]
            if (typeof obsLen != 'number' || obsLen !== obsLen>>>0) return
            if (typeof actLen != 'number' || actLen !== actLen>>>0) return
            obsLen = Math.min(obsLen, maxReads), actLen = Math.min(actLen, maxWrites)
            stream.resize(stream.reads + obsLen - stream._directLinkObs, stream.writes + actLen - stream._directLinkAct)
            stream._directLinkObs = obsLen, stream._directLinkAct = actLen
        },
        // Lots of data format conversions below. But, eh, not nearly as bad for the WebEnv server as doing them on-server.
        // (This is not really friendly to having many open human connections at once.)
        observer: [async function observeLinks(media, {obs,pred,act}, end) {
            // Send the content script our actions.
            if (!(act instanceof Float32Array)) throw new Error('Expected f32')
            const act64 = btoa(toBinStr(new Uint8Array(act.buffer, act.byteOffset, act.byteLength)))
            if (typeof chrome != ''+void 0 && chrome.runtime && chrome.runtime.onConnect) {
                // Establish a listener to open ports.
                if (!observeLinks.listening) {
                    const ports = observeLinks.ports = new Set
                    const ltr = p => {
                        if (p.name !== 'directLinkAct') return
                        ports.add(p)
                        p.onDisconnect.addListener(p => ports.delete(p))
                    }
                    chrome.runtime.onConnect.addListener(ltr)
                    if (!ports) ports = new Set
                    RCV.onClose.push(() => chrome.runtime.onConnect.removeListener(ltr))
                    observeLinks.listening = true
                }
                // Send actions as a message. (port.sender.frameId could have helped distinguish <iframe>s.)
                observeLinks.ports.forEach(port => port.postMessage(act64))
            } else if (typeof window._directLinkAct == 'function')
                window._directLinkAct(act64)

            // Receive our observations from the content script.
            const result = await end()
            if (typeof result != 'string') return resizeObs(0)
            const res = result.split(' ')
            try {
                const actLen = +res[0] || 0, obsLen = fromBinStr(atob(res[1] || ''), obs)
                resizeObs(obsLen)
                return [obsLen, actLen]
            } catch (err) { typeof PRINT == 'function' && PRINT(err.stack), resizeObs(0) }
            function resizeObs(obsLen) {
                if (!RCV.obsLen) RCV.obsLen = 0
                if (RCV.obsLen !== obsLen) { // Resize extension's observations ourselves.
                    const L = RCV.obs.length + obsLen - RCV.obsLen, old = RCV.obs.subarray(0, L)
                    RCV.obs = new RCV.obs.constructor(L)
                    RCV.obs.set(old)
                    RCV.obsLen = obsLen
                }
            }
            function fromBinStr(s, into) {
                const b = new Uint8Array(into.buffer, into.byteOffset, into.byteLength)
                const end = s.length - (s.length % into.BYTES_PER_ELEMENT)
                for (let i = 0; i < b.length && i < end; ++i) b[i] = s.charCodeAt(i)
                return s.length / into.BYTES_PER_ELEMENT | 0
            }
            function toBinStr(b) {
                let s = '', d = Object.create(null)
                for (let i = 0; i < b.length; ++i) s += d[b[i]] || (d[b[i]] = String.fromCharCode(b[i]))
                return s // The loop above is optimized by JS engines, so no quadratic time/space complexity.
            }
        }],
        inject: [function injLinks(script) {
            if (!injLinks.inited) {
                // Do stuff on init: inject <script> for JS interaction, and set up port/event listeners.
                const scr = document.createElement('script')
                scr.textContent = script
                document.documentElement.append(scr)
                setTimeout(() => scr.remove(), 30000) // Removing immediately seems to not be 100% stable.
                if (!window._directLinkAct) {
                    window._directLinkAct = function a(a64, sender, sendResponse) {
                        window._directLinkAct.a64 = a64, sendResponse && sendResponse()
                        return true
                    }
                    document.addEventListener('_directLinkObs', evt => {
                        if (typeof evt.detail != 'string') return
                        window._directLinkAct.obsMsg = evt.detail !== '0 ' ? evt.detail : undefined // `${actLen} ${obs64}`
                    })
                }
                if (typeof chrome != ''+void 0 && chrome.runtime && chrome.runtime.connect) {
                    if (window._directLinkPort) window._directLinkPort.disconnect(), window._directLinkPort = undefined
                    ;(window._directLinkPort = chrome.runtime.connect({ name:'directLinkAct' })).onMessage.addListener(window._directLinkAct)
                }
                injLinks.inited = true
            }
            // Post actions.
            document.dispatchEvent(new CustomEvent('_directLinkAct', { detail:window._directLinkAct.a64 }))
            try {
                return window._directLinkAct.obsMsg || ''
            } catch (err) { console.error(err) }
        }, script],
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
        agent(stream, {obs, pred, act}) {
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
    const DX = Symbol('scrollDX'), DY = Symbol('scrollDY')
    return [observers, {
        writes:2,
        write(stream, pred, act) {
            const dx = Math.round(sensitivity * Math.max(-1, Math.min(act[0], 1)))
            const dy = Math.round(sensitivity * Math.max(-1, Math.min(act[1], 1)))
            stream[DX] = dx, stream[DY] = dy
        },
        inject: [(dx, dy) => scrollBy(dx, dy), s => s[DX], s => s[DY]],
    }]
})



exports.interval = docs(`\`webenv.interval(trigger, sec = 60)\`
Runs a trigger's start on an interval, with the stream as the arg (for example, use \`webenv.triggers.homepage\`, especially if that opens a random page).
Training-only (Puppeteer-only).
`, function(trigger, sec = 60) {
    let id = null
    return {
        init(stream) { clearInterval(id), id = setInterval(trigger.start, sec*1000, stream) },
        deinit(stream) { clearInterval(id), id = null },
    }
})



exports.triggers = docs(`\`webenv.triggers({ threshold=.5, restartOnNewPage=true, maxAtOnce=0, cooldown=0, priority=0 }, ...triggers)\`

Exposes a group of triggers, such as keys on a keyboard: actions which \`start\` when over \`threshold\` and \`stop\` when under \`threshold\`.

Each trigger is \`{ start, stop,  injectStart, injectStop }\`, all functions if defined.
(\`start\`/\`stop\` are functions if defined. \`injectStart\`/\`injectStop\` are arrays, where the first item is the funcs and the rest are its args; try to keep args static.)
For example: \`webenv.triggers({ maxAtOnce:1, cooldown:600 }, {start(stream) { stream.page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ') }})\`
The cooldown is in agent steps, not real time.
`, function triggersModule(opt, ...triggers) {
    if (!Array.isArray(triggers)) throw new Error('Not an array')
    const key = triggersModule.key || (triggersModule.key = Symbol('triggers'))
    const opts = Object.assign({
        threshold: .5,
        restartOnNewPage: true,
        maxAtOnce: 0,
        cooldown: 0,
    }, opt || {})
    return {
        init(stream) {
            const p = stream.page
            if (!opts.restartOnNewPage || !p) return
            const mainFrame = p.mainFrame()
            p.on('framenavigated', frame => frame === mainFrame && reset(stream))
            p.on('domcontentloaded', () => reset(stream))
        },
        priority: typeof opt.priority == 'number' ? opt.priority : 0,
        writes:triggers.length,
        write(stream, pred, act) { trigger(triggers, opts, act, stream) },
        inject: getCodeToInject(),
    }
    function Spot(o) { return o[key] || (o[key] = Object.create(null)) }
    function reset(stream) {
        const spot = Spot(stream)
        spot.prev && spot.prev.fill(0)
    }
    function trigger(tr, opts, act, stream) {
        const spot = Spot(stream)
        if (!spot.prev) {
            spot.prev = new Uint8Array(tr.length)
            spot.next = new Uint8Array(tr.length)
            spot.sorted = new Float32Array(tr.length)
            spot.framesUntilReady = new Uint32Array(opts.maxAtOnce || tr.length)
        }
        const { prev, next, sorted, framesUntilReady } = spot
        const { threshold, maxAtOnce, cooldown } = opts
        let oldThr = threshold, oldMax = maxAtOnce || tr.length
        let newThr = threshold, newMax = maxAtOnce || tr.length
        // Disallow new triggers when we don't have enough cooled-down slots.
        if (cooldown) {
            let free = 0
            for (let j = 0; j < framesUntilReady.length; ++j)
                if (framesUntilReady[j] === 0) ++free
            newMax = Math.min(newMax, free)
        }
        // Handle `maxAtOnce`.
        if (oldMax < tr.length || newMax < tr.length) {
            sorted.set(act), sorted.sort()
            oldThr = Math.max(oldThr, oldMax ? sorted[sorted.length - oldMax] : Infinity)
            newThr = Math.max(newThr, newMax ? sorted[sorted.length - newMax] : Infinity)
        }
        // Read what is triggered.
        if (oldMax > 0)
            for (let i = 0; i < tr.length; ++i)
                next[i] = act[i] >= (prev[i] ? oldThr : newThr) ? 1 : 0
        else next.fill(0)
        // Allocate new triggers, and cooldown.
        if (cooldown) {
            let newTriggers = 0
            for (let i = 0; i < tr.length; ++i)
                if (!prev[i] && next[i]) ++newTriggers
            for (let j = 0; j < framesUntilReady.length; ++j)
                if (framesUntilReady[j] === 0)
                    newTriggers && (framesUntilReady[j] = cooldown, --newTriggers)
                else --framesUntilReady[j]
        }
        // Un/trigger.
        for (let i = 0; i < tr.length; ++i)
            if (!prev[i] && next[i] && tr[i].start) tr[i].start(stream)
            else if (prev[i] && !next[i] && tr[i].stop) tr[i].stop(stream)
        prev.set(next)
    }
    async function getCodeToInject() {
        let hasInjected = false
        const bods = [], args = []
        for (let t of triggers) {
            const iStart = await t.injectStart, iStop = await t.injectStop
            const argInds = []
            if (iStart || iStop) hasInjected = true
            bods.push((iStart || iStop) ? {
                start: iStart && (''+iStart[0]),
                stop: iStop && (''+iStop[0]),
                args: argInds,
            } : null)
            const subargs = [
                ...(Array.isArray(iStart) ? iStart.slice(1) : []),
                ...(Array.isArray(iStop) ? iStop.slice(1) : []),
            ]
            if (subargs.length)
                argInds.push(...subargs.map((_,i) => args.length+i)),
                args.push(...subargs)
        }
        if (!hasInjected) return
        return [
            // There's no observer→inject communication, so we use webenv→inject (JSON).
            `function f(triggerBodies, ...active) {
                if (!f.triggers) {
                    f.triggers = triggerBodies.map(t => t ? {
                        start:t.start && new Function('return '+t.start)(),
                        stop:t.stop && new Function('return '+t.stop)(),
                        args: t.args,
                    } : null)
                    f.prev = new Uint8Array(triggerBodies.length)
                    f.next = new Uint8Array(triggerBodies.length)
                    f.argsLen = triggerBodies.reduce((s,t) => t ? s+t.args.length : s, 0)
                }
                const prev = f.prev, next = f.next, tr = f.triggers
                const args = active.splice(0, f.argsLen)
                for (let i = 0; i < tr.length; ++i) // Access i-th bit.
                    next[i] = (active[i/32|0] >>> (i%32)) & 1
                for (let i = 0; i < tr.length; ++i)
                    if (tr[i] && tr[i].start && !prev[i] && next[i]) tr[i].start(...tr[i].args.map(a=>args[a]))
                    else if (tr[i] && tr[i].stop && prev[i] && !next[i]) tr[i].stop(...tr[i].args.map(a=>args[a]))
                prev.set(next)
            }`,
            bods,
            ...args,
            // Encode Spot(stream).next in u32 numbers, to not be TOO egregious with bandwidth.
            ...(new Array(Math.ceil(triggers.length / 32)).fill().map(streamTrigger)),
        ]
        function streamTrigger(_,at) {
            const fn = stream => {
                // Not completely sure whether 32th bit gets encoded correctly.
                const spot = Spot(stream)
                if (!spot.next) return 0
                let n = 0
                for (let i = at*32; i < triggers.length && i < (at+1)*32; ++i)
                    n |= (spot.next[i] & 1) << (i%32)
                if (opts.cooldown) spot.next.fill(0) // No "infinite `randomLink`" miracles.
                return n
            }
            const str = ''+fn
            fn.toString = () => str + '\n// ' + Math.random() + ' ' + Math.random()
            // No merging in `compileSentJS`.
            //   (Yes, very annoying, and very hard to debug. But so convenient for non-closures.)
            return fn
        }
    }
})



exports.triggers.homepage = docs(`\`webenv.triggers({}, webenv.triggers.homepage)\`
Back to homepage, please.
Training-only (Puppeteer-only): users should not be asked to sample random web pages, or look at the datasets.
`, {
    start(stream) {
        if (!stream.page) return
        stream.mouseX = stream.settings.width/2 | 0
        stream.mouseY = stream.settings.height/2 | 0 // Center the mouse too.
        return stream.page.goto(stream.settings.homepage || 'about:blank', {waitUntil:'domcontentloaded'}).catch(doNothing)
    },
})



exports.triggers.goBack = docs(`\`webenv.triggers({}, webenv.triggers.goBack)\`
Back to the previous page, please.
`, {
    injectStart: [function() {
        if (performance.now() < 10000) return // Don't navigate TOO frequently.
        typeof chrome != ''+void 0 && chrome.runtime && history.go(-1)
    }],
})



exports.triggers.randomLink = docs(`\`webenv.triggers({}, webenv.triggers.randomLink)\`
Picks a random file: or http: or https: link on the current page, and follows it.
`, {
    injectStart: [function() {
        if (typeof chrome == ''+void 0 || !chrome.runtime) return // Extension-only.
        if (performance.now() < 10000) return // Don't navigate TOO frequently.

        let place = ''+location.href, i = place.lastIndexOf('#')
        if (i >= 0) place = place.slice(0, i) // `URL#ID` → `URL`
        let urls = [...document.documentElement.querySelectorAll('a')].map(a => a.href)
        urls = urls.filter(u => {
            // Relative links are already resolved by .href.
            if (u.slice(0, place.length) === place && u[place.length] === '#') return false
            if (u.slice(0,7) === 'file://') return true
            if (u.slice(0,7) === 'http://') return true
            if (u.slice(0,8) === 'https://') return true
        })
        if (!urls.length) return
        location.href = urls[Math.random() * urls.length | 0]
    }],
})



exports.keyboard = docs(`\`webenv.keyboard(Options={maxAtOnce:3}, Keys='...')\`
Exposes the keyboard as actions. https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values
For more details on \`Options\`, see \`webenv.triggers\`.
\`Keys\` is a space-separated string of keys or \`'Space'\`. (Shift does not modify keys, so, with-Shift versions have to be manually included.)
`, function keyboard(opt = {maxAtOnce:3}, kb = 'Alt Control Shift Enter Tab Space ArrowDown ArrowLeft ArrowRight ArrowUp End Home PageDown PageUp Backspace Delete Escape ` ~ 1 2 3 4 5 6 7 8 9 0 ! @ # $ % ^ & * ( ) q w e r t y u i o p [ ] \\ a s d f g h j k l ; \' z x c v b n m , . / Q W E R T Y U I O P { } | A S D F G H J K L : " Z X C V B N M < > ?') {
    const keys = kb.split(' ').map(k => k === 'Space' ? ' ' : k)
    const info = require('puppeteer/lib/cjs/puppeteer/common/USKeyboardLayout.js').keyDefinitions
    return exports.triggers(
        opt,
        ...keys.map(k => {
            const desc = info[k]
            const down = keyOpts(desc, 'down'), up = keyOpts(desc, 'up')
            const desc2 = { ...desc, bubbles:true, cancelable:true, composed:true }
            return {
                start: stream => CDP(stream, down),
                stop: stream => CDP(stream, up),
                injectStart: [
                    (puppet, desc, txt) => {
                        if (puppet) return
                        const t = document.activeElement || document.body
                        t.dispatchEvent(new KeyboardEvent('keydown', desc))
                        txt && t.dispatchEvent(new InputEvent('beforeinput', { data:txt, bubbles:true, cancelable:true, composed:true }))
                        txt && t.dispatchEvent(new InputEvent('input', { data:txt, bubbles:true, cancelable:true, composed:true }))
                        // Text-insertion has to be manual.
                        //   `execCommand` is deprecated, but works nicely.
                        //   Why is everything nice deprecated?
                        desc.key==='Backspace' && document.execCommand('delete', false, '')
                        desc.key==='Delete' && document.execCommand('forward-delete', false, '')
                        txt && document.execCommand('insertText', false, txt)
                    },
                    stream => stream.cdp ? 1 : 0,
                    desc2,
                    desc.key.length === 1 ? desc.key : '',
                ],
                injectStop: [(puppet, desc) => {
                    if (puppet) return
                    const t = document.activeElement || document.body
                    t.dispatchEvent(new KeyboardEvent('keyup', desc))
                }, stream => stream.cdp ? 1 : 0, desc2],
            }
        }),
    )
    function CDP(stream, opts) {
        if (!stream.cdp) return
        stream.cdp.send('Input.dispatchKeyEvent', opts).catch(doNothing)
    }
    function keyOpts(desc, type) { // type: down|up
        const text = desc.key.length === 1 ? desc.key : ''
        return {
            type: type==='down' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
            windowsVirtualKeyCode: desc.keyCode || 0,
            code: desc.code, key: desc.key,
            text, unmodifiedText: text,
            location: desc.location || 0,
        }
    }
})



exports.mouse = docs(`\`webenv.mouse(Options)\`
Exposes all mouse-related actions.
\`Options\` is, by default, \`{ left=true, right=false, middle=false, wheel=0, absolute=true, relative=0 }\`.
    \`relative\` specifies the max fraction of screen-space that one action can move the mouse by.
    \`wheel\` specifies the max CSS pixels for one action.

(If \`absolute\`: neural networks have trouble distinguishing per-pixel differences in page offsets, so a non-learned loss makes predictions very blurry, even when the RNN has settled into a point-like attractor.)
`, function(opt = {}) {
    const triggers = [], inters = []
    const wheel = opt.wheel && typeof opt.wheel == 'number'
    const absolute = opt.absolute !== false
    const relative = opt.relative && typeof opt.relative == 'number'
    const L = opt.left !== false, R = opt.right === true, M = opt.middle === true
    let injected
    if (wheel || absolute || relative)
        inters.push({
            init(stream) {
                stream.mouseX = stream.settings.width/2 | 0
                stream.mouseY = stream.settings.height/2 | 0
                if (!stream.cdp) {
                    injected([
                        `function mouse(x,y,dx,dy) {
                            if (!mouse.page) {
                                ${mouseEventInit}
                                mouse.page = ${page}
                            }
                            const p = mouse.page
                            const t = document.elementFromPoint(x,y) || document.documentElement
                            if (x!==mouse.x || y!==mouse.y) p(t, 'move', 0, mouse.x=x, mouse.y=y)
                            if (dx || dy) p(t, 'wheel', 0, x, y, dx, dy)
                            ${L||R||M ? "const start = ~mouse.b & window.$_mouse, stop = mouse.b & ~window.$_mouse" : ''}
                            ${L ? "start&1 && p(t, 'down', 1, x, y)" : ''}
                            ${R ? "start&2 && p(t, 'down', 2, x, y)" : ''}
                            ${M ? "start&4 && p(t, 'down', 4, x, y)" : ''}
                            ${L ? "stop&1 && p(t, 'up', 1, x, y)" : ''}
                            ${R ? "stop&2 && p(t, 'up', 2, x, y)" : ''}
                            ${M ? "stop&4 && p(t, 'up', 4, x, y)" : ''}
                            ${L||R||M ? "mouse.b = window.$_mouse|0" : ''}
                        }`,
                        s => s.mouseX,
                        s => s.mouseY,
                        wheel ? (s => s.deltaX || 0) : 0,
                        wheel ? (s => s.deltaY || 0) : 0,
                    ])
                } else injected()
            },
            writes:6,
            write(stream, pred, act) {
                for (let i=0; i < act.length; ++i) act[i] = Math.max(-1, Math.min(act[i], 1))
                let x = stream.mouseX || 0, y = stream.mouseY || 0
                if (wheel) {
                    const dx = act[0] * opt.wheel, dy = act[1] * opt.wheel
                    stream.deltaX = dx, stream.deltaY = dy
                }
                if (absolute) {
                    const ax = act[2], ay = act[3]
                    x = (ax + 1) * .5 * (stream.settings.width-1) | 0
                    y = (ay + 1) * .5 * (stream.settings.height-1) | 0
                }
                if (relative) {
                    const ax = act[4] * opt.relative, ay = act[5] * opt.relative
                    x += ax, y += ay
                }
                x = Math.max(0, Math.min(x, stream.settings.width-1)) | 0
                y = Math.max(0, Math.min(y, stream.settings.height-1)) | 0
                stream.mouseX = x, stream.mouseY = y
                if (stream.deltaX || stream.deltaY)
                    CDP(stream, 'wheel', 0, dx, dy)
                if (x !== stream.mouseX || y !== stream.mouseY)
                    CDP(stream, 'move', 0)
            },
            inject: new Promise(then => injected=then)
        })
    if (L) triggers.push(triggerFor(1))
    if (R) triggers.push(triggerFor(2))
    if (M) triggers.push(triggerFor(4))
    if (triggers.length) inters.push(exports.triggers({...opt, priority:-2, threshold:0}, ...triggers))
    return inters
    function triggerFor(btn) {
        return {
            start: stream => CDP(stream, 'down', btn),
            stop: stream => CDP(stream, 'up', btn),
            injectStart: [`() => window.$_mouse = window.$_mouse|${btn}`],
            injectStop: [`() => window.$_mouse = window.$_mouse&~${btn}`],
        }
    }
    function CDP(stream, type, button, deltaX, deltaY) { // type: down|up|move|wheel
        if (!stream.cdp) return
        if (!CDP.table) CDP.table = { down:'mousePressed', up:'mouseReleased', move:'mouseMoved', wheel:'mouseWheel' }
        const pressed = type==='down' ? true : type==='up' ? false : null
        const opts = mouseEventInit(CDP, CDP.table[type], stream.mouseX, stream.mouseY, button, pressed, deltaX, deltaY)
        stream.cdp.send('Input.dispatchMouseEvent', opts).catch(doNothing)
    }
    function page(target, type, button, x, y, deltaX, deltaY) { // type: down|up|move|wheel
        // Not at all an exact re-implementation of how browsers work.
        //   Wanna contribute?
        if (!page.table) page.table = {
            down:['mousedown', 'pointerdown'],
            up:['mouseup', 'click', 'pointerup'],
            move:['mousemove', 'pointermove'],
            wheel:['wheel'],
        }
        const pressed = type==='down' ? true : type==='up' ? false : null
        for (let T of page.table[type]) {
            const opts = mouseEventInit(page, 'mouse', x, y, button, pressed, deltaX, deltaY)
            target.dispatchEvent(new (type === 'wheel' ? WheelEvent : MouseEvent)(T, opts))
        }
    }
    function mouseEventInit(s, type, x, y, button, pressed, deltaX=0, deltaY=0) {
        if (!s.cur) s.cur = 0
        if (pressed === true) s.cur |= button
        const result = {
            type,
            deltaX, deltaY,
            x, y, clientX: x, clientY: y,
            button: button===1 ? 'left' : button===2 ? 'right' : button===4 ? 'middle' : 'none',
            buttons: s.cur,
            clickCount: 1, detail: 1,
            bubbles:true, cancelable:true, composed:true,
        }
        if (pressed === false) s.cur &= ~button
        return result
    }
})



exports.frameTime = docs(`\`webenv.frameTime(fps = 20, maxMs = 1000)\`
Provides an observation of the time between frames, relative to the expected-Frames-Per-Second duration, in (less-than-1) multiples of \`maxMs\`.
`, function(fps = 20, maxMs = 1000) {
    let prevFrame = performance.now()
    return {
        reads:1,
        async read(stream, obs, end) {
            const nextFrame = performance.now()
            const duration = (nextFrame - prevFrame) - 1 / fps
            prevFrame = nextFrame
            await end()
            obs[0] = Math.max(-1, Math.min(duration / maxMs, 1))
        },
        visualize: [function(elem, obs, pred, period) {
            if (!elem.firstChild) {
                elem.appendChild(document.createElement('div'))
                Object.assign(elem.firstChild.style, {
                    width:'1.2em',
                    height:'1.2em',
                    borderRadius:'50%',
                    display:'inline-block',
                    verticalAlign:'bottom',
                })
                elem.appendChild(document.createElement('div'))
                Object.assign(elem.lastChild.style, {
                    fontFamily:'monospace,monospace',
                    whiteSpace:'pre',
                    display:'inline-block',
                    verticalAlign:'bottom',
                })
                elem.frame = false
            }
            const fps = 1000 / period
            elem.firstChild.style.backgroundColor = (elem.frame = !elem.frame) ? 'lightgray' : 'darkgray'
            elem.lastChild.textContent = ' ' + fps.toFixed(1) + ' FPS'
        }, s => +s.env._period],
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
        init(stream) {
            stream.cdp && stream.cdp.on('Emulation.virtualTimeBudgetExpired', resolveFrame)
        },
        deinit(stream) {
            stream.cdp && stream.cdp.off('Emulation.virtualTimeBudgetExpired', resolveFrame)
        },
        async read(stream, obs, end) {
            if (!stream.cdp) return
            // Break pipelining if frames are taking too long.
            const p = prevFrame;  prevFrame = new Promise(then => prevThen = then);  p && (await p)
            stream.cdp.send('Emulation.setVirtualTimePolicy', {
                policy:'advance', budget
            }).catch(doNothing)
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
        init(stream) {
            const p = stream.page
            if (!p) return
            if (p.cache !== undefined) throw new Error('There can only be one .filter')
            p.cache = cache
            mainPage = p
            p.setRequestInterception(true)
            p.on('request', modifyReq)
        },
        deinit(stream) {
            const p = stream.page
            if (!p) return
            p.off('request', modifyReq)
            p.setRequestInterception(false)
            mainPage = undefined
            p.cache = undefined
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
    let Stream = null, lastStamp = performance.now(), intervalID = null, readyState = 'void'
    return {
        async init(stream) {
            if (!stream.cdp || !stream.browser) return
            Stream = stream // For events.
            await stream.cdp.send('Page.enable')
            await stream.cdp.send('Page.setDownloadBehavior', { behavior:'deny' }) // Deprecated, but so much better.
            stream.cdp.send('Page.setAdBlockingEnabled', { enabled:true })
            stream.browser.on('targetcreated', onNewTarget)
            stream.page.on('dialog', onDialog)
            stream.page.on('popup', onPopup)
            let expectedPage = stream.page
            ;(function waitMore(ch) {
                ch && typeof ch.cancel == 'function' && ch.cancel()
                if (stream.page !== expectedPage) return
                expectedPage = stream.page
                // With the default timeout,
                //   closing and auto-reopening the browser causes an infinite loop in Puppeteer internals.
                stream.page.waitForFileChooser({ timeout:0 }).then(waitMore, waitMore)
            })()
            deleteCookies && stream.page.on('load', noCookies)
            deleteCookies && stream.page.on('framenavigated', noCookies)
            clearInterval(intervalID), intervalID = setInterval(maybeCloseBrowser, timeout*(1000/2), stream)
            readyState = 'initialized'
        },
        async deinit(stream) {
            if (!stream.cdp || !stream.browser) return
            clearInterval(intervalID), intervalID = null
            deleteCookies && stream.page.off('framenavigated', noCookies)
            deleteCookies && stream.page.off('load', noCookies)
            stream.page.off('popup', onPopup)
            stream.page.off('dialog', onDialog)
            stream.browser.off('targetcreated', onNewTarget)
            stream.cdp.send('Page.setAdBlockingEnabled', { enabled:false })
            await stream.cdp.send('Page.disable')
        },
        read(stream, obs, end) {
            if (!stream.cdp || !stream.browser) return
            if (stream.page.isClosed() || !stream.browser.isConnected())
                return lastStamp = performance.now()
            if (!(Math.random() < .01) && performance.now() - lastStamp < timeout*(1000/2)) return
            // Discard console entries, and try to evaluate some JS;
            //   if it takes too long, re-launch the browser.
            //   (Re-launching can spam the console with unhandled promise rejection warnings.)
            stream.cdp.send('Runtime.discardConsoleEntries').catch(doNothing)
            if (timeout)
                stream.page.evaluate(() => 0).then(() => lastStamp = performance.now()).catch(doNothing)
            if (readyState === 'initialized') readyState = 'ready'
        },
    }
    function maybeCloseBrowser(stream) {
        if (!timeout || readyState !== 'ready' || performance.now() - lastStamp <= timeout*1000) return
        readyState = 'void'
        lastStamp = performance.now()
        stream && stream.browser && stream.browser.isConnected() && stream.browser.close()
    }
    function onPopup(newPage) {
        // A new tab opens up.
        // Tab capture is still capturing the old tab, so redirect newcomers to the old tab.
        const newURL = newPage.url()
        newPage.close()
        try {
            Stream.page && newURL && Stream.page.goto(newURL, {waitUntil:'domcontentloaded'}).catch(doNothing)
        } catch (err) { console.error('Bad URL of a popup:', newURL) }
    }
    function onDialog(dial) {
        // Who cares about questions and answers,
        //   dialogs are outdated UI that we refuse to re-implement numerically.
        dial.dismiss()
    }
    async function noCookies() {
        if (!Stream.page || Stream.page.isClosed()) return
        try {
            await Stream.page.deleteCookie(...(await Stream.page.cookies()))
        } catch (err) {}
    }
    function onNewTarget() {
        lastStamp = performance.now()
        if (!Stream.browser) return
        closeAllPagesExcept(Stream.browser, Stream.page)
    }
})
async function closeAllPagesExcept(browser, page) {
    if (!browser || !page) return
    const bad = browser.targets().filter(t => t.type() === 'page' && t !== page.target()).map(t => t.page())
    for (let p of bad) (await p).close().catch(doNothing)
}
function doNothing() {}



exports.augmentations = docs(`\`webenv.augmentations(severity = 1, transition = 2)\`
Some DOM-aware image augmentations: random transforms and filters.
\`severity\` is the multiplier for many effects.
\`transition\` is the max duration of smooth transitions in seconds.

(This makes every frame open-ended. Losses that average outcomes would blur all predictions a little; plausibility-maximizing losses would not.)
`, function(severity = 1, transition = 2) {
    return {
        inject: [async function aug(severity, transition) {
            while (!document.body)
                await new Promise(requestAnimationFrame)
            // There's no "deinit" in injection, but we can simulate that by stopping if we were not called for 2s+.
            aug.cancel && clearTimeout(aug.cancel)
            aug.cancel = setTimeout(() => aug.augment && clearTimeout(aug.augment, aug.augment = null), 2000)
            if (!aug.augment) startAugment()
            function startAugment() {
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
                function augmentLater() {
                    aug.augment = setTimeout(augment, Math.random() * 1000 * (1/severity))
                }
                function augment() {
                    // Apply a random augmentation to a random element, then repeat.
                    augmentLater()
                    const el = randomElem()
                    if (!el || !el.style) return
                    const aug = randomAug()
                    const prop = Object.keys(aug)[0]
                    if (el.style[prop] || el.style.transition) return
                    el.style.setProperty(prop, aug[prop])
                    const duration = Math.random() * transition
                    if (duration) el.style.setProperty('transition', `${prop} ${duration}s`)
                    setTimeout(() => {
                        el.style.removeProperty(prop)
                        if (duration)
                            setTimeout(() => el.style.removeProperty('transition'), duration * 1000)
                    }, Math.random() * 10000 * severity)
                }
                function one(a) {
                    return typeof a == 'number' ? Math.floor(Math.random() * a) : a[one(a.length)]
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
                function px() { return Math.random()*50*severity + 'px' }
                function rad() { return (Math.random()-.5)*2*Math.PI*severity  + 'rad' }
                function num() { return (Math.random()-.5)*3*severity + '' }
                function smallPx() { return Math.random()*10*severity + 'px' }
                function smallPerc() { return Math.random()*severity*100 + '%' }
                function perc() { return Math.random()*2*severity*100 + '%' }
            }
        }, severity, transition],
    }
})



exports.directScore = docs(`\`webenv.directScore(hidden=false, store={}, maxHorizon=100000, name='directScore')\`

Exposes a function that allows web pages to rate the agent's performance with a number, the higher the better: \`typeof directScore=='function' && directScore(x)\`.

The agents can access the normalized-to-\`-1\`…\`1\` \`obs[0]\` unless \`hidden\`, and model & maximize it. (Normalized so that there is no preference among pages, only for in-page performance. And to be in a sane range.)

SHA-256 hashes of URLs are reported to the server (for normalization), for as much privacy as possible (though a rainbow table is trivial to construct from web crawl indices).

Args:
- \`hidden\`: if \`false\`, exposes \`4\` numbers to the agent at the beginning: 0th is the average score since the last frame or \`NaN\`; the others are always-\`NaN\` scratch-space for agents.
- \`maxHorizon\`: approximately how many most-recent samples to average over.
- \`store\`: the database of URL→momentums.
    - It is either \`{ scoreFile='', saveInterval=300, maxUrls=1000000 }\` for simple JSON-saving every 300 seconds, or
    - exposes the interface \`{ get(k)→v, set(k, v→v), open(), close() }\`.
    - (If you run many WebEnv instances, then you need one explicit database here.)
- \`name\`: the name of the exposed-to-pages function.
`, async function directScore(hidden=false, store={}, maxHorizon=100000, name='directScore') {
    const maxRawMagnitude = 1e9
    if (!store || !store.get || !store.set || !store.open || !store.close) store = jsonSaving(store || {})
    store = await store
    const key = directScore.key || (directScore.key = Symbol('directScore'))
    const script = `
if (!window.${name}) window.${name} = function(score) {
    if (typeof score != 'number' || score!==score) return false
    return document.dispatchEvent(new CustomEvent('_directScore', { detail:score })), true
}`
    return {
        priority: 999999999,
        reads: hidden ? undefined : 4,
        async reactToObserver(stream, result) {
            const spot = Spot(stream)
            if (typeof result == 'string' && result.length < 128) {
                spot.url = result
            } else if (typeof result == 'number' && result === result) {
                const u = spot.url || ''
                const v = Math.max(-maxRawMagnitude, Math.min(result, maxRawMagnitude))
                const norm = signalNormalize(v, await store.get(u))
                // Update the page's reward-stream statistics, and cross-page improvement.
                store.set(u, mom => signalUpdate(v, mom, maxHorizon))
                store.set('ALL', mom => signalUpdate(norm, mom, maxHorizon))
                spot.score = norm
            }
        },
        observer: [function observeScore(media, io, end) {
            return end()
        }],
        inject: [function inj(script) {
            if (!inj.did) {
                // Inject a <script>, and listen for its executions.
                const scr = document.createElement('script')
                scr.textContent = script
                document.documentElement.append(scr)
                setTimeout(() => scr.remove(), 30000) // Removing immediately seems to not be 100% stable.
                inj.sum = inj.num = 0
                if (window._directScoreListener) document.removeEventListener('_directScore', window._directScoreListener)
                document.addEventListener('_directScore', window._directScoreListener = evt => {
                    if (typeof evt.detail == 'number') inj.sum += evt.detail, ++inj.num
                })
                inj.init = 0
                inj.did = true
            }
            if (inj.init++ < 5) return url() // On navigations, report URL. (Many times, just in case communication is unreliable.)
            if (!inj.num) {
                if (Math.random() < .001) return url()
                return null
            }
            try { return inj.sum / inj.num }
            finally { inj.sum = inj.num = 0 }
            async function url(s = ''+location.href) {
                if (s.indexOf('#') >= 0) s = s.slice(0, s.indexOf('#'))
                if (typeof crypto != ''+void 0) { // Hash, so that server-side can't *easily* know real URLs.
                    const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('url is ' + s + ' so yeah')))
                    let bin = '';  for (let i=0; i < b.length; ++i) bin += String.fromCharCode(b[i])
                    return btoa(bin)
                } else { // Really limit URL length. Collisions are not that important.
                    s = s.slice(0,128)
                    if (JSON.stringify(s).length > 256) s = s.slice(0,32)
                    return s
                }
            }
        }, script],
        async read(stream, obs, end) {
            const spot = Spot(stream)
            const norm = +spot.score
            if (!hidden) await end(), obs[0] = norm
        },
        init(stream) { store.open() },
        deinit(stream) { store.close() },
        visualize: !hidden ? [function(elem, obs, pred) {
            elem.textContent = `Score: ${obs[0].toFixed(2)} real | ${pred[0].toFixed(2)} predicted`
            elem.style.fontFamily = 'monospace, monospace'
        }] : undefined,
    }
    function Spot(o) { return o[key] || (o[key] = Object.create(null)) }
    async function jsonSaving({ scoreFile='', saveInterval=300, maxUrls=1000000 }) {
        const fs = require('fs/promises')
        let data = Object.create(null) // Running-average scores.
        if (scoreFile)
            try { data = JSON.parse(await fs.readFile(scoreFile, { encoding:'utf8' })) }
            catch (err) {}
        let timeoutID = null, active = 0, updated = false
        return {
            open() { !active++ && (timeoutID = setTimeout(saveData, saveInterval*1000)) },
            close() { !--active && saveData(true) },
            get(k) {
                return data[k]
            },
            set(k, update) {
                updated = true
                data[k] = update(data[k])
            },
        }
        async function saveData(stop = false) {
            limitURLCount()
            const prevID = timeoutID
            timeoutID = null
            if (scoreFile && updated && prevID != null) {
                updated = false
                if (n) await fs.writeFile(scoreFile, JSON.stringify(data), { encoding:'utf8' })
            }
            if (stop) clearTimeout(prevID)
            else timeoutID = setTimeout(saveData, saveInterval*1000)
        }
        function limitURLCount() {
            const size = Object.keys(data).length
            const delta = size - (maxUrls+1)
            if (delta <= 0) return
            const keys = Object.keys(data)
            for (let i = 0; i < delta; ++i) {
                let u = null, pop = 0
                for (let j = 0; j < 3; ++j) { // Try to pick some unpopular URL.
                    const u2 = keys[Math.random() * keys.length | 0]
                    if (!data[u2] || u2 === 'ALL') continue
                    if (u == null || data[u2][0] < pop) u = u2, pop = data[u2][0]
                }
                if (u != null) delete data[u] // And kill it.
            }
        }
    }
})



exports.fetchSlice = docs(`\`webenv.fetchSlice()\`
This replaces a dataset server for \`file:\` pages, for convenience. Puppeteer-only.

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
        init(stream) {
            if (!stream.page) return
            return stream.page.exposeFunction('_fetchLocalFileSlice', async function(url, start = 0, end = null) {
                if (!stream.page) return ''
                if (stream.page.url().slice(0,7) !== 'file://')
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
                    throw new Error('Max slice size is 20MB, so slice up your slice')
                const resolved = new URL(url, stream.page.url())
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



exports.userAgent = docs(`\`webenv.userAgent(agent = 'WebEnv agent <https://github.com/Antipurity/webenv>')\`
Specifies the User-Agent string.
Identify yourself and include contact information to overcome some of the prejudice against bots on the Web: https://www.w3.org/wiki/Bad_RDF_Crawlers
`, function(agent = 'WebEnv agent <https://github.com/Antipurity/webenv>') {
    return {
        init(stream) {
            return stream.page && stream.page.setExtraHTTPHeaders({ 'User-Agent': agent })
        },
    }
})



exports.settings = docs(`\`webenv.settings(settings)\`
Defines settings.
These include:
- \`homepage:'about:blank'\`: the URL to open a browser window to. (For example, set it to the RandomURL dataset.)
- \`simultaneousSteps:16\`: how many steps are allowed to run at once (at most). Set to \`1\` to fully synchronize on each step, which makes visualization nicer but introduces a lot of stalling.
- If for \`webenv.browser\`, \`width:640\` and \`height:480\`.
- If for \`webenv.browser\`, \`userProfile\`, which is a function from stream to the user profile directory. The default is \`webenv/puppeteer-chrome-profile-INDEX\`.
- \`port:1234\` and \`httpsOptions:null\`: the server's options.
    - Optionally, specify key and certificate in \`httpsOptions\`, as in https://nodejs.org/en/knowledge/HTTP/servers/how-to-create-a-HTTPS-server/
- \`hidePredictions:false\`: whether extensions cannot see predictions (to really cut off all copyright complaints).
`, function(settings) { return { settings } })



exports.browser = docs(`\`webenv.browser(...interfaces)\`
Creates a data stream from a 'Puppeteer'ed browser.

Without interfaces, this is useless.
All other members of this module either are such interfaces (such as \`webenv.defaults\`), or create them, or are streams (\`webenv.browser\`).
    Some are mostly observations, some are mostly actions, some are mostly agents (connecting observations to actions).
    Agents are called in a loop, which maximizes throughput.

Ideally, you should not treat observations/actions as anything other than vectors of approximately -1..1 32-bit floats. (Not necessarily square, not necessarily an image. Very likely multimodal.)

To write new interfaces, look at the pre-existing interfaces.
    An interface is an object (or an array of interfaces, for convenience) that may define:
    - \`.settings\` (see \`webenv.settings\`);
    - \`.init(stream)\`, \`.deinit(stream)\` (neither is called on browser relaunching, except on new/removed interfaces);
    - \`.reads:Number\`, \`.read(stream, obs, end)\` (modify \`obs\` in-place, do not read) (to prevent torn writes, \`await end()\` right before writing);
    - \`.writes:Number\`, \`.write(stream, pred, act)\` (\`pred\` can predict the next read \`obs\`; do read from \`act\` and act on that, do not write);
    - \`.agent(stream, {obs, pred, act})=>continues\` (to prevent torn writes, there should only be one agent);
    - \`priority:Number\` (for example, interfaces that read actions at write-time have priority of -1, to always go after action-fillers);
    All functions are potentially asynchronous, and will be \`await\`ed if needed.
`, async function(...interfaces) {
    let windowId = null, chromeWidth = 0, chromeHeight = 0
    interfaces.push({ // Counteract rowdy users.
        prevPage: null,
        read(stream, obs, end) {
            if (!stream.cdp) return
            if (this.prevPage !== stream.page || Math.random() < .01) resizeWindow(stream)
            this.prevPage = stream.page
        },
    })
    return streamPrototype.create(relaunch)

    function resizeWindow(stream) {
        return stream.cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
                width: stream.settings.width + chromeWidth,
                height: stream.settings.height + chromeHeight,
            },
        }).catch(doNothing)
    }
    async function relaunch() {
        // Close the previous browser.
        if (this.browser) {
            const b = this.browser
            this.browser = null
            await b.close()
        }

        const ext = require('path').join(__dirname, 'extension')
        const dataDir = this.settings.userProfile(this)

        // Remove folders that may be problematic for long-term stability. (Things never just work.)
        const fs = require('fs')
        function rm(...p) {
            const path = require('path').join(dataDir, ...p)
            return new Promise(then => fs.rm(path, { force:true, recursive:true }, then))
        }
        await Promise.all([rm('Crashpad', 'reports'), rm('BrowserMetrics'), rm('ShaderCache', 'GPUCache'), rm('ShaderCache')])

        // Open the new browser.
        const puppeteer = require('puppeteer')
        const browser = this.browser = await puppeteer.launch({
            headless:false,
            defaultViewport:null,
            waitForInitialPage:false,
            args:[
                '--allow-file-access-from-files',
                '--autoplay-policy=no-user-gesture-required',
                '--load-extension=' + ext,
                '--disable-extensions-except=' + ext,
                '--whitelisted-extension-id=clmfcdjojibdkmjpbfbddhjiolfjhcgn',
                '--lang='+this.lang,
                '--disable-notifications',
                '--user-data-dir=' + dataDir,
                '--allow-profiles-outside-user-dir',
            ],
            ignoreDefaultArgs:[
                '--mute-audio',
                '--disable-gpu',
            ],
        })
        const page = this.page = (await browser.pages())[0]
        if (!page) throw new Error('Puppeteer returned null')
        page.on('error', err => { throw err })
        const langParts = this.lang.split(',')
        ;[
            this.cdp,
            chromeWidth,
            chromeHeight,
            this.extensionPage,
        ] = await Promise.all([
            page.target().createCDPSession(),
            page.evaluate(() => outerWidth - innerWidth),
            page.evaluate(() => outerHeight - innerHeight),
            browser.waitForTarget(t => t.type() === 'background_page' && t._targetInfo.title === 'WebEnv capture').then(t => t.page()),
            page.setUserAgent(''),
            page.evaluateOnNewDocument(langParts => {
                Object.defineProperty(navigator, 'language', { value:langParts[0] })
                Object.defineProperty(navigator, 'languages', { value:langParts })
            }, langParts),
            page.setExtraHTTPHeaders({ 'Accept-Language': langParts[langParts.length-1] }),
        ])
        const oldInters = this.interfaces || interfaces
        interfaces = null
        this._all = [] // Call all initializers again, to re-attach event listeners.
        this._agentInds = [] // Re-launch the step loop if we have agents.
        const p = this.relink(...oldInters)

        // Set the viewport.
        await Promise.resolve()
        const targetId = page._target._targetInfo.targetId // Sure hope this does not change.
        windowId = (await this.cdp.send('Browser.getWindowForTarget', {targetId})).windowId
        await resizeWindow(this)

        // Not entirely reliable, but better than nothing.
        if (this.settings.homepage && this.settings.homepage !== 'about:blank')
            // Browser crashes are far more frequent if we don't wait at least a bit.
            await Promise.race([
                Promise.all([
                    // Resetting history is not that great.
                    page.goto(this.settings.homepage, {waitUntil:'domcontentloaded'}).then(() => this.cdp.send('Page.resetNavigationHistory')).catch(doNothing),
                    this.cdp.send('Page.resetNavigationHistory').catch(doNothing),
                ]),
                new Promise(then => setTimeout(then, 10000)),
            ])

        await p
        this._lastStepEnd = performance.now()
    }
})



exports.remote = docs(`\`webenv.remote(path='/connect', maxConnections=4)\`

Allows users to connect their own streams, via:

\`\`\`js
let toCancel
const socket = new WebSocket(…url…)
socket.binaryType = 'arraybuffer', socket.onmessage = evt => {
    toCancel = new Function(new TextDecoder().decode(evt.data))()(socket, { bytesPerValue:1|2|4 })
}
\`\`\`

(And do \`toCancel()\` to disconnect, and set \`toCancel.onClose = ()=>{}\` to react to disconnects.)

See the \`/extension\` folder for a ready-made extension that can do that. Web pages can also connect, though they will not be able to navigate.
`, function remote(path='/connect', maxConnections=4) {
    const key = remote.key || (remote.key = Symbol('remote'))
    return {
        countsAsAStream: true, // If `we.remote` is the only stream-like interface, don't launch an extra stream.
        streamsReinit(env) {
            const spot = Spot(env)
            env.upgrade(path, (...args) => {
                spot.connections.add(args)
                openConnections(env)
            })
        },
    }
    function openConnections(env) {
        // Upgrades already-open connections to the "connected" status.
        const spot = Spot(env)
        spot.connections.forEach(args => {
            if (spot.open >= maxConnections) return
            spot.connections.delete(args)
            openConnection(env, args)
        })
    }
    async function relaunch() {
        // There is no relaunching a remote user's browser. But we do provide interfaces.
        await this.relink(this.env.interfaces)
    }
    async function openConnection(env, args) {
        ++Spot(env).open
        const stream = streamPrototype.create(relaunch)
        await env.reinit(env.interfaces, env.streams, stream)
        const [ch, cancel] = await handleUpgrade(stream, ...args)
        ch.onClose = () => closeConnection(env, stream)
    }
    async function closeConnection(env, stream) {
        await env.reinit(env.interfaces, env.streams.filter(s => s !== stream))
        --Spot(env).open
        openConnections(env)
    }
    function Spot(o) { return o[key] || (o[key] = Object.create(null), o[key].connections = new Set, o[key].open = 0, o[key]) }
})



function docs(str, fun) { fun.docs = str;  return fun }



exports.defaults = [
    exports.stability(),
    exports.directLink(),
    exports.directScore(),
    exports.userAgent(),
    exports.fetchSlice(),
    exports.visualize(),
    exports.filter(null, 'cached'),
    exports.const(),
    exports.loopback(),
    exports.frameTime(),
    exports.imageFovea(100, 5000, 1),
    exports.scrollBy(),
    exports.mouse({ absolute:false, relative:50 }),
    exports.keyboard(),
    exports.augmentations(),
    exports.interval(exports.triggers.homepage, 60),
    exports.triggers(
        { maxAtOnce:1, cooldown:3600 },
        exports.triggers.randomLink),
]