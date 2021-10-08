// These encode/decode observations/predictions/actions in f32 or i16 or i8.



exports.encodeInts = encodeInts
exports.decodeInts = decodeInts
exports.overwriteArray = overwriteArray
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