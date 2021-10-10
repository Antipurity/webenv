// To your bottom, you'll see the minimal-JSON-sent compiler for one-way JSON-communication channels, for observers & visualizer.



exports.compileSentJS = async function compileSentJS(staticArgs, items, prelude = '') {
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
        collapseWhitespace(`async function RCV(str) {${receive.join('\n')}}
        ${prefix.join('\n')}
        return RCV`)]
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

const collapseWhitespace = exports.collapseWhitespace = function collapseWhitespace(str) {
    // Not all valid JS whitespace, but this is good enough.
    str = str.replace(/[ \t]*[\r\n][ \t\r\n]*/g, '\n')
    str = str.replace(/[ \t]+/g, ' ')
    return str
}