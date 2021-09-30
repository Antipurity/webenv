// With `webenv.fetchSlice()`, use this function:
async function fetchSlice(url, start = 0, end = null) {
  if (location.protocol !== 'file:') {
    const response = await fetch(url, {headers:{ Range:'bytes='+start+'-'+(end !== null ? end-1 : null) }})
    return new Uint8Array(await response.arrayBuffer())
  }
  if (typeof _fetchLocalFileSlice != ''+void 0) { // Use WebEnv.
      const bin = atob(await _fetchLocalFileSlice(url, start, end))
      const data = new Uint8Array(bin.length)
      for (let i = 0; i < data.length; ++i) data[i] = bin.charCodeAt(i)
      return data
  } else { // File API has .slice, so, if a dataset page is opened directly, ask for assistance.
      if (!fetchSlice.fileCache) fetchSlice.fileCache = Object.create(null)
      const cache = fetchSlice.fileCache
      const file = cache[url] instanceof Promise ? (cache[url] = await cache[url]) : cache[url] || await (cache[url] = getFile(url))
      return new Promise(resolve => {
          const R = new FileReader
          R.onload = () => resolve(new Uint8Array(R.result))
          R.readAsArrayBuffer(file.slice(start, end !== null ? end : file.size))
      })
      function getFile(url) {
          return new Promise(resolve => {
              addEventListener('click', function userActed() {
                  removeEventListener('click', userActed)
                  const el = document.createElement('input')
                  el.type = 'file'
                  if (url.lastIndexOf('.') >= 0) el.accept = url.slice(url.lastIndexOf('.'))
                  el.onchange = () => resolve(el.files[0])
                  el.click()
              })
          })
      }
  }
}