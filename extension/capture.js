// The video & audio capturing extension.



function connectChannel(bytesPerValue = 1, code, ...args) {
    // Starts capturing. To stop, call the returned func.
    // See `../src/data-channels.js` for what to provide as `code`.
    // `bytesPerValue` is 0 (float32) or 1 (int8) or 2 (int16).
    const channel = new Function(code)()(...args)
    let flowing = true, timerID = null

    let RCV = null, Data = []
    let lastRequest = performance.now(), timeBetweenRequests = [0,0]
    
    // Limit how many observers can run at once.
    //   (Don't have hanging-observer bugs, or else the page will stall forever.)
    let stepsNow = 0, simultaneousSteps = 16

    const decoder = new TextDecoder()

    readAllData()
    return function stopCapture() { flowing = false, cancelTimeout(timerID) }
    async function readAllData() {
        // Protocol (we're left-to-right):
        //   Start → 0xFFFFFFFF 0x01020304 JsonLen Json (For {bytesPerValue: 0|1|2}.)
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
        const jsonBytes = new TextEncoder().encode(JSON.stringify({
            bytesPerValue,
        }))
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
        await Promise.all([
            writeU32(RCV.obs.length),
            channel.write(new Uint8Array(o.buffer, o.byteOffset, o.byteLength)),
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