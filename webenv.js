// Here are all WebEnv interface modules, in chronological order.
//   To go to a particular interface, search for `exports.XXXXX =`.



const channels = require('./src/data-channels.js')
const { signalUpdate, signalNormalize } = require('./src/signal-stats.js')
const { Observations, performance, streamPrototype } = require('./src/stream-prototype.js')
const { observers } = require('./src/observers.js')
const { compileSentJS } = require('./src/compile-sent-js.js')
const { encodeInts, decodeInts, overwriteArray } = require('./src/int-encoding.js')
const { writeToChannel, readFromChannel, swapBytes } = channels



exports.init = docs(`Function. Pass in numeric streams and/or interfaces, receive a promise of an object that manages bidirectional numeric data streams: Env.

See \`webenv.browser\` for an example of a type of stream.
All top-level non-stream interfaces will be copied into all streams.

(Uniting many streams in one allows agents to process streams in batches, which is good for performance in master-slave computing architectures such as CPU+GPU.)

Env's methods:
- \`.reinit(...streams)\`: for dynamically changing the set of streams/interfaces; \`await\` it.
    - To modify \`env\`'s streams, use \`await env.reinit(MODIFY(env.streams))\`.
    - To close streams without closing NodeJS, use \`await env.reinit()\`.
- \`.listen(path='/', func)\`: router, for making the HTTP/S server listen at \`path\` (such as \`/observations/0\`), via \`func(req, res)\`; \`await\` it.
    - Returns \`null\` if path was already listening, else \`path\`.
    - If \`func\` is \`null\` but \`path\` is not, this cancels the subscription.
    - Port & HTTPS settings are taken from \`webenv.settings(…)\` of the first stream.
- \`.upgrade(path='/', func)\`: routes upgrade requests to \`func\`, for establishing Web Socket connections. Same semantics as \`.listen\`.
`, async function init(...interfaces) {
    const env = {
        streams: [],
        interfaces: [],
        _reinitLock: null,
        _server: null,
        _listenPaths: Object.create(null),
        _upgradePaths: Object.create(null),
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
                await (async function track(o) {
                    if (o instanceof Promise) o = await o
                    if (Array.isArray(o)) return Promise.all(o.map(track))
                    if (!o || typeof o != 'object') throw new Error('All must be webenv streams/interfaces, got '+o)
                    if (Object.getPrototypeOf(o) === streamPrototype) next.push(o)
                    else nonStreams.push(o)
                })(interfaces)
                this.interfaces = nonStreams
                if (!next.length)
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
        const opt = env.streams[0].settings.httpsOptions
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
        return new Promise(then => env._server.listen(env.streams[0].settings.port, then))
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
        observer: [async function(media, {obs}, end, w, h, maskColor) {
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
        observer: [
            async function(media, {obs}, end, x, y, w, h, maxW, maxH, maskColor) {
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
            },
            s => (s.page.mouseX || 0) - (s.page.mouseX || 0) % quantize,
            s => (s.page.mouseY || 0) - (s.page.mouseY || 0) % quantize,
            width,
            height,
            s => s.settings.width,
            s => s.settings.height,
            maskColor,
        ],
        visualize: [
            visualizePageScreenshot,
            s => (s.page.mouseX || 0) - (s.page.mouseX || 0) % quantize,
            s => (s.page.mouseY || 0) - (s.page.mouseY || 0) % quantize,
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
        observer: [
            async function observeFovea(media, {obs}, end, closestPoint, x, y, w, h, maxW, maxH, maskColor) {
                x -= (w/2) | 0, y -= (h/2) | 0
                if (!observeFovea.pointSum) { // Prepare data, if not prepared already.
                    let max = 0
                    for (let i = 0; i < closestPoint.length; ++i)
                        max = Math.max(max, closestPoint[i])
                    const numPoints = max + 1
                    observeFovea.pointSum = new Float32Array(numPoints * 3)
                    observeFovea.pointNum = new Int32Array(numPoints)
                }
                // Get image data.
                const d = await media.video(x, y, w, h, maxW, maxH)
                const pointSum = observeFovea.pointSum, pointNum = observeFovea.pointNum
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
            },
            closestPointArray,
            s => (s.page.mouseX || 0) - (s.page.mouseX || 0) % quantize,
            s => (s.page.mouseY || 0) - (s.page.mouseY || 0) % quantize,
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
            s => (s.page.mouseX || 0) - (s.page.mouseX || 0) % quantize,
            s => (s.page.mouseY || 0) - (s.page.mouseY || 0) % quantize,
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
            const hash = (x<<16) | y
            if (points.has(hash)) continue
            points.add(hash)
        }
        return [...points].sort((a,b) => { // Split into 16×16 blocks, and sort sort by x in each block.
            const xa = a>>>16, ya = a&65535, blocka = (xa>>>4)*200 + (ya>>>4)
            const xb = a>>>16, yb = a&65535, blockb = (xb>>>4)*200 + (yb>>>4)
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
    return [observers, {
        reads: samples,
        observer: [async function(media, {obs}, end, samples, sampleRate) {
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
    function route(...p) { return '/' + p.filter(s=>s).join('/') }
    function Spot(o) { return o[key] || (o[key] = Object.create(null)) }
    return {
        async init(stream) {
            const env = stream.env, id = stream.index
            sendRestream(env, Spot(env).connections) // Adding/removing many streams at once will send quadratically-many stream indices. Who cares.
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
                env.listen(route('observations', path, ''+id), (req, res) => {
                    // Remember to later send events to here whenever observations arrive.
                    const spot = Spot(stream)
                    const to = spot.connections || (spot.connections = new Set)
                    to.add(res), res.on('close', () => to.delete(res))
                    res.writeHead(200, serverSentEvents)
                    sendRelink(stream, to)
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
        async deinit(stream) {
            // '/observations/path' and '/path' never get unlinked,
            //   but the server gets stopped for closed envs, so no memory leak.
            const env = stream.env
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
                if (q.waiting.length) // Resolve the first reader.
                    q.waiting.shift()(item)
                else // Allow others to resolve the item.
                    q.items.push(item)
            } catch (err) { if (err !== 'skip') throw err }
        }
    }
    async function getDataQueueItem(s, dont = false) {
        const q = s._dataQueue || (s._dataQueue = { items:[], waiting:[] })
        if (dont) return
        if (!q.items.length)
            return await new Promise(then => q.waiting.push(then))
        return items.shift()
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
        async agent(stream, obs, pred, act) {
            // Write observation, atomically (no torn writes).
            if (!io.env) return true
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
            return true
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
        init(stream) {
            stream.page.evaluateOnNewDocument((name, maxReads, maxWrites, maxLinks) => {
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
            return stream.page.exposeFunction('_directLinkRegister', async (agentId, ins = 0, outs = 0) => {
                if (typeof agentId != 'number') return false
                if (typeof ins != 'number' || typeof outs != 'number') return false
                if (reads + outs > maxReads) return false
                if (writes + ins > maxWrites) return false
                if (agentCount + 1 > maxLinks) return false
                ++agentCount, reads += outs, writes += ins
                let continues = true, initialized = false
                const p = stream.page
                const doHandle = await p.evaluateHandle(name => self[name].evalAgent, name)
                const actHandle = await p.evaluateHandle(sz => new Float32Array(sz), ins)
                const obsHandle = await p.evaluateHandle(sz => new Float32Array(sz), outs)
                const toBinaryStringHandle = await p.evaluateHandle('('+toBinaryString+')')
                const fromBinaryStringHandle = await p.evaluateHandle('('+fromBinaryString+')')
                await stream.relink(stream.interfaces, {
                    queue:[], // This can't be a real word.
                    priority:-1000,
                    reads:outs,
                    writes:ins,
                    init(stream) { initialized && (continues = false), initialized = true },
                    async read(stream, obs, end) {
                        if (!continues) return
                        if (!this.queue.length) return
                        const obsSource = this.queue.shift()
                        await end()
                        overwriteArray(obs, obsSource)
                    },
                    agent(stream, obs, pred, act) { return continues }, // Ensure that steps always happen.
                    async write(stream, pred, act) {
                        if (stream.page !== stream.page) continues = false
                        if (!continues) return
                        if (!stream.page || stream.page.isClosed()) return
                        // Call the page-agent with our action, to get observation.
                        const actBase64 = Buffer.from(act.buffer, act.byteOffset, act.byteLength).toString('base64')
                        let result
                        try {
                            result = await stream.page.evaluate((f, ...a) => f(...a), doHandle, agentId, actBase64, actHandle, obsHandle, toBinaryStringHandle, fromBinaryStringHandle)
                        } catch (err) {}
                        if (typeof result != 'string')
                            return continues = false
                        const obsBuf = Buffer.from(result, 'base64')
                        const obs = new Observations(obsBuf.buffer, obsBuf.byteOffset, obsBuf.byteLength / Observations.BYTES_PER_ELEMENT | 0)
                        for (let i = 0; i < obs.length; ++i)
                            obs[i] = obs[i] !== obs[i] ? NaN : Math.max(-1, Math.min(obs[i], 1))
                        this.queue.push(obs)
                    },
                    deinit(stream) {
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
        agent(stream, obs, pred, act) {
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
        write(stream, pred, act) {
            if (!stream.page || stream.page.isClosed()) return
            const dx = sensitivity * Math.max(-1, Math.min(act[0], 1))
            const dy = sensitivity * Math.max(-1, Math.min(act[1], 1))
            stream.page.evaluate((dx, dy) => scrollBy(dx, dy), dx, dy).catch(doNothing)
        },
    }
})



exports.interval = docs(`\`webenv.interval(func, ms = 60000)\`
Runs a func on an interval, with page and env as args (for example, use \`webenv.triggers.homepage\`, especially if that opens a random page).
`, function(func, ms = 60000) {
    let id = null
    return {
        init(stream) { clearInterval(id), id = setInterval(func, ms, stream) },
        deinit(stream) { clearInterval(id), id = null },
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
        init(stream) {
            const p = stream.page
            if (!resetOnNewPage || !p) return
            p.on('framenavigated', frame => frame === p.mainFrame() && prev.fill(0))
            p.on('domcontentloaded', () => prev.fill(0))
        },
        priority: typeof opt.priority == 'number' ? opt.priority : 0,
        writes:triggers,
        write(stream, pred, act) {
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
                if (!prev[i] && next[i]) start[i](stream)
                else if (stop && prev[i] && !next[i]) stop[i](stream)
            prev.set(next)
        },
    }
    function get(obj, at, def) { return obj && obj[at] !== undefined ? obj[at] : def }
})



exports.triggers.homepage = docs(`\`webenv.triggers([webenv.triggers.homepage])\`
Back to homepage, please.
`, function(stream) {
    if (!stream.page) return
    stream.page.mouseX = stream.settings.width/2 | 0
    stream.page.mouseY = stream.settings.height/2 | 0 // Center the mouse too.
    return stream.page.goto(stream.settings.homepage || 'about:blank', {waitUntil:'domcontentloaded'}).catch(doNothing)
})



exports.triggers.goBack = docs(`\`webenv.triggers([webenv.triggers.goBack])\`
Back to the previous page, please.
`, function(stream) { return stream.page && stream.page.goBack().catch(doNothing) })



exports.triggers.randomLink = docs(`\`webenv.triggers([webenv.triggers.randomLink])\`
Picks a random file: or http: or https: link on the current page, and follows it.
`, async function(stream) {
    if (!stream.page) return
    let place = stream.page.url(), i = place.lastIndexOf('#')
    if (i >= 0) place = place.slice(0, i) // `URL#ID` → `URL`
    const selector = 'a'
    let urls
    try { urls = await stream.page.$$eval(selector, links => links.map(a => a.href)) }
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
    return stream.page.goto(url, {waitUntil:'domcontentloaded'}).catch(doNothing)
})



exports.triggers.randomInCache = docs(`\`webenv.triggers([webenv.triggers.randomInCache])\`
Navigates to a random previously-visited URL (most of the time), which is preserved in cache.
Must only be used with \`webenv.filter\`, with a string \`cache\` path.

(A bit useless with the RandomURL dataset.)

(This is a very open-ended action. If the agent's loss averages outcomes, then predictions with this trigger would be quite gray and nonsensical; make sure to maximize plausibility instead, so particular outcomes don't get penalized.)
`, async function(stream) {
    if (!stream.page || stream.page.cache === undefined) return
    if (typeof stream.page.cache !== 'string') throw new Error('But the stream page has no .cache')
    const maxAttempts = 32 // Why maintain a separate main-URL index when you can just retry.
    const fs = require('fs/promises'), path = require('path')
    const navs = new Array(maxAttempts).fill(stream.page.cache).map(getRandomNav)
    for (let nav of navs)
        if (nav = await nav)
            return stream.page.goto(nav, {waitUntil:'domcontentloaded'}).catch(doNothing)
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
        keys.map(k => stream => stream.page && stream.page.keyboard.down(k, k.length > 1 ? undefined : {text:k}).catch(doNothing)),
        keys.map(k => stream => stream.page && stream.page.keyboard.up(k).catch(doNothing)),
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
            write(stream, pred, act) {
                if (!stream.page || stream.page.isClosed()) return
                const dx = Math.max(-1, Math.min(act[0], 1)) * sensitivity
                const dy = Math.max(-1, Math.min(act[1], 1)) * sensitivity
                stream.page.mouse.wheel({ deltaX:dx, deltaY:dy }).catch(doNothing)
            },
        })
    }
    if (opt.absolute !== false)
        inters.push({
            init(stream) {
                stream.page.mouseX = stream.settings.width/2 | 0
                stream.page.mouseY = stream.settings.height/2 | 0
            },
            writes:2,
            write(stream, pred, act) {
                const p = stream.page
                if (!p || p.isClosed()) return
                const ax = Math.max(-1, Math.min(act[0], 1))
                const ay = Math.max(-1, Math.min(act[1], 1))
                p.mouse.move(
                    p.mouseX = (ax + 1) * .5 * (stream.settings.width-1) | 0,
                    p.mouseY = (ay + 1) * .5 * (stream.settings.height-1) | 0,
                ).catch(doNothing)
            },
        })
    if (opt.relative && typeof opt.relative == 'number') {
        const sensitivity = opt.relative
        inters.push({
            init(stream) {
                stream.page.mouseX = stream.settings.width/2 | 0
                stream.page.mouseY = stream.settings.height/2 | 0
            },
            writes:2,
            write(stream, pred, act) {
                const p = stream.page
                if (!p || p.isClosed()) return
                const ax = Math.max(-1, Math.min(act[0], 1))
                const ay = Math.max(-1, Math.min(act[1], 1))
                p.mouse.move(
                    p.mouseX = Math.max(0, Math.min(p.mouseX + sensitivity * ax, stream.settings.width-1)) | 0,
                    p.mouseY = Math.max(0, Math.min(p.mouseY + sensitivity * ay, stream.settings.height-1)) | 0,
                ).catch(doNothing)
            },
        })
    }
    let curButtons = 0
    if (opt.left !== false)
        start.push(stream => mouseButton(stream, 1, true)),
        stop.push(stream => mouseButton(stream, 1, false))
    if (opt.right === true)
        start.push(stream => mouseButton(stream, 2, true)),
        stop.push(stream => mouseButton(stream, 2, false))
    if (opt.middle === true)
        start.push(stream => mouseButton(stream, 4, true)),
        stop.push(stream => mouseButton(stream, 4, false))
    if (start.length) inters.push(exports.triggers(start, stop, {...opt, priority:-2}))
    return inters
    function mouseButton(stream, button, pressed) {
        // `page.mouse.down(...)`/`.up(...)` have proven unreliable, so, CDP.
        if (pressed) curButtons |= button
        stream.cdp && stream.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: stream.page.mouseX,
            y: stream.page.mouseY,
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
        }, s => +s._period],
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



exports.injectScript = docs(`\`webenv.injectScript(...functions)\`
Executes JS functions on every new document.

See this object's properties for examples of \`functions\`.
`, function(...funcs) {
    if (!funcs.every(f => typeof f == 'function' || typeof f == 'string'))
        throw new Error('Not-a-function cannot be injected')
    const source = funcs.map(f => '(' + (''+f) + ')();').join('\n')
    return {
        priority:1,
        async init(stream) {
            if (!stream.cdp) return
            this.script = (await stream.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
                source, worldName:'webenvJS',
            })).identifier
        },
        deinit(stream) {
            if (!stream.cdp) return
            stream.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.script })
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
        async read(stream, obs, end) {
            if (!stream.page) return
            const v = scoreSum / scoreNum // NaN if no scores since the last frame.
            scoreSum = scoreNum = 0
            const u = stream.page.url()

            const norm = signalNormalize(v, data[u])
            if (v === v) // Update the page's reward-stream statistics, and cross-page improvement.
                data[u] = signalUpdate(v, data[u], maxHorizon),
                data.ALL = signalUpdate(norm, data.ALL, maxHorizon)
            if (!hidden) await end(), obs[0] = norm
        },
        init(stream) {
            stream.score = data
            if (timeoutID === null)
                active = true, timeoutID = setTimeout(saveData, saveInterval*1000)
            if (!stream.page) return
            return stream.page.exposeFunction(name, async score => {
                if (typeof score != 'number' || score !== score) return false
                scoreSum += Math.max(-maxRawMagnitude, Math.min(score, maxRawMagnitude))
                ++scoreNum
                return updated = true
            })
        },
        deinit(stream) {
            return active = false, saveData(true)
        },
        visualize: !hidden ? [function(elem, obs, pred) {
            elem.textContent = `Score: ${obs[0].toFixed(2)} real | ${pred[0].toFixed(2)} predicted`
            elem.style.fontFamily = 'monospace, monospace'
        }] : undefined,
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
                    throw new Error('Max slice size is 20MB')
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
    - \`.agent(stream, obs, pred, act)=>continues\` (return false to unlink the agent, unless it is at top-level) (to prevent torn writes, there should only be one agent);
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
        const page = this.page = await browser.newPage()
        if (!page) throw new Error('Puppeteer returned null')
        page.on('error', err => { throw err })
        closeAllPagesExcept(browser, page)
        const langParts = this.lang.split(',')
        ;[ // Thanks, async/await, very helpful for efficiency via parallelization. (Sarcasm.)
            this.cdp,
            chromeWidth,
            chromeHeight,
            this.extensionPage,
        ] = await Promise.all([
            page.target().createCDPSession(),
            page.evaluate(() => outerWidth - innerWidth),
            page.evaluate(() => outerHeight - innerHeight),
            browser.waitForTarget(t => t.type() === 'background_page' && t._targetInfo.title === 'capture').then(t => t.page()),
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
        await this.relink(...oldInters)

        // Set the viewport.
        const targetId = (await this.cdp.send('Target.getTargets')).targetInfos[0].targetId
        windowId = (await this.cdp.send('Browser.getWindowForTarget', {targetId})).windowId
        await resizeWindow(this)

        if (this.settings.homepage && this.settings.homepage !== 'about:blank')
            // Browser crashes are far more frequent if we don't wait at least a bit.
            await Promise.race([
                Promise.all([
                    page.goto(this.settings.homepage, {waitUntil:'domcontentloaded'}).then(() => this.cdp.send('Page.resetNavigationHistory')).catch(doNothing),
                    this.cdp.send('Page.resetNavigationHistory').catch(doNothing),
                ]),
                new Promise(then => setTimeout(then, 10000)),
            ])
        this._lastStepEnd = performance.now()
    }
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
    exports.injectScript(exports.injectScript.augmentations()),
    exports.interval(exports.triggers.homepage),
    exports.triggers(
        [exports.triggers.goBack, exports.triggers.randomLink],
        null,
        { maxAtOnce:1, cooldown:3600 }),
]