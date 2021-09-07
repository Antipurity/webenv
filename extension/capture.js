// An extension for capturing video & audio.
//   Lots of changing of data formats, but I can't find a way to have less copying.

const observers = [], obsBegin = 1
let stream = null
const video = {
    ctx2d:document.createElement('canvas').getContext('2d'),
    elem:null, // ImageCapture throws far too many errors for us.
    grab(x, y, width, height, maxW, maxH) {
        // Draws the current frame onto a canvas, and returns the u8 image data array.
        //   Call this synchronously, without `await`s between you getting called and this.
        //   Returns image data.
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
    grab(samples = 2048, sampleRate = 44100, reserve = 4) {
        // Create the capturing audio context, resize .buf and .samples, then grab most-recent samples.
        //   (The samples will be interleaved, and -1..1. See this.channels to un-interleave.)
        if (!stream) return new Float32Array(0)
        if (!this.ctx) {
            // ScriptProcessorNode is probably fine, even though it's deprecated, since August 29 2014.
            this.ctx = new AudioContext({ sampleRate })
            const sourceNode = this.ctx.createMediaStreamSource(stream)
            const scriptNode = this.ctx.createScriptProcessor(512)
            scriptNode.onaudioprocess = evt => {
                if (!this.buf) return
                const input = evt.inputBuffer, output = evt.outputBuffer
                this.channels = input.numberOfChannels
                const tmp = _allocArray(this.channels).fill()
                const inputData = tmp.map((_,ch) => input.getChannelData(ch))
                _allocArray(tmp)
                for (let i = 0; i < inputData[0].length; ++i) {
                    for (let ch = 0; ch < this.channels; ++ch) {
                        this.buf[this.pos++] = inputData[ch][i]
                        if (this.pos >= this.buf.length) this.pos = 0
                    }
                }
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



function updateObservers(obsers, width, height) {
    // obsers: [...{read:String, offset:Number, length:Number}]
    //   .read gets turned into `(input, video:{grab(x,y,w,h)=>pixelsTypedArray}, audio:{grab(samples)=>sampleTypedArray}, obs)=>Promise<void>`
    //     It's responsible for filling `obs` with values.
    //   We also create the observation buffer, and per-observer observation views into it.
    let maxEnd = 0
    for (let o of obsers) maxEnd = Math.max(maxEnd, o.offset + o.length)
    observers.length = 0
    const obs = observers[0] = new Float32Array(maxEnd)
    for (let o of obsers) {
        o.read = new Function('return ' + o.read)()
        o.view = obs.subarray(o.offset, o.offset + o.length)
        observers.push(o)
    }
    // On relinking, dispose of all data. Causes brief blackouts, but allows changing sample rate, kinda.
    audio.pos = 0, audio.buf = null, audio.samples = null, audio.ctx && (audio.ctx.close(), audio.ctx = null)
    if (stream !== undefined) {
        stream = undefined
        const opt = {
            audio:true,
            video:true,
            videoConstraints:{
                mandatory:{ maxWidth:width, maxHeight:height },
            },
        }
        // chrome.tabCapture.captureOffscreenTab is an interesting proposition, but, it's funnier to be able to interact with the agent's web-page.
        chrome.tabCapture.capture(opt, s => {
            if (s) {
                stream = s
                video.elem = document.createElement('video')
                video.elem.srcObject = stream
                video.elem.volume = 0 // To not play audio to the human.
            } else throw stream = null, new Error('Stream capture failed; reason: ' + chrome.runtime.lastError.message)
        })
    }
}

async function readObservers(inputs) {
    // Read all observers, then await if needed, then return space-separated base64 observation.
    if (observers.length <= obsBegin) return ''
    const tmp = _allocArray(0)
    audio.grabbed = false
    for (let i = obsBegin; i < observers.length; ++i) {
        const o = observers[i]
        const result = o.read(inputs[i - obsBegin], video, audio, o.view)
        if (result instanceof Promise) tmp.push(result)
    }
    for (let i = 0; i < tmp.length; ++i) await tmp[i]
    _allocArray(tmp)
    return await toBase64(encodeInts(observers[0]))
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