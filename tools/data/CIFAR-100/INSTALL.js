const https = require('https'), fs = require('fs'), path = require('path')



;(async function() {
  // Download, extract, copy, delete.
  try {
    const to = 'compressed.tar.gz'
    await download('https://www.cs.toronto.edu/~kriz/cifar-100-binary.tar.gz', to, 'CIFAR-100')
    const execFileSync = require('child_process').execFileSync
    execFileSync('tar', ['-xf', to])
    fs.copyFileSync(path.join('cifar-100-binary', 'train.bin'), 'train.bin')
    await new Promise(then => fs.rm(to, then))
    await new Promise(then => fs.rm('cifar-100-binary', {recursive:true}, then))
  } catch (err) { console.error(err);  process.exit(1) }
})()



function download(url, to, name) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(to)
    let soFar = 0, totalSize = 0
    https.get(url, response => {
      totalSize = response.headers['content-length'] || 0
      response.pipe(file)
      response.on('data', chunk => {
        soFar += chunk.length
        process.stdout.write('\r')
        process.stdout.write(name + ': ' + (soFar / totalSize * 100).toFixed(1) + '% (' + describeSize(soFar) + ')      ')
      })
      file.on('finish', () => console.log() || resolve())
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