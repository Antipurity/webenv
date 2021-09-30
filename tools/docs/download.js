// Download, from `url`, `to` file or stream, with `name` attached to the completion percentage in the console.
async function download(url, to, name) {
  if (typeof to == 'string')
    to = fs.createWriteStream(to)
  return new Promise((resolve, reject) => {
    let soFar = 0, totalSize = 0
    https.get(url, response => {
      totalSize = response.headers && response.headers['content-length'] || 0
      response.pipe(to)
      response.on('data', chunk => {
        soFar += chunk.length
        process.stdout.write('\r')
        process.stdout.write(name + ': ' + (soFar / totalSize * 100).toFixed(1) + '% (' + describeSize(soFar) + ')      ')
      })
      to.on('finish', () => console.log() || resolve())
    }).on('error', reject)
  })
}
function describeSize(bytes) {
  return !bytes ? '' :
    bytes > 2**40 ? (bytes/2**40).toFixed(2) + 'TB' :
    bytes > 2**30 ? (bytes/2**30).toFixed(2) + 'GB' :
    bytes > 2**20 ? (bytes/2**20).toFixed(2) + 'MB' :
    bytes > 2**10 ? (bytes/2**10).toFixed(2) + 'KB' :
    bytes + 'B'
}
// (Unimplemented: resuming the download, using the Range HTTP header.)
//   (Instead, to resume, rely on splitting data into small-ish files and storing the download-loop counter in a file.)