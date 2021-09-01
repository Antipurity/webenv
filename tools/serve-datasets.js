// This is a simple file server, which can also serve file slices.
// Command-line args (`npm run serve-datasets Arg1 Arg2 Arg3`):
//   - Path to datasets; `index.html` must be in that folder. `data` by default.
//   - URL key, for restricting access. `-` by default (no restriction).
//   - Port. `4321` by default.
//   - If HTTPS, 2 more args, https://nodejs.org/en/knowledge/HTTP/servers/how-to-create-a-HTTPS-server/
//     - Private key file;
//     - Certificate file.

let [dataPath = 'data', urlKey = '-', port = '4321', keyPath, certPath] = process.argv.slice(2)
if (urlKey === '-') urlKey = ''
port = +port
const path = require('path'), fs = require('fs')



const http = require('http'), https = require('https')
const key = keyPath && fs.readFileSync(keyPath)
const cert = certPath && fs.readFileSync(certPath)
if (key && !cert) throw 'Specify key and certificate together, only key is not enough'
const server = !cert ? http.createServer(serve) : https.createServer({ key, cert }, serve)
server.listen(port)

console.log()
console.log('Serving ' + dataPath + ' at:')
const inters = require('os').networkInterfaces()
for (let inter of Object.values(inters))
  for (let addr of inter)
    if (addr.family === 'IPv4')
      console.log(' ', (!cert ? 'http://' : 'https://') + addr.address + ':' + port + (urlKey ? '/'+urlKey : '') + '/')



async function serve(req, res) {
  let url = req.url
  if (url.slice(0, 1 + urlKey.length) !== '/' + urlKey) return res.destroy()
  url = url.slice(1 + urlKey.length)
  if (url.indexOf('..') >= 0) return res.destroy()
  let filePath
  if (!url)
    return res.writeHead(302, { Location: urlKey ? '/' + urlKey + '/' : '/index.html' }), res.end()
  if (url === '/') filePath = path.join(dataPath, 'index.html')
  else filePath = path.join(dataPath, ...url.split('/'))
  let start = 0, end = null, size = false
  const headers = req.rawHeaders
  for (let i = 0; i < headers.length; i += 2)
    if (headers[i].toLowerCase() === 'range') {
      let r = headers[i+1].trim()
      if (/^bytes=[0-9]+\-[0-9]+$/.test(r))
        [start, end] = r.slice(6).split('-').map(v => +v)
      else if (r === '?')
        size = true
    }
  let fileSize
  try { fileSize = (await new Promise((resolve, reject) => fs.lstat(filePath, (err, stats) => err ? reject(err) : resolve(stats)))).size }
  catch (err) { req.destroy();  return }
  if (size) return res.end(fileSize)
  if (end !== null) {
    if (start >= fileSize || end >= fileSize)
      return res.writeHead(416, {['Content-Range']:'bytes */'+fileSize}).end()
    res.setHeader('Content-Range', 'bytes '+start+'-'+end+'/'+fileSize)
    res.setHeader('Content-Length', end - start + 1)
    res.setHeader('Accept-Ranges', 'bytes')
    res.writeHead(206)
  }
  const file = fs.createReadStream(filePath, { start, end: end !== null ? end : Infinity })
  file.on('error', e => res.destroy())
  file.pipe(res)
}