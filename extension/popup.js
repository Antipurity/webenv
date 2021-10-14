const serverUrl = document.getElementById('server-url')
serverUrl.onfocus = evt => evt.target.select()
serverUrl.oninput = evt => changeOpt('url', evt.target.value)
document.getElementById('connect-btn').onclick = connect



// Keep track of `--x` and `--y` CSS variables, for all buttons. (Also predict the next position a bit.)
function setMousePosition(evt) {
  for (let b of [...document.querySelectorAll('button.button')]) {
    const r = b.getBoundingClientRect()
    const x = evt.clientX + evt.movementX - r.left, y = evt.clientY + evt.movementY - r.top
    b.style.setProperty('--x', x+'px')
    b.style.setProperty('--y', y+'px')
  }
}
addEventListener('mouseover', setMousePosition, {passive:true})
addEventListener('mousemove', setMousePosition, {passive:true})



const options = Object.assign(Object.create(null), {
  url: '',
  bytesPerValue: 1,
})
function changeOpt(k, v) { options[k] = v } // TODO: Also save options on change.
// TODO: Load opts from sync storage if possible.
// TODO: Create UI for non-URL options.



function changeState(state) {
  if (typeof state != 'string') return
  const btn = document.getElementById('connect-btn')
  btn.classList.remove('idling')
  btn.classList.remove('connecting')
  btn.classList.remove('connected')
  if (state.slice(0,7) === 'idling ') {
    // TODO: If we have an error message, also display that under the button.
    btn.classList.add('idling')
    btn.classList.remove('disabled')
  } else if (state.slice(0,11) === 'connecting ') {
    serverUrl.value = state.slice(11)
    btn.classList.add('connecting')
    btn.classList.add('disabled')
  } else if (state.slice(0,10) === 'connected ') {
    serverUrl.value = state.slice(10)
    btn.classList.add('connected')
    btn.classList.remove('disabled')
  } else throw new Error('Unknown state: ' + state)
}
const port = typeof chrome != ''+void 0 && chrome.runtime && chrome.runtime.connect({ name:'popupInteraction' })
if (port) port.onMessage.addListener(changeState)
else changeState('idling ')
function connect(evt) {
  if (port) port.postMessage(options)
  else changeState('connecting '+serverUrl.value), setTimeout(() => changeState('connected '+serverUrl.value), 1000)
}
// TODO: Test the extension. (Have to reload the browser for that, though.)



// if (navigator.webdriver) document.querySelector('body>.controls').textContent = '<Already auto-controlled, stop fooling around>' // TODO