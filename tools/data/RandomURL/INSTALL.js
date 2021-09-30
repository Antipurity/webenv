const https = require('https'), fs = require('fs'), zlib = require('zlib')



;(async function() {
  // `URL.txt` has so much redundancy, but we appear to remove so much info that the uncompressed URL file size is the same as the compressed index size.
  try {
    const latestIndexInfo = JSON.parse(await stringFromStream('https://index.commoncrawl.org/collinfo.json'))[0]
    const id = latestIndexInfo.id
    console.log('  ' + latestIndexInfo.name)

    const totalSize = +(await fileContents('SIZE'))
    const reqSizeStr = await new Promise(then => {
      const rl = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      })
      rl.question('  URL file size to store, in GB (empty for full size): ', a => (then(a), rl.close()))
    })
    const reqSize = parseFloat(reqSizeStr) * 2**30 || totalSize
    const keepProbability = reqSize / totalSize

    const files = (await stringFromStream(readGZ(await readURL(`https://commoncrawl.s3.amazonaws.com/crawl-data/${id}/cc-index.paths.gz`)))).split('\n').filter(s => /cdx-.+\.gz$/.test(s))

    const start = +(await fileContents('PROGRESS'))
    if (!start) try { await fs.promises.rm('URL.txt') } catch (err) {}
    const urlFile = fs.createWriteStream('URL.txt', {flags:'a'})
    for (let i = start || 0; i < files.length; ++i, await fs.promises.writeFile('PROGRESS', ''+i)) {
      const ii = (''+(i+1)).padStart((''+files.length).length, '0'), to = 'URL' + ii + '.txt'
      // Save to proxy then append that proxy, so that interrupts are much less likely to cause double URLs.
      const compressed = new require('stream').PassThrough()
      download('https://commoncrawl.s3.amazonaws.com/' + files[i], compressed, ii + '/' + files.length)
      const toFileW = fs.createWriteStream(to)
      await readLines(readGZ(compressed), req => {
        // https://commoncrawl.org/2015/04/announcing-the-common-crawl-index/
        if (Math.random() >= keepProbability) return
        try { req = JSON.parse(req.slice(req.indexOf('{'))) }
        catch (err) { return }
        if (typeof req.status != 'string' || req.status[0] !== '2') return
        if (req.mime !== 'text/html') return
        toFileW.write(req.url + '\n')
      })
      toFileW.end()
      const toFileR = fs.createReadStream(to)
      toFileR.pipe(urlFile, {end:false})
      await new Promise(then => toFileR.on('end', then))
      await new Promise(then => setTimeout(then, 100)) // Here is an optimization opportunity, 30 seconds off.
      await fs.promises.rm(to)
    }
    urlFile.end()
    await fs.promises.rm('PROGRESS')
  } catch (err) { console.error(err);  process.exit(1) }
})()



async function fileContents(at) {
  try { return await fs.promises.readFile(at, { encoding:'utf8' }) }
  catch (err) { return '' }
}



async function readURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, resolve).on('error', reject)
  })
}
async function stringFromStream(stream) {
  if (typeof stream == 'string')
    stream = await readURL(stream)
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}
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
function readGZ(stream) {
  const gunzip = zlib.createGunzip()
  stream.pipe(gunzip)
  return gunzip
}
async function readLines(stream, fn) {
  return new Promise((resolve, reject) => {
    let rest = ''
    stream.on('data', chunk => {
      const str = rest + chunk.toString('ascii')
      const lines = str.split('\n')
      for (let i = 0; i < lines.length - 1; ++i) fn(lines[i])
      rest = lines[lines.length-1]
    })
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}