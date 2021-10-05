// To go to a particular interface, search for `exports.XXXXX =`.



const performance = require('perf_hooks').performance

const Observations = Float32Array

exports.init = docs(`Function. Pass in numeric streams and/or interfaces, receive a promise of an object that manages bidirectional numeric data streams: Env.

See \`webenv.browser\` for an example of a type of stream.
All top-level non-stream interfaces will be copied into all streams.

(Uniting many streams in one allows agents to process streams in batches, which is good for performance in master-slave computing architectures such as CPU+GPU.)

Env's methods:
- \`.reinit(...streams)\`: for dynamically changing the set of streams/interfaces; \`await\` it.
    - To modify \`env\`'s streams, use \`await env.reinit(MODIFY(env.streams))\`.
    - To close streams without closing NodeJS, use \`await env.reinit()\`.
- \`.listen(path='/', func)\`: router, for making the HTTP/S server listen at \`path\` (such as \`\`), via \`func(req, res)\`; \`await\` it.
    - Returns \`null\` if path was already listening, else \`path\`.
    - If \`func\` is \`null\` but \`path\` is not, this cancels the subscription.
    - Port & HTTPS settings are taken from \`webenv.settings(…)\` of the first stream.
`, async function init(...interfaces) {
    const env = {
        streams: [],
        interfaces: [],
        _reinitLock: null,
        _server: null,
        _serverPaths: Object.create(null),
        async listen(path='/', func) {
            if (!this._server) {
                const opt = this.streams[0].settings.httpsOptions
                const http = require('http'), https = require('https')
                const server = !opt ? (f => http.createServer(f)) : (f => https.createServer(opt, f))
                this._server = server((req, res) => {
                    const u = req.url, paths = this._serverPaths
                    if (u in paths) paths[u](req, res)
                    else res.statusCode = 404, res.end()
                })
                await new Promise(then => this._server.listen(this.streams[0].settings.port, then))
            }
            const paths = this._serverPaths
            const had = path in paths
            if (!func && path != null) delete paths[path]
            else if (typeof func != 'function')
                throw new Error('Listener is not a function')
            if (!had) paths[path] = func
            return had ? path : null
        },
        async reinit(...interfaces) {
            let p = this._reinitLock, then
            this._reinitLock = new Promise(f => then=f)
            await p // Lock.
            try {
                // Kill the server if no interfaces.
                if (!interfaces.length) {
                    const server = this._server;  this._server = null
                    this._serverPaths = Object.create(null)
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
        observer: [async function({video, audio}, obs, end, w, h, maskColor) {
            const d = video.grab(0, 0, w, h, w, h)
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
        visualize: [visualizePageScreenshot, s => s.settings.width, s => s.settings.height],
    }]
})



function visualizePageScreenshot(elem, obs, pred, width, height) {
    if (obs.length % 3) throw new Error('Bad length: ' + obs.length)
    if (!elem.firstChild) {
        const obsC = elem.appendChild(document.createElement('canvas'))
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
    return [observers, {
        reads: width * height * 3,
        observer: [
            async function({video, audio}, obs, end, x, y, w, h, maxW, maxH, maskColor) {
                x -= (w/2) | 0, y -= (h/2) | 0
                const d = video.grab(x, y, w, h, maxW, maxH)
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
        visualize: [visualizePageScreenshot, width, height],
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
            async function observeFovea({video, audio}, obs, end, closestPoint, x, y, w, h, maxW, maxH, maskColor) {
                if (!observeFovea.pointSum) { // Prepare data, if not prepared already.
                    let max = 0
                    for (let i = 0; i < closestPoint.length; ++i)
                        max = Math.max(max, closestPoint[i])
                    const numPoints = max + 1
                    observeFovea.pointSum = new Float32Array(numPoints * 3)
                    observeFovea.pointNum = new Int32Array(numPoints)
                }
                // Get image data.
                x -= (w/2) | 0, y -= (h/2) | 0
                const d = video.grab(x, y, w, h, maxW, maxH)
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
        visualize: [function visualizePageFovea(elem, obs, pred, closestPoint) {
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
        }, closestPointArray],
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
    return [observers, {
        reads: samples,
        observer: [async function({video, audio}, obs, end, samples, sampleRate) {
            // A copy, but this is small-time compared to `webenv.image(...)`.
            await end()
            obs.set(audio.grab(samples, sampleRate))
        }, samples, sampleRate],
        visState(stream) { return sampleRate },
        visualize: [function(elem, obs, pred) {
            let obsSqr = 0, predSqr = 0
            for (let i=0; i < obs.length; ++i) obsSqr += obs[i] * obs[i] || 0
            for (let i=0; i < pred.length; ++i) predSqr += pred[i] * pred[i] || 0
            const obsDb = (-20 * Math.log(1 / Math.sqrt(obsSqr))).toFixed(2)
            const predDb = (-20 * Math.log(1 / Math.sqrt(predSqr))).toFixed(2)
            elem.textContent = `Volume: ${obsDb} dB real | ${predDb} dB predicted`
            elem.style.fontFamily = 'monospace'
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
    button { border:none }
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
        if (prevSelected === b.textContent) select(b)
        if (ids.length > 1) bc.appendChild(b)
        buttons.push(b)
    })
    if (!ids.length) select()
    else if (!selected) select(buttons[0])
})
onclick = evt => {
    if (!evt.target || evt.target.tagName !== 'BUTTON') return
    select(evt.target)
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
            // '/observations/path' and '/path' never get unlinked, causing a memory leak for closed envs.
            //   But how often do you have closed envs anyway?
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
                [spot.SND, spot.RCV] = await createExtendJS(stream)
                sendRelink(stream, to)
                spot.interfaces = stream.interfaces
            }
            const json = await spot.SND(stream)
            await end()
            sendObservation(obs, spot.pred, json, to)
        },
        write(stream, pred, act) {
            // Remember prediction to send later, unless it's all-zeros|NaN.
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
function swapBytes(buf, bpe = 4) {
    if (bpe === 8) buf.swap64()
    else if (bpe === 4) buf.swap32()
    else if (bpe === 2) buf.swap16()
    return buf
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
    const thens = [], reqs = []
    let cons // Constructor for encoded arrays.
    let writeLock = null // No torn writes.
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
    async function readAllData(bs) {
        // Infinitely read process.stdout.
        while (true) {
            const index = (await readFromStream(readBytes, 1, Uint32Array, bs))[0]
            const predData = await readArray(cons, bs)
            const actData = await readArray(cons, bs)
            const s = io.env.streams[index]
            if (!s) continue
            const q = s._dataQueue
            const item = [predData, actData]
            if (q.items.length > s.settings.simultaneousSteps) q.items.shift()
            if (q.waiting.length) // Resolve the first reader.
                q.waiting.shift()(item)
            else // Allow others to resolve the item.
                q.items.push(item)
        }
    }
    async function getDataQueueItem(stream, dont = false) {
        const q = stream._dataQueue
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
            if (!stream._dataQueue)
                stream._dataQueue = { items:[], waiting:[] }
            if (io.env) return // STDIO is once per process.
            io.env = stream.env
            process.stdin.on('readable', onReadable)
            const magic = (await readFromStream(readBytes, 1, Uint32Array, false))[0]
            if (magic === 0x01020304)
                this.byteswap = false
            else if (magic === 0x04030201)
                this.byteswap = true
            else
                throw new Error('Bad magic number:', magic)
            const intSize = (await readFromStream(readBytes, 1, Uint32Array, this.byteswap))[0]
            if (![0,1,2].includes(intSize)) throw new Error('Bad intSize: '+intSize)
            cons = intSize === 0 ? Float32Array : intSize === 1 ? Int8Array : Int16Array
            this.obsCoded = new cons(0)
            process.stdout.on('drain', onDrain)
            process.stdout.on('error', doNothing) // Ignore "other end has closed" errors.
            readAllData(this.byteswap) // Fill those data queues.
        },
        async deinit(stream) {
            if (!io.env) return
            // Send a dealloc event.
            let oldW = writeLock, thenW
            writeLock = new Promise(f => thenW=f);  await oldW
            const to = process.stdout, bs = this.byteswap
            await writeToStream(to, stream.index, bs, thens)
            await writeToStream(to, 0, bs, thens)
            await writeToStream(to, 0xFFFFFFFF, bs, thens)
            thenW()
        },
        async agent(stream, obs, pred, act) {
            // Write observation, atomically (no torn writes).
            if (!io.env) return true
            let oldW = writeLock, thenW
            writeLock = new Promise(f => thenW=f);  await oldW
            const to = process.stdout, bs = this.byteswap
            await writeToStream(to, stream.index, bs, thens)
            await writeArray(to, this.obsCoded = encodeInts(obs, this.obsCoded), bs)
            await writeToStream(to, act.length, bs, thens)
            thenW()
            // Read from our data queue.
            const [predData, actData] = await getDataQueueItem(stream)
            decodeInts(predData, pred), decodeInts(actData, act)
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
    if (!stream.UNCORK)
        stream.UNCORK = () => stream.uncork()
    stream.cork()
    process.nextTick(stream.UNCORK)
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
    const performance = require('perf_hooks').performance
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
                elem.firstChild.style.width = '1.2em'
                elem.firstChild.style.height = '1.2em'
                elem.firstChild.style.borderRadius = '50%'
                elem.firstChild.style.display = 'inline-block'
                elem.appendChild(document.createElement('div'))
                elem.lastChild.style.fontFamily = 'monospace,monospace'
                elem.frame = false
            }
            const fps = 1000 / period
            elem.firstChild.style.backgroundColor = (elem.frame = !elem.frame) ? 'lightgray' : 'darkgray'
            elem.lastChild.textContent = fps.toFixed(1) + ' FPS'
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
    const performance = require('perf_hooks').performance
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
`, function(settings) { return { settings } })



const observers = docs(`The shared interface for extension-side video and audio grabbing.

May be replaced by ALL observations coming from the extension. And through WebRTC, not CDP. And with properly-varying bytes-per-value.

Other interfaces that want this must define:
- \`.observer: [({video, audio}, obs, end, ...args)=>…, ...args]\`
    - Computed args get the \`stream\`.
    - Communication cost is reduced as much as possible without compression, don't worry.
    - Calling \`await end()\` at the end or just before writing to \`obs\` (f32 array) is mandatory.
    - \`video:{grab(x,y,w,h)=>pixels}\`
    - \`audio:{grab(sampleN=2048, sampleRate=44100)=>samples\`
// TODO: Also give the previous actions to observers, so that the extension can perform them for us. (Would need a separate binary-ish stream for this, to not waste time+bandwidth on base64+JSON-encoding actions. Post-web-socket.)
//   (And the previous predictions, so that users can visualize those.)
`, {
    key: Symbol('observers'),
    init(stream) {
        if (!stream.extensionPage) return
        stream.extensionPage.exposeFunction('gotObserverData', gotObserverData)
        stream.extensionPage.exposeFunction('PRINT', console.error) // For debugging.
        function gotObserverData(b64) {
            // Yeah, sure, u16 per color per pixel is 2× the inefficiency. But. Audio.
            //   TODO: Make the extension communicate through a WebSocket, not CDP.
            const obsBuf = Buffer.from(b64 || '', 'base64') // Int16; decode into floats.
            const obsLen = obsBuf.byteLength / Int16Array.BYTES_PER_ELEMENT | 0
            decodeInts(new Int16Array(obsBuf.buffer, obsBuf.byteOffset, obsLen), stream._obsFloats)
            // (Technically, this can overwrite other `read`s, but `await end()` should prevent that.)
        }
    },
    async read(stream, obs, _) {
        if (!stream.page || !stream.extensionPage || stream.extensionPage.isClosed()) return
        const state = stream[this.key] || (stream[this.key] = Object.create(null))
        if (state.snd === undefined || state.all !== stream._all) {
            // Relink extension-side observers.
            state.all = stream._all
            const items = [], staticArgs = new Map, prelude = []
            const endFunc = items.push([`()=>{}`])-1
            const obsSlices = []
            for (let i = 0; i < stream._all.length; ++i) {
                const o = stream._all[i]
                if (Array.isArray(o.observer)) {
                    const item = o.observer
                    const off = stream._allReadOffsets[i]
                    const at = obsSlices.push(`RCV.obs.subarray(${off}, ${off + (o.reads || 0)})`)-1
                    items.push(item)
                    staticArgs.set(item, `RCV.media,RCV.obsSlices[${at}],RCV.end`)
                }
            }
            prelude.push(`RCV.obs=new ${Observations.name}(${stream.reads})`)
            prelude.push(`RCV.obsSlices=[${obsSlices.join(',')}]`)
            prelude.push(`RCV.media={video,audio}`) // Expecting those globals in the extension.
            items[endFunc] = [`() => {
                const end = RCV.end = ${end}
                end.items = ${staticArgs.size}, end.p = new Promise(then => end.then = then)
            }`]
            state.snd = null
            const [snd, rcv] = await compileSentJS(staticArgs, items, prelude.join('\n'))
            state.snd = snd
            const w = stream.settings.width || 0
            const h = stream.settings.height || 0
            await stream.extensionPage.evaluate((rcv,w,h) => updateObservers(rcv,w,h), rcv, w, h)
            function end() { // Resolve if the last end(), and always return a promise.
                if (!--end.items) end.then()
                return end.p
            }
        }
        if (!state.snd) return
        // Call observers. The extension will call `gotObserverData` for future frames.
        //   (No `await`: the observer stream is delayed by at least a frame, to not stall.)
        const str = await state.snd(stream)
        stream.extensionPage.evaluate(str => readObservers(str), str).catch(doNothing)
    },
})



// `Object.freeze`ing this would have been good, if it didn't prevent children from defining their own `lang` and such.
const streamPrototype = docs(`This encapsulates all information about one stream of data.

To create a new stream from this prototype, use \`stream = await streamPrototype.create(relaunch = null).open(env, index)\`.

The result is a promise for the environment, which is an object with:
- \`await relink(...interfaces)\`: changes interfaces at run-time. Agents might get confused, since they likely rely on positions. (Use \`stream.relink(MODIFY(stream.interfaces))\` to handle dynamic links.)
- \`reads:Number\`: how many observations are available as floats.
- \`writes:Number\`: how many actions are available as floats.
- Low-level:
    - \`await read()\`: returns observations as -1…1 32-bit floats, NaN where not provided.
    - \`await write(Actions)\`: accepts the numeric actions, and performs them.
- \`await close()\`: ends this stream. \`env\` is not notified.
`, {
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
    lowball: .95,
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
            userProfile: stream => require('path').join(__dirname, 'puppeteer-chrome-profile-' + stream.index),
            port: 1234,
            httpsOptions: null,
        })
        // Private state.
        this._stall = null // A promise when a `relaunch` is in progress.
        this._unlink = new Set
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
            const inds = this._obsInds, obs = this._obsSlice
            const tmp = this._allocArray(0)
            waitingOn = inds.length
            for (let i = 0; i < inds.length; ++i) {
                const j = inds[i], r = this._all[j].read(this, obs[i], end)
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
                if (!a[inds[i]]) continue
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
                    try { results[i] = res._all[res._agentInds[i]].agent(...res._agentArgs[i]) }
                    catch (err) { console.error(err) } // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (results[i] instanceof Promise)
                        try { results[i] = await results[i] }
                        catch (err) { results[i] = undefined } // Unlink on exception.
                for (let i = 0; i < results.length; ++i)
                    if (!results[i])
                        res._unlink.add(res._all[res._agentInds[i]])
                res._allocArray(results)

                await res.write(res._actFloats)
            } catch (err) {
                if (!res._stall) console.error(err)
                // Do not let exceptions kill us.
            } finally {
                // Unlink the agents that do not want to live on.
                //   (Unless they're copied from the top-level, because, too much work to support that.)
                if (res._unlink.size) {
                    let prevStall = res._stall;  res._stall = res.relink(res.interfaces.filter(o => !res._unlink.has(o))), res._unlink.clear();  await prevStall
                    prevStall = res._stall;  res._stall = null;  await prevStall
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
})
async function closeAllPagesExcept(browser, page) {
    const bad = browser.targets().filter(t => t.type() === 'page' && t !== page.target()).map(t => t.page())
    for (let p of bad) (await p).close().catch(doNothing)
}



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



async function compileSentJS(staticArgs, items, prelude = '') {
    // Compiles items (`…, [thereFunc, ...sendArgs], …`) into `[sendFunc, receiveFunc]`.
    //   This handles both variables and constants, and merges receivers when they have the same body.
    //   All sent args must be JSON-serializable. And, no infinite loops.
    //   `staticArgs` is a Map from items to strings of args that go before sent args.
    //   `thereFunc` can be a string or a JS function (turned into a string).
    //     Called as `thereFunc(...staticArgs, ...sentArgs)`.
    //   `sendArgs` can be either `data` or `(...args)=>Promise<data>`.
    //   `sendFunc(...args)` will generate the string to send.
    //   `receiveFunc(str)` on receiver will process the sent string.
    //     Set up via `RCV = (new Function(receiveFunc))()`. Used via `await RCV(str)`.
    //     `RCV` can be used to store globals.
    let sendFuncs = [], prefix = [], receive = []
    receive.push(`const sent = JSON.parse(str)`)
    receive.push(`const received = new Array(${items.length})`)
    const sentStringToIndex = new Map
    const constStringToIndex = new Map
    for (let i = 0; i < items.length; ++i) {
        const item = items[i] instanceof Promise ? await items[i] : items[i]
        if (!Array.isArray(item)) throw new Error('Can only compile arrays, first received func then sent args')
        prefix.push(`RCV.F${i} = ${item[0]}`)
        const args = []
        for (let j = 1; j < item.length; ++j) {
            const arg = item[j] instanceof Promise ? await item[j] : item[j]
            if (typeof arg == 'function') { // Unknown; send it each time.
                const at = allocSent(''+arg, sentStringToIndex)
                sendFuncs[at] = arg
                args.push(`sent[${at}]`)
            } else { // Known; pre-send it.
                const at = allocSent(JSON.stringify(arg), constStringToIndex)
                args.push(`RCV.V[${at}]`)
            }
        }
        const st = staticArgs && staticArgs.get(item)
        receive.push(`received[${i}] = RCV.F${i}(${st ? st+',' : ''}${args.join(',')})`)
    }
    receive.push(`return Promise.all(received)`)
    if (constStringToIndex.size) {
        const constStrings = []
        constStringToIndex.forEach((i,str) => constStrings[i] = str)
        prefix.push(`RCV.V = [${constStrings.join(',')}]`)
    }
    prelude && prefix.push(prelude)
    return [
        bindSender(sendFuncs),
        `async function RCV(str) {${receive.join('\n')}}
        ${prefix.join('\n')}
        return RCV`]
    function allocSent(str, m) { // Returns an index in `sent`.
        if (m.has(str)) return m.get(str)
        const i = m.size;  m.set(str, i);  return i
    }
    function bindSender(sendFuncs) {
        return async function SND(...args) {
            // `await` this call to get the string that the receiver has to receive.
            return JSON.stringify(await Promise.all(sendFuncs.map(f => f(...args))))
        }
    }
}



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