// This defines creators of (message-oriented, real-time, bidirectional) data channels that have:
//   `await ch.write(bytes)` to write some bytes.
//     (To write an atomic packet, `await Promise.all([…, ch.write(…), ch.skip()])`.)
//   `ch.skip()` after each message, to delimit what to skip to if packets are dropped.
//   `await ch.read(len)→bytes`, which can `throw 'skip'`, to resume reading at the next skip.
//   `ch.close()` to end this existence.
//   Settable `ch.onClose=null` to react to the end.
// As a bonus, to send a channel creator's JS elsewhere, simply `''+func`.
// As another bonus, at the end are some utilities for maybe-byteswapped read/write, NodeJS-only.



let WebSocket = null



exports.streams = function streams(read = process.stdin, write = process.stdout) {
  // This simply reads from Readable and writes to Writable streams.
  // Reliable, so `.read` will never throw.
  if (!streams.R) streams.R = new WeakSet, streams.W = new WeakSet
  if (streams.R.has(read)) throw new Error('Already reading the stream')
  if (streams.W.has(write)) throw new Error('Already writing the stream')
  streams.R.add(read), streams.W.add(write)
  const thens = [], reqs = []
  let closed = false
  function onDrain() {
    thens.forEach(f => f()), thens.length = 0
  }
  function uncork() { write.uncork() }
  function onReadable() {
    while (reqs.length) { // [..., len, then, ...]
      const chunk = read.read(reqs[0])
      if (!chunk) return
      reqs.splice(0,2)[1](chunk)
    }
  }
  function readBytes(len) { // len≥0
    if (len === 0) return new Uint8Array(0)
    if (len < 0) throw 'no'
    return new Promise(resolve => {
      reqs.push(len, resolve), onReadable()
    })
  }
  read.on('readable', onReadable)
  read.on('close', () => result.close())
  write.on('drain', onDrain)
  write.on('error', () => {}) // Ignore "other end has closed" errors.
  const result = {
    write(bytes) {
      // Can be `await`ed to wait until the buffer gets emptier.
      write.cork()
      process.nextTick(uncork)
      if (!write.write(bytes))
        return new Promise(then => thens.push(then))
    },
    skip() {},
    read(len) { return readBytes(len) },
    close() {
      if (!closed) read.destroy(), write.destroy(), typeof this.onClose == 'function' && this.onClose(), closed = true
    },
  }
  return result
}



exports.webSocketUpgrade = function webSocketUpgrade(request, socket, head) {
  // Given an HTTP/S `server`, do
  //   `server.on('upgrade', (...args) => webSocketUpgrade(...args).then(channel => …))`
  return new Promise(then => {
    const fn = webSocketUpgrade
    const wss = fn.wss || (fn.wss = new (require('ws').WebSocketServer)({ noServer:true }))
    wss.handleUpgrade(request, socket, head, ws => then(exports.webSocket(ws)))
  })
}
exports.webSocket = function webSocket(ws) {
  // Wraps a WebSocket (or a URL to it) for reliable channel communication.
  if (!WebSocket) WebSocket = require('isomorphic-ws')
  if (typeof ws == 'string') ws = new WebSocket(ws)
  ws.binaryType = 'arraybuffer'
  let opened = ws.readyState === 0 ? new Promise(then => ws.onopen = then) : 0
  let closed = false
  const msgs = [], reqs = []
  ws.onmessage = onReadable
  ws.onerror = null
  ws.onclose = evt => result.close()
  const result = {
    async write(bytes) {
      let b = bytes.buffer
      if (opened || bytes.byteOffset || (bytes.byteLength || bytes.length) !== b.byteLength)
        b = b.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength || bytes.length))
      if (opened) await opened, opened = null
      ws.send(b)
    },
    skip() {},
    async read(len) {
      if (opened) await opened, opened = null
      return readBytes(len)
    },
    close() {
      if (!closed) ws.close(), typeof this.onClose == 'function' && this.onClose(), closed = true
    },
  }
  return result
  function toU8(b) { // Normalize the very annoying buffers, trying to avoid a copy.
    if (b instanceof ArrayBuffer) return new Uint8Array(b)
    if (b.byteOffset & 3) return new Uint8Array(b) // Ensure alignment via copy.
    if (b instanceof Uint8Array) return b
    return new Uint8Array(b.buffer, b.byteOffset, b.length)
  }
  function onReadable(evt) {
    // Satisfy `readBytes` requests:
    //   concat too-small chunks, slice too-big chunks, return just-right chunks.
    evt && msgs.push(toU8(evt.data))
    while (reqs.length && msgs.length) { // [..., len, then, ...]
      const len = reqs[0], then = reqs[1], chunk = msgs[0]
      if (chunk.length < len) {
        let our = 0, i = 0
        for (; i < msgs.length && our < len; ++i) our += msgs[i].length
        if (our < len) return
        const chunks = msgs.splice(0, i)
        const one = new Uint8Array(our)
        for (let j = 0, at = 0; j < i; at += chunks[j++].length)
          one.set(chunks[j], at)
        msgs.unshift(one)
      }
      // Quadratic-shifting, but, this is for real-time communications.
      if (chunk.length === len) { msgs.shift(), reqs.splice(0,2), then(toU8(chunk));  continue }
      else if (chunk.length > len) {
        const pre = chunk.subarray(0, len), post = chunk.subarray(len)
        msgs[0] = post, reqs.splice(0,2), then(toU8(pre))
        continue
      }
    }
  }
  function readBytes(len) { // len≥0
    if (len === 0) return new Uint8Array(0)
    if (len < 0) throw 'no'
    return new Promise(resolve => {
      reqs.push(len, resolve), onReadable()
    })
  }
}



// Skipped for the MVP: WebRTC, with signalling atop another channel.
//   Should we use `wrtc` for this, which installs some extra binaries...
//   Or https://www.npmjs.com/package/node-datachannel (as a peer dependency, to make this optional)
















async function writeToChannel(ch, data, byteswap = false) {
  if (typeof data == 'number') data = new Uint32Array([data])
  if (byteswap) data = data.slice()
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  byteswap && swapBytes(buf, data.constructor.BYTES_PER_ELEMENT)
  await ch.write(buf)
}
async function readFromChannel(ch, len, Format = Float32Array, byteswap = false) {
  // Returns either a Buffer or a Promise of it, for convenience.
  if (!len) return Format !== Number ? new Format(0) : 0
  const bpe = Format !== Number ? Format.BYTES_PER_ELEMENT : 4
  const buf = await ch.read(len * bpe)
  if (!buf || buf.length < len * bpe)
      throw new Error('Unexpected end-of-stream')
  byteswap && swapBytes(buf, bpe)
  if (Format === Number) return new Uint32Array(buf.buffer, buf.byteOffset, 1)[0]
  return new Format(buf.buffer, buf.byteOffset, len)
}
function swapBytes(buf, bpe = 4) {
  if (bpe === 8) buf.swap64()
  else if (bpe === 4) buf.swap32()
  else if (bpe === 2) buf.swap16()
  return buf
}
exports.writeToChannel = writeToChannel
exports.readFromChannel = readFromChannel
exports.swapBytes = swapBytes