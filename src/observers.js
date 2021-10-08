// Here lies the mechanism to communicate with extensions, both Puppeteered and user.
//   Capturing & decoding an individual tab's video+audio stream might as well be impossible without an extension, so this is always used.



const { Observations } = require('./stream-prototype.js')
const { compileSentJS } = require('./compile-sent-js.js')
const { encodeInts, decodeInts } = require('./int-encoding.js')



exports.observers = {
    docs:`The shared interface for extension-side video and audio grabbing.

To be used by bundling other interfaces with this; duplicate occurences will be merged.

Other interfaces that want this must define:
- \`.observer: [({video, audio}, obs, end, ...args)=>…, ...args]\`
  - Computed args get the \`stream\`.
  - Communication cost is reduced as much as possible without compression, don't worry.
  - Calling \`await end()\` at the end or just before writing to \`obs\` (f32 array) is mandatory.
  - \`video:{grab(x,y,w,h)=>pixels}\`
  - \`audio:{grab(sampleN=2048, sampleRate=44100)=>samples\`
// TODO: Connect & communicate through a WebSocket. (If Puppeteer-controlled, auto-call \`connect(\`ws://localhost/\${s.env.settings.port}\`)\`.)
// TODO: Also give the previous actions to observers, so that the extension can perform them for us. (Would need a separate binary-ish stream for this, to not waste time+bandwidth on base64+JSON-encoding actions. Post-web-socket.)
//   (And the previous predictions, so that users can visualize those. But only if a setting is checked.)
`,
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
            await stream.extensionPage.evaluate((rcv,w,h) => updateObservers(rcv,w,h), rcv)
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
}
function doNothing() {}