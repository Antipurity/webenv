document.getElementById('server-url').onfocus = evt => evt.target.select()
document.getElementById('server-url').oninput = evt => changeOpt('url', evt.target.value)
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
  const btn = document.getElementById('connect-btn')
  btn.classList.remove('idling')
  btn.classList.remove('connecting')
  btn.classList.remove('connected')
  if (state === 'idling' || typeof state == 'string' && state.slice(0,6) === 'idling') {
    btn.classList.add('idling')
    btn.classList.remove('disabled')
    // TODO: If we have an error message, also display that under the button.
  } else if (state === 'connecting') {
    btn.classList.add('connecting')
    btn.classList.add('disabled')
  } else if (state === 'connected') {
    btn.classList.add('connected')
    btn.classList.remove('disabled')
  } else throw new Error('Unknown state: ' + state)
}
const port = typeof chrome != ''+void 0 && chrome.runtime && chrome.runtime.connect({ name:'popupInteraction' })
if (port) port.onMessage.addListener(changeState)
else changeState('idling')
function connect(evt) {
  if (port) port.postMessage(options)
  else changeState('connecting'), setTimeout(() => changeState('connected'), 1000)
}
// TODO: Test the extension. (Have to reload the browser for that, though.)



// if (navigator.webdriver) document.querySelector('body>.controls').textContent = '<Already auto-controlled, stop fooling around>' // TODO