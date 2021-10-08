// These compute mean and standard deviation of a stream of numbers as it arrives.



exports.signalUpdate = function signalUpdate(value, moments = [0,0,0], maxHorizon = 10000) {
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



exports.signalNormalize = function signalNormalize(value, moments, mean = 0, stddev = .33, maxMagnitude = 3*stddev) {
  // Makes mean & variance of a signal's value roughly the same.
  if (moments) {
      const m1 = moments[1], m2 = Math.max(Math.sqrt(Math.max(0, moments[2])), 1e-6)
      value = ((value-m1)/m2 * stddev) + mean
  }
  return Math.max(-maxMagnitude, Math.min(value, maxMagnitude))
}