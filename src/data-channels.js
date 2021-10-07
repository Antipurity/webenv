// This defines creators of (message-oriented, real-time, bidirectional) data channels that have:
//   `ch.write(bytes)` to write some bytes.
//   `ch.skip()` after each message, to delimit what to skip to if packets are dropped.
//   `await ch.read(len)→bytes`, which can `throw 'skip'`, to resume reading at the next skip.
//   `ch.close()` to end this existence.
// As a bonus, to send a channel creator's JS elsewhere, simply `''+func`.



let WebSocket = null



// TODO: Migrate `webenv.io` to using this.
exports.streams = function streams(read = process.stdin, write = process.stdout) {
  // This simply reads from Readable and writes to Writable streams.
  // Reliable, so `.read` will never throw.
  if (!streams.R) streams.R = new WeakSet, streams.W = new WeakSet
  if (streams.R.has(read)) throw new Error('Already reading the stream')
  if (streams.W.has(write)) throw new Error('Already writing the stream')
  streams.R.add(read), streams.W.add(write)
  const thens = [], reqs = []
  function onDrain() {
    thens.forEach(f => f()), thens.length = 0
  }
  function uncork() { write.uncork() }
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
  read.on('readable', onReadable)
  write.on('drain', onDrain)
  write.on('error', () => {}) // Ignore "other end has closed" errors.
  return {
    write(bytes) {
      // Can be `await`ed to wait until the buffer gets emptier.
      if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array')
      write.cork()
      process.nextTick(uncork)
      if (!write.write(bytes))
        return new Promise(then => thens.push(then))
    },
    skip() {},
    read(len) { return readBytes(len) },
    close() { read.destroy(), write.destroy() },
  }
}



// TODO: `npm i isomorphic-ws ws`
exports.webSocketUpgrade = function upgrade(request, socket, head) {
  // Given an HTTP/S `server`, do
  //   `server.on('upgrade', (...args) => webSocketUpgrade(...args).then(channel => …))`
  return new Promise(then => {
    const wss = upgrade.wss || (upgrade.wss = new require('ws').WebSocketServer({ noServer:true }))
    wss.handleUpgrade(request, socket, head, ws => then(exports.webSocket(ws)))
  })
}
exports.webSocket = function(ws) {
  // Wraps a WebSocket (or a URL to it) for reliable channel communication.
  if (!WebSocket) WebSocket = require('isomorphic-ws')
  if (typeof ws == 'string') ws = new WebSocket(ws)
  let opened = new Promise(then => ws.onopen = then)
  const msgs = [], reqs = []
  function onReadable(evt) {
    // Satisfy `readBytes` requests:
    //   concat too-small chunks, slice too-big chunks, return just-right chunks.
    evt && msgs.push(new Uint8Array(evt.data))
    while (reqs.length) { // [..., len, then, ...]
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
      if (chunk.length === len) { msgs.shift(), reqs.splice(0,2), then(chunk);  continue }
      else if (chunk.length > len) {
        const pre = chunk.subarray(0, len), post = chunk.subarray(len)
        msgs[0] = post, reqs.splice(0,2), then(pre)
        continue
      }
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
  ws.onmessage = onReadable
  return {
    async write(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new Error('Expected Uint8Array')
      let b = bytes.buffer
      if (bytes.byteOffset || bytes.byteLength !== b.byteLength)
        b = b.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      opened && (await opened); opened = null
      ws.send(b)
    },
    skip() {},
    async read(len) {
      opened && (await opened); opened = null
      return readBytes(len)
    },
    close() { ws.close() },
  }
}



// TODO: WebRTC, with signalling atop another channel.