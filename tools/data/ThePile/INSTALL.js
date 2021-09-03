// See https://the-eye.eu/public/AI/pile/

const https = require('https'), fs = require('fs'), path = require('path')

;(async function() {
  try {
    const total = 30
    for (let i = +(await fileContents('PROGRESS')) || 0; i < total; ++i) {
      const ii = (''+i).padStart(2, 0), to = ii + '.jsonl.zst'
      await download('https://the-eye.eu/public/AI/pile/train/' + to, to, 'Pile ' + ii + '/' + total)
      await fs.promises.writeFile('PROGRESS', ''+(i+1))
    }
    await fs.promises.rm('PROGRESS')
  } catch (err) { console.error(err);  process.exit(1) }
})()



async function fileContents(at) {
  try { return await fs.promises.readFile(at, { encoding:'utf8' }) }
  catch (err) { return '' }
}



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