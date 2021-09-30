// To be used as `await new Promise(requestAgentStep)`:
function requestAgentStep(callback) {
  const f = requestAgentStep
  if (typeof directLink == 'function' && !f.cb)
      f.cb = [], directLink(() => f.cb.splice(0, f.cb.length).forEach(f => f()) || true)
  f.cb ? f.cb.push(callback) : setTimeout(callback, 200)
}