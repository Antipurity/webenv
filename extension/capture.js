// An extension for capturing video & audio.
//   Lots of changing of data formats, but I can't find a way to have less copying.

let RCV = null, STR = []
let stream = null, streamW = 0, streamH = 0, streamSR = 0
let lastRequest = performance.now(), timeBetweenRequests = [0,0,0]

// Limit how many observers can run at once.
//   (Don't have hanging-observer bugs, or else the page will stall forever.)
let stepsNow = 0, simultaneousSteps = 16



async function getStream(width, height, sampleRate) {
    // (Should probably also measure frame-rate, and re-request the stream on too much deviation.)
    if (stream instanceof Promise || streamW >= width && streamH >= height && streamSR >= sampleRate)
        return stream
    const haveTabCapture = typeof chrome != ''+void 0 && chrome.tabCapture && chrome.tabCapture.capture
    streamW = Math.max(streamW, width)
    streamH = Math.max(streamH, height)
    streamSR = Math.max(streamSR, sampleRate)
    const opt = haveTabCapture ? {
        audio:true,
        video:true,
        videoConstraints:{
            // Docs are sparse.
            mandatory:{ maxWidth:streamW, maxHeight:streamH },
        },
    } : {
        audio:{
            channelCount: 1,
            sampleRate:streamSR, sampleSize:512,
        },
        video:{
            logicalSurface: true,
            displaySurface: 'browser',
            width:streamW, height:streamH,
        },
    }
    let reapplied = false
    if (stream)
        for (let track of stream.getTracks())
            if (track.applyConstraints)
                track.applyConstraints(opt), reapplied = true
    if (reapplied) return
    if (stream)
        for (let track of stream.getTracks())
            track.stop()
    return stream = new Promise((resolve, reject) => {
        if (haveTabCapture)
            chrome.tabCapture.capture(opt, gotStream)
        else
            navigator.mediaDevices.getDisplayMedia(opt).then(gotStream).catch(err => gotStream(null))
        function gotStream(s) {
            if (s) {
                s.w = width, s.h = height
                stream = s
                video.elem = document.createElement('video')
                video.elem.srcObject = s
                video.elem.volume = 0 // To not play audio to the human.
                resolve(s)
            } else
                stream = null, streamW = streamH = 0,
                reject(new Error('Stream capture failed; reason: ' + chrome.runtime.lastError.message))
        }
    })
}
const video = {
    ctx2d:document.createElement('canvas').getContext('2d'),
    elem:null, // ImageCapture throws far too many errors for us.
    async grab(x, y, width, height, maxW, maxH) {
        // Draws the current frame onto a canvas, and returns the u8 image data array.
        //   Call this synchronously, without `await`s between you getting called and this.
        //   Returns image data.
        await getStream(maxW, maxH, 44100)
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
}
const audio = {
    pos:0,
    buf:null,
    samples:null,
    ctx:null,
    grabbed:false,
    channels:0,
    sampleRate:null, // Re-inits .ctx on sample-rate change (so, keep it constant).
    async grab(samples = 2048, sampleRate = 44100, reserve = 4) {
        // Create the capturing audio context, resize .buf and .samples, then grab most-recent samples.
        //   (The samples will be interleaved, and -1..1. See this.channels to un-interleave.)
        const stream = await getStream(0, 0, sampleRate)
        if (!stream) return new Float32Array(0)
        if (!this.ctx || this.sampleRate !== sampleRate) {
            // ScriptProcessorNode is probably fine, even though it's been deprecated since August 29 2014.
            this.ctx && this.ctx.clise()
            this.sampleRate = sampleRate
            this.ctx = new AudioContext({ sampleRate })
            const sourceNode = this.ctx.createMediaStreamSource(stream)
            const scriptNode = this.ctx.createScriptProcessor(512)
            scriptNode.onaudioprocess = evt => {
                if (!this.buf) return
                const input = evt.inputBuffer
                const channels = this.channels = input.numberOfChannels
                const tmp = _allocArray(channels).fill()
                const inputData = tmp.map((_,ch) => input.getChannelData(ch))
                _allocArray(tmp)
                let pos = this.pos, buf = this.buf
                for (let i = 0; i < inputData[0].length; ++i) {
                    for (let ch = 0; ch < channels; ++ch) {
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
}



function updateObservers(rcv) {
    RCV = (new Function(rcv))()
}



// Desynchronize reads, to be robust to dropped packets (which "one response per one request" is not).
function timer() {
    const t = timeBetweenRequests[1]
    setTimeout(timer, STR.length < 2 ? t : t*.9)
    if (stepsNow < simultaneousSteps) processObservers()
}
setTimeout(timer, 0)

async function readObservers(str) {
    STR.push(str), STR.length > 8 && STR.shift()
    const next = performance.now()
    signalUpdate(next - lastRequest, timeBetweenRequests, 1000)
    lastRequest = next
}
function processObservers() {
    if (!STR.length) return // Wait for the first request.
    if (STR.length == 1) STR.push(STR[0]) // Re-use the last message if we can.
    ++stepsNow
    RCV && RCV(STR.shift()).then(sendObserverDataBack, processingFailed)
}
function processingFailed(err) { --stepsNow, typeof PRINT == 'function' && PRINT(err.stack) }
function sendObserverDataBack() {
    --stepsNow
    if (typeof gotObserverData == ''+void 0) return
    toBase64(encodeInts(RCV.obs)).then(gotObserverData)
}

function encodeInts(d) {
    // Encoding floats in JSON & base64 sure is slow, so send 2 bytes per value instead of 4.
    const into = new Int16Array(d.length)
    for (let i = 0; i < into.length; ++i)
        into[i] = d[i] !== d[i] ? -32768 : Math.round(Math.max(-1, Math.min(d[i], 1)) * 32767)
    return into
}
function toBase64(a) {
    // Communication is done using JSON, and thus, passing binary strings is a 2.5× overhead.
    const bytes = a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const blob = new Blob([bytes], {type:'application/octet-binary'})
    const reader = new FileReader
    let then
    reader.onload = () => then(btoa(reader.result))
    return new Promise(f => {
        then = f
        reader.readAsBinaryString(blob)
    })
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
function signalUpdate(value, moments = [0,0,0], maxHorizon = 10000) {
    // Updates count & mean & variance estimates of `moments` in-place.
    //   (Make sure that `value` is sane, such as `-1e9`…`1e9`. And not normalized.)
    const prevMean = moments[1], n1 = moments[0], n2 = n1+1, d = value - moments[1]
    if (n2 <= maxHorizon)
        moments[0] = n2
    moments[1] += d / n2
    moments[2] = (moments[2] * n1 + d * (value - prevMean)) / n2
    if (!isFinite(moments[1]) || !isFinite(moments[2]))
        moments[0] = moments[1] = moments[2] = 0
    return moments
}