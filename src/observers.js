// Here lies the mechanism to communicate with extensions, both Puppeteered and user.
//   Capturing & decoding an individual tab's video+audio stream might as well be impossible without an extension, so this is always used.



const { Observations } = require('./stream-prototype.js')
const { compileSentJS, collapseWhitespace } = require('./compile-sent-js.js')
const { encodeInts, decodeInts } = require('./int-encoding.js')
const { webSocketUpgrade, webSocket, writeToChannel, readFromChannel } = require('./data-channels.js')



const observers = exports.observers = {
    docs:`The shared interface for extension-side code, such as video/audio grabbing.

To be used by bundling other interfaces with this; duplicate occurences will be merged.

Extensions/pages should connect like:

\`\`\`js
let toCancel
const socket = new WebSocket(…url…)
socket.binaryType = 'arraybuffer', socket.onmessage = evt => {
    toCancel = new Function(new TextDecoder().decode(evt.data))()(socket, { bytesPerValue:1|2|4 })
}
\`\`\`

(And do \`toCancel()\` to disconnect.)

(To make interface modules handle connections, use \`handleUpgrade\` from this file: \`stream.env.upgrade('/path', (...a) => handleUpgrade(stream, ...a))\`.)

Other interfaces that want this ought to define, for the 3 execution contexts (WebEnv, extension, and its per-page content script):
- WebEnv: \`reactToObserver(stream, result)\`.
  - If this is defined, \`observer\` below should return a JSON-serializable result, as small as possible (else the data stream may close). Having \`1024\` total bytes is definitely safe. Per-frame JSON is expensive.
  - (Might want to double-check that \`result\` did come from your \`observer\` and not another one.)
  - Log with \`console.error\`.
- Extension: \`.observer: [(media, { obs, pred, act }, end, ...args)=>…, ...args]\`
  - Can access video/audio; cannot access the DOM.
  - Calling \`await end()\` at the end or just before writing to \`obs\` (f32 array) is MANDATORY.
  - Communication cost is reduced as much as possible without compression, don't worry.
  - Computed args get the \`stream\`.
  - Media access:
    - \`await media.video(x,y,w,h)=>pixels\`
    - \`await media.audio(sampleN=2048, sampleRate=44100)=>samples\`
  - Log with \`PRINT\` if present.
- Content script: \`.inject: [(...args)=>report, ...args]\`
  - Cannot access video/audio; can access the DOM.
  - If executing in a regular web page, \`.observer\` and \`.inject\` execute in the same scope, which is also visible to page JS.
  - Result must be JSON-serializable. It will become the result of \`await end()\` in \`.observer\` (or \`null\` on exception or timeout or before injection).
  - Log with \`console.log\`.
`,
    key: Symbol('observers'),
    async init(stream) {
        const spot = Spot(stream)
        stream.env.upgrade('/'+spot.id, (...a) => handleUpgrade(stream, ...a))
        if (!stream.extensionPage) return
        stream.extensionPage.exposeFunction('PRINT', console.error) // For debugging.
        // Auto-connect if Puppeteer-controlled.
        const secure = stream.settings.httpsOptions ? 's' : ''
        const bpv = 1 // The most important setting. (`1` loses audio info, compared to `2`.)
        await stream.extensionPage.evaluate(
            `const socket = new WebSocket("ws${secure}://localhost:${stream.settings.port}/${spot.id}")
            socket.binaryType = 'arraybuffer', socket.onmessage = evt => {
                new Function(new TextDecoder().decode(evt.data))()(socket, {bytesPerValue:${bpv}})
            }`,
        )
    },
    deinit(stream) {
        const spot = Spot(stream)
        stream.env.upgrade('/'+spot.id)
        spot.ended = true
    },
    async read(stream, obs, _) {
        const spot = Spot(stream)
        if (!spot.ch || spot.byteswap == null || !spot.cons || !spot.pred || !spot.act) return
        if (spot.snd === undefined || spot.all !== stream._all) {
            // Relink extension-side observers.
            spot.all = stream._all
            const [snd, rcv] = await compileJS(stream)
            spot.snd = snd
            const rcvBuf = new Uint8Array(Buffer.from(rcv))
            await Promise.all([
                writeToChannel(spot.ch, 0xffffffff, false),
                writeToChannel(spot.ch, rcvBuf.length, spot.byteswap),
                writeToChannel(spot.ch, rcvBuf, false),
                spot.ch.skip(),
            ])
        }
        if (!spot.snd) return
        // Call observers. The extension will call `gotObserverData` for future frames.
        //   (No `await`: the observer stream is delayed by at least a frame, to not stall.)
        const str = await spot.snd(stream)
        const strBuf = new Uint8Array(Buffer.from(str))
        if (!spot.predEncoded) spot.predEncoded = new spot.cons(0)
        if (!spot.actEncoded) spot.actEncoded = new spot.cons(0)
        await Promise.all([
            writeToChannel(spot.ch, spot.pred.length, spot.byteswap),
            writeToChannel(spot.ch, spot.predEncoded = encodeInts(spot.pred, spot.predEncoded), spot.byteswap),
            writeToChannel(spot.ch, spot.act.length, spot.byteswap),
            writeToChannel(spot.ch, spot.actEncoded = encodeInts(spot.act, spot.actEncoded), spot.byteswap),
            writeToChannel(spot.ch, strBuf.length, spot.byteswap),
            writeToChannel(spot.ch, strBuf, false),
            spot.ch.skip(),
        ])
    },
    write(stream, pred, act) {
        const spot = Spot(stream)
        if (!spot.ch) return
        const show = !stream.settings.hidePredictions
        spot.pred = show ? pred : (spot.pred || new pred.constructor(0)), spot.act = act
    },
}



const handleUpgrade = exports.handleUpgrade = (stream, ...args) => webSocketUpgrade(...args).then(ch => {
    Spot(stream).ch = ch

    // Write how to connect. (In one message, with no length before it.)
    //   Do `msg => new Function(msg)()({bytesPerValue}, socket)`
    const str = collapseWhitespace('return ' + String(connectChannel).replace(/TO_CHANNEL/, ''+webSocket))
    ch.write(new Uint8Array(Buffer.from(str)))

    readAllData(stream, ch)
    return [ch, () => Spot(stream).ended = true] // Return the channel (with settable `.onClose`) and a cancellation func.
})



async function readAllData(stream, ch) {
    // Protocol (we're right-to-left):
    //   Start → 0xFFFFFFFF 0x01020304 JsonLen Json (For {bytesPerValue: 1|2|4}.)
    //   0xFFFFFFFF JsLen Js → update (`RCV = new Function(Js)()`)
    //   PredLen Pred ActLen Act JsonLen Json → ObsLen Obs
    const spot = Spot(stream)
    while (!spot.ended)
        try {
            const obsLen = await readFromChannel(ch, 1, Number, spot.byteswap)
            if (obsLen === 0xffffffff) {
                const magic = await readFromChannel(ch, 1, Number, false)
                if (magic === 0x01020304) spot.byteswap = false
                else if (magic === 0x04030201) spot.byteswap = true
                else return ch.close()
                const jsonLen = await readFromChannel(ch, 1, Number, spot.byteswap)
                if (jsonLen > stream.maxIOArraySize) return ch.close()
                const json = await readFromChannel(ch, jsonLen, Uint8Array, false)
                const jsonStr = Buffer.from(json).toString('utf8')
                const obj = JSON.parse(jsonStr)
                const intSize = obj.bytesPerValue
                if (![1,2,4].includes(intSize)) throw new Error('Bad intSize: '+intSize)
                spot.cons = intSize === 4 ? Float32Array : intSize === 1 ? Int8Array : Int16Array
            } else {
                if (obsLen > stream.maxIOArraySize) return ch.close()
                const obs = await readFromChannel(ch, obsLen, spot.cons, spot.byteswap)
                decodeInts(obs, stream._obsFloats) // No resizing here. `directLink` can fend for itself.
                const jsonLen = await readFromChannel(ch, 1, Number, spot.byteswap)
                if (jsonLen) {
                    if (jsonLen > stream.maxIOArraySize) return ch.close()
                    const jsonBytes = await readFromChannel(ch, jsonLen, Uint8Array, spot.byteswap)
                    let json
                    try { json = JSON.parse(Buffer.from(jsonBytes, 'utf8')) }
                    catch (err) {} // Do nothing with bad JSON.
                    let j = 0
                    if (Array.isArray(json) && spot.reactToObserverInds) // And react.
                        for (let i of spot.reactToObserverInds)
                            stream._all[i].reactToObserver(stream, json[j++])
                }
            }
        } catch (err) { if (err !== 'skip') return ch.close(), console.error(err) }
    ch.close()
}



async function compileJS(stream) {
    const spot = Spot(stream)
    const reactToObserverInds = []
    const items = [], staticArgs = new Map, prelude = [], needReaction = []
    const cons = spot.cons, bpe = cons.BYTES_PER_ELEMENT
    items.push([`() => {
        const p = RCV.pred;  RCV.P = decodeInts(new ${cons.name}(p.buffer, p.byteOffset, p.byteLength/${bpe} | 0), RCV.P, true)
        const a = RCV.act;  RCV.A = decodeInts(new ${cons.name}(a.buffer, a.byteOffset, a.byteLength/${bpe} | 0), RCV.A, true)
    }`]) // Reinterpret pred/act bytes as f32/i8/i16.
    const endFunc = items.push([`()=>{}`])-1
    const injected = [(end, ...args) => { // Handle `inject` definers.
        if (tabId != null) {
            return new Promise(then => {
                // Send a message to the active tab. (If not in an extension, just call.)
                if (typeof chrome!=''+void 0 && chrome.tabs) chrome.tabs.sendMessage(tabId, args, then)
                else window.onMSG(args, null, then)
                setTimeout(then, 200) // Don't wait for stalls infinitely.
            }).then(a => end(a))
        }
    }], injectedParts = [];  items.push(injected)
    for (let i = 0; i < stream._all.length; ++i) {
        const o = stream._all[i]
        const item = await o.observer, inj = await o.inject, react = await o.reactToObserver
        if (Array.isArray(item)) {
            // Prepare the observer's extra args.
            const offR = stream._allReadOffsets[i], lenR = o.reads || 0
            const offW = stream._allWriteOffsets[i], lenW = o.writes || 0
            items.push(item)
            const p = `RCV.P.subarray(${offR}, ${lenR==='rest' ? '' : offR + lenR})`
            const a = `RCV.A.subarray(${offW}, ${lenW==='rest' ? '' : offW + lenW})`
            const obs = `RCV.obs.subarray(${offR}, ${lenR==='rest' ? '' : offR + lenR})`
            // Injectors read injection results; all others do not have closures allocated on each step.
            const e = !Array.isArray(inj) ? `RCV.end` : `bindInjEnd(RCV.end, ${injectedParts.length})`
            staticArgs.set(item, `RCV.media,{pred:${p},act:${a},obs:${obs}},${e}`)
            if (typeof react == 'function')
                needReaction.push(items.length-1), reactToObserverInds.push(i)
        }
        if (Array.isArray(inj)) {
            // Its args will be `injected`'s args (so that they go through `compileSentJS`).
            // The injected code will (receive them and) access those args (and send result back).
            const from = injected.length-1, to = from + inj.length-1
            injected.push(...inj.slice(1))
            const args = new Array(to-from).fill().map((_,i) => `a[${from + i}]`)
            injectedParts.push([''+inj[0], ...args])
        }
    }
    items.push([async function encode() {
        await RCV.end(), await Promise.resolve()
        RCV.obsEncoded = encodeInts(RCV.obs, RCV.obsEncoded)
    }])
    items[endFunc] = [`() => {
        const end = RCV.end = ${end}
        end.inj = null, end.items = ${staticArgs.size + (injectedParts.length ? 2 : 1)}, end.p = new Promise(then => end.then = then)
    }`] // Account for all end() calls: injector, obs-encoder, and all observers.
    staticArgs.set(injected, `RCV.end`)
    prelude.push(`function bindInjEnd(end,i) { return ()=>end().then(a=>a&&a[i]) }`)
    prelude.push(`RCV.obs=new ${Observations.name}(${stream.reads})`)
    prelude.push(`RCV.obsEncoded=new ${cons.name}(0)`)
    // Imagine not having JS highlighting for strings, and considering such code unreadable.
    prelude.push(`RCV.media={
        stream:null, w:0, h:0, sr:0,
        async getStream(width, height, sampleRate) {
            // (Should probably also measure frame-rate, and re-request the stream on too much deviation.)
            if (this.stream instanceof Promise || this.w >= width && this.h >= height && this.sr >= sampleRate)
                return this.stream
            const haveTabCapture = typeof chrome!=''+void 0 && chrome.tabCapture && chrome.tabCapture.capture
            this.w = Math.max(this.w, width)
            this.h = Math.max(this.h, height)
            this.sr = Math.max(this.sr, sampleRate)
            const opt = haveTabCapture ? {
                audio:true,
                video:true,
                videoConstraints:{
                    // Docs are sparse.
                    mandatory:{ maxWidth:this.w, maxHeight:this.h },
                },
            } : {
                audio:{
                    channelCount: 1,
                    sampleRate:this.sr, sampleSize:512,
                },
                video:{
                    logicalSurface: true,
                    displaySurface: 'browser',
                    width:this.w, height:this.h,
                },
            }
            let reapplied = false
            if (this.stream)
                for (let track of this.stream.getTracks())
                    if (track.applyConstraints)
                        track.applyConstraints(opt), reapplied = true
            if (reapplied) return
            if (this.stream)
                for (let track of this.stream.getTracks())
                    track.stop()
            return this.stream = new Promise((resolve, reject) => {
                const gotStream = (s, err) => {
                    if (s) {
                        this.stream = s
                        this.elem = document.createElement('video')
                        this.elem.srcObject = s
                        this.elem.volume = 0 // To not play audio to the human.
                        resolve(s)
                    } else {
                        this.stream = null, this.w = this.h = 0
                        const msg = haveTabCapture ? chrome.runtime.lastError.message : ''+err
                        reject(new Error('Stream capture failed; reason: ' + msg))
                    }
                }
                if (haveTabCapture)
                    chrome.tabCapture.capture(opt, gotStream)
                else
                    navigator.mediaDevices.getDisplayMedia(opt).then(gotStream).catch(err => gotStream(null, err))
            })
        },
        ctx2d:document.createElement('canvas').getContext('2d'),
        elem:null, // ImageCapture throws far too many errors for us.
        async video(x, y, width, height, maxW, maxH) {
            // Draws the current frame onto a canvas, and returns the u8 image data array.
            //   Call this synchronously, without \`await\`s between you getting called and this.
            //   Returns image data.
            await this.getStream(maxW, maxH, 44100)
            if (!this.elem) return new Uint8Array(0)
            if (this.elem.paused) this.elem.play()
            const ctx = this.ctx2d, w1 = ctx.canvas.width, h1 = ctx.canvas.height
            const w2 = this.elem.videoWidth, h2 = this.elem.videoHeight
            if (w1 < w2 || h1 < h2) ctx.canvas.width = w2, ctx.canvas.height = h2
            const sx = w2 / maxW || 0, sy = h2 / maxH || 0
            ctx.clearRect(0, 0, width, height)
            ctx.drawImage(this.elem, x * sx, y * sy, width * sx, height * sy, 0, 0, width, height)
            return this.ctx2d.getImageData(0, 0, width, height).data
        },
    
        pos:0,
        buf:null,
        samples:null,
        ctx:null,
        grabbed:false,
        channels:0,
        sampleRate:null, // Re-inits .ctx on sample-rate change (so, keep it constant).
        async audio(samples = 2048, sampleRate = 44100, reserve = 4) {
            // Create the capturing audio context, resize .buf and .samples, then grab most-recent samples.
            //   (The samples will be interleaved, and -1..1. See this.channels to un-interleave.)
            const stream = await this.getStream(0, 0, sampleRate)
            if (!stream) return new Float32Array(0)
            if (!this.ctx || this.sampleRate !== sampleRate) {
                // ScriptProcessorNode is probably fine, even though it's been deprecated since August 29 2014.
                this.ctx && this.ctx.clise()
                this.sampleRate = sampleRate
                this.ctx = new AudioContext({ sampleRate })
                const sourceNode = this.ctx.createMediaStreamSource(stream)
                const scriptNode = this.ctx.createScriptProcessor(512)
                const inputData = []
                scriptNode.onaudioprocess = evt => {
                    if (!this.buf) return
                    const input = evt.inputBuffer
                    const channels = this.channels = input.numberOfChannels
                    inputData.length = channels
                    for (let i = 0; i < inputData[0].length; ++i)
                        inputData[i] = input.getChannelData(i)
                    let pos = this.pos, buf = this.buf
                    for (let i = 0; i < inputData[0].length; ++i) {
                        for (let ch = 0; ch < channels; ++ch) { // Interleave.
                            buf[pos++] = inputData[ch][i]
                            if (pos >= buf.length) pos = 0
                        }
                    }
                    this.pos = pos
                    // Do not write anything to output, to be silent.
                }
                sourceNode.connect(scriptNode)
                scriptNode.connect(this.ctx.destination)
            }
            const bufLen = samples * reserve | 0
            if (!this.buf) this.buf = new Float32Array(bufLen)
            else if (this.buf.length < bufLen) {
                const prev = this.buf
                this.buf = new Float32Array(bufLen)
                this.buf.set(prev)
            }
            if (this.grabbed && this.samples && this.samples.length === samples) return this.samples
            this.grabbed = true
            if (!this.samples || this.samples.length !== samples) this.samples = new Float32Array(samples)
            const start = Math.max(0, this.pos - samples), initialLen = this.pos - start
            const extra = Math.max(0, samples - this.pos)
            const buf = this.buf.buffer, offset = this.buf.byteOffset, bpe = Float32Array.BYTES_PER_ELEMENT
            this.samples.set(new Float32Array(buf, offset + start * bpe, initialLen), 0)
            extra && this.samples.set(new Float32Array(buf, offset + (this.buf.length - extra) * bpe, extra), initialLen)
            return this.samples
        },
    }`)
    prelude.push(''+encodeInts)
    prelude.push(''+decodeInts)
    if (injectedParts.length) {
        // JS-`inject`ion stuff:
        //   Update the injected code on startup and page navigation (and relink).
        prelude.push(`function updateInjection() {
            if (tabId == null) return
            const injection = ${JSON.stringify(`
                if (window.onMSG && typeof chrome!=''+void 0 && chrome.runtime) chrome.runtime.onMessage.removeListener(window.onMSG)
                ${injectedParts.map((a,i) => 'window.F'+i + '=' + a[0]).join('\n')}
                window.onMSG = (a, sender, sendResponse) => {
                    Promise.all([${injectedParts.map((a,i) => 'F'+i+'('+a.slice(1)+')')}]).then(sendResponse, sendResponse)
                    return true
                }
                if (typeof chrome!=''+void 0 && chrome.runtime) chrome.runtime.onMessage.addListener(window.onMSG)
            `)}
            if (typeof chrome!=''+void 0 && chrome.tabs) chrome.tabs.executeScript(tabId, { code:injection, runAt:'document_start' })
            else new Function(injection)()
        }`)
        prelude.push(`
        if (typeof chrome!=''+void 0 && chrome.tabs) {
            if (window.onNavigation) chrome.tabs.onUpdated.removeListener(window.onNavigation)
            chrome.tabs.onUpdated.addListener(window.onNavigation = updateInjection)
        }
        `)
        //   Remember the tab ID that started this.
        prelude.push(`let tabId`)
        prelude.push(`
        if (typeof chrome!=''+void 0 && chrome.tabs) {
            const setId = tabs => tabs[0] && (tabId = tabs[0].id, updateInjection())
            chrome.tabs.query({active:true, currentWindow:true}, setId)
        }
        `)
    } else {
        items.splice(items.indexOf(injected), 1)
        for (let i=0; i < needReaction.length; ++i) --needReaction[i]
    }
    // And compile to [sendFunc, receiveStr].
    spot.snd = null
    const postlude = needReaction ? `r => RCV.result = [${needReaction.map(i => `r[${i}]`).join(',')}]` : ''
    try { return await compileSentJS(staticArgs, items, prelude.join('\n'), postlude) }
    finally { spot.reactToObserverInds = reactToObserverInds }
    function end(inj) { // Resolve if the last end(), and always return a promise.
        if (Array.isArray(inj)) end.inj = inj
        if (!--end.items) end.then(end.inj)
        return end.p
    }
}



function connectChannel(socket, opts) {
    // Starts capturing. To stop, call the returned func.
    // In `opts`, `bytesPerValue` is 1 (int8) or 2 (int16) or 4 (float32).
    const channel = TO_CHANNEL(socket)
    let flowing = true, timerID = null

    let RCV = null, Data = []
    let lastRequest = performance.now(), timeBetweenRequests = [0,0]
    
    // Limit how many observers can run at once.
    //   (Don't have hanging-observer bugs, or else the page will stall forever.)
    let stepsNow = 0, simultaneousSteps = 16

    const encoder = new TextEncoder(), decoder = new TextDecoder()

    readAllData()
    return function stopCapture() { flowing = false, clearTimeout(timerID), channel.close() }
    async function readAllData() {
        // Protocol (we're left-to-right):
        //   Start → 0xFFFFFFFF 0x01020304 JsonLen Json (For {bytesPerValue: 1|2|4}.)
        //   0xFFFFFFFF JsLen Js → update (`RCV = new Function(Js)()`)
        //   PredLen Pred ActLen Act JsonLen Json → ObsLen Obs
        await writeIntro()
        while (flowing)
            try {
                const predLen = await readU32()
                if (predLen === 0xffffffff) {
                    const js = await channel.read(await readU32())
                    const jsStr = decoder.decode(js.buffer)
                    try { RCV = new Function(jsStr)() }
                    catch (err) { typeof PRINT == 'function' && PRINT(err.message);  throw err }
                } else {
                    const pred = await channel.read(predLen)
                    const act = await channel.read(await readU32())
                    const json = await channel.read(await readU32())
                    const jsonStr = decoder.decode(json.buffer)
                    scheduleObservers(pred, act, jsonStr)
                }
            } catch (err) { if (err !== 'skip') throw err }
    }
    async function writeIntro() {
        // Could be bad with unreliable channels.
        const opts2 = Object.assign({}, opts)
        delete opts2['url']
        const jsonBytes = encoder.encode(JSON.stringify(opts2))
        await Promise.all([
            writeU32(0xffffffff),
            writeU32(0x01020304),
            writeU32(jsonBytes.length),
            channel.write(jsonBytes),
            channel.skip(),
        ])
    }



    // Desynchronize reads, to be robust to dropped packets
    //   (which "one response per one request" is not).
    function timer() {
        const t = timeBetweenRequests[1]
        timerID = setTimeout(timer, Data.length < 2 ? t : t*.9)
        if (stepsNow < simultaneousSteps) processObservers()
    }
    
    async function scheduleObservers(pred, act, json) {
        Data.push([pred, act, json]), Data.length > 8 && Data.shift()
        const next = performance.now()
        signalUpdate(next - lastRequest, timeBetweenRequests, 1000)
        lastRequest = next
        if (timerID == null) timerID = setTimeout(timer, 0) // Start processing.
    }
    function signalUpdate(value, moments = [0,0], maxHorizon = 10000) { // Calc mean.
        const n2 = moments[0]+1
        if (n2 <= maxHorizon) moments[0] = n2
        moments[1] += (value - moments[1]) / n2
        return moments
    }
    function processObservers() {
        if (!Data.length) return // Wait for the first request.
        if (Data.length == 1) Data.push(Data[0]) // Re-use the last message if we can.
        const [pred, act, json] = Data.shift()
        ++stepsNow
        RCV.pred = pred, RCV.act = act
        RCV && RCV(json).then(sendObserverDataBack, processingFailed)
    }
    function processingFailed(err) { --stepsNow, typeof PRINT == 'function' && PRINT(err.stack) }
    async function sendObserverDataBack() {
        --stepsNow
        const o = RCV.obsEncoded
        const jsonBytes = encoder.encode(JSON.stringify(RCV.result))
        await Promise.all([
            writeU32(o.length),
            channel.write(new Uint8Array(o.buffer, o.byteOffset, o.byteLength)),
            writeU32(jsonBytes.length),
            channel.write(jsonBytes),
            channel.skip(),
        ])
    }
    async function readU32() { // Native endianness.
        const b = await channel.read(4)
        return (new Uint32Array(b.buffer, b.byteOffset, 1))[0]
    }
    async function writeU32(x) { // Native endianness.
        const a = writeU32.a || (writeU32.a = new Uint32Array(1))
        a[0] = x
        return channel.write(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    }
}



function Spot(s) {
    s = s[observers.key] || (s[observers.key] = Object.create(null))
    if (!s.id) s.id = randomChars(32)
    return s
}
function randomChars(len) {
    return new Array(len).fill().map((_,i) => (Math.random()*16 | 0).toString(16)).join('')
}