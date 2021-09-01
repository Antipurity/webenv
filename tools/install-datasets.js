const path = require('path'), fs = require('fs/promises')



const rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
})

const source = path.join('tools', 'data'), target = path.join('data')
const allUrls = []
console.log()
console.log('Installing ' + source + ' into ' + target + '...')
extCopy(source, target).then(() => {
  rl.close()
  console.log('To use these datasets, either use the local URL')
  console.log(' ', 'file://' + encodeURI(path.resolve(path.join(target, 'index.html')).replace(/\\/g, '/')))
  console.log(' ', '  (for this, each time, you will have to click and select the dataset file)')
  console.log('or execute the command')
  console.log(' ', 'npm explore webenv -- npm run serve-datasets')
  console.log('OK')
})



async function ask(at, size = null) {
  let sizeStr = !size ? '' :
    size > 2**40 ? (size/2**40).toFixed(2) + 'TB' :
    size > 2**30 ? (size/2**30).toFixed(2) + 'GB' :
    size > 2**20 ? (size/2**20).toFixed(2) + 'MB' :
    size > 2**10 ? (size/2**10).toFixed(2) + 'KB' :
    size + 'B'
  if (sizeStr) sizeStr = ' ('+sizeStr+')'
  return new Promise(resolve => {
    rl.question(`  Install ${at}${sizeStr} (Y/n): `, answer => {
      resolve(answer.toLowerCase().indexOf('y') >= 0)
    })
  })
}
async function fileContents(at) {
  try { return await fs.readFile(at, { encoding:'utf8' }) }
  catch (err) { return '' }
}
async function exists(at) {
  try { return !!(await fs.lstat(at)) }
  catch (err) { return false }
}
async function ensureExists(at) {
  // `void await` is like `await` but stronger
  return void await fs.mkdir(at, { recursive:true })
}
async function extCopy(from, to, relativeTo = '', topLevel = true) {
  let index = ''
  if (topLevel) { // Demand `${source}/index.html`.
    index = await fileContents(path.join(from, 'index.html'))
    if (!index) throw 'Expected index.html in ' + from
  }
  const entries = await fs.readdir(from, { withFileTypes:true })
  let isMain = entries.some(e => e.isFile() && e.name === 'main.html')
  if (isMain) { // Ask, copy, execute INSTALL.js, mark as installed, remember path.
    if (topLevel) throw 'The top level should not have main.html'
    const alreadyExists = (await exists(to)) && !(await exists(path.join(to, 'INSTALL.js')))
    if (alreadyExists) // Refresh & remember.
      return simpleCopy(from, to, true), void allUrls.push(relativeTo + '/main.html')
    if (!(await ask(relativeTo, await fileContents(path.join(from, 'SIZE'))))) return
    allUrls.push(relativeTo + '/main.html')
    if (await simpleCopy(from, to))
      await execScript(to, 'INSTALL.js')
    await fs.rm(path.join(to, 'INSTALL.js'))
  } else // Recurse.
    for (let e of entries)
      if (e.isDirectory())
        await extCopy(
          path.join(from, e.name),
          path.join(to, e.name),
          relativeTo ? relativeTo + '/' + e.name : e.name,
          false)
  if (topLevel) { // Fill the `ALL_URLS` string in `index.html`.
    const contents = index.replace(/ALL_URLS/g, JSON.stringify(allUrls.map(encodeURI).join(' ')))
    await ensureExists(to)
    await fs.writeFile(path.join(to, 'index.html'), contents)
  }
}
async function simpleCopy(from, to, onlyRefresh = false, topLevel = true) { // Copy-paste.
  let installation = false
  await ensureExists(to)
  if (topLevel && !onlyRefresh) {
    // INSTALL.js is the first copy, since it's the "are we installing this" marker.
    const install = await fileContents(path.join(from, 'INSTALL.js'))
    await fs.writeFile(path.join(to, 'INSTALL.js'), install)
    installation = !!install
  }
  const entries = await fs.readdir(from, { withFileTypes:true })
  for (let e of entries) {
    if (e.isFile() && e.name !== 'INSTALL.js' && (!topLevel || e.name !== 'SIZE'))
      await fs.copyFile(path.join(from, e.name), path.join(to, e.name))
    else if (e.isDirectory())
      await simpleCopy(path.join(from, e.name), path.join(to, e.name), onlyRefresh, false)
  }
  return installation
}
async function execScript(dir, filename) {
  const fork = require('child_process').fork
  return new Promise((resolve, reject) => {
    // Does not seem to fail on exceptions in `INSTALL.js`, for some reason.
    //   Unless on exception, they manually do `process.exit(1)`.
    const child = fork(filename, { cwd:dir })
    child.on('error', err => reject(err))
    child.on('exit', (code, signal) => code ? reject(code) : resolve())
  })
}