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
let url = '' // For detecting some unpleasantness early.
let tabId = null // The tab that the popup was invoked on.
let port = null // How we communicate with `capture.js`.
typeof chrome != ''+void 0 && chrome.tabs ? chrome.tabs.query({active:true, currentWindow:true}, gotTabs) : gotTabs()
function changeOpt(k, v) { options[k] = v } // TODO: Also save options on change.
// TODO: Load opts from sync storage if possible.
// TODO: Create UI for non-URL options.



function gotTabs(tabs) {
  tabId = tabs && tabs[0] ? tabs[0].id : null
  url = tabs && tabs[0] && tabs[0].url || ''
  port = tabs && tabs[0] ? chrome.runtime.connect({ name:'popupInteraction '+tabId }) : null
  if (port) port.onMessage.addListener(changeState)
  else changeState('idling ')
}
function connect(evt) {
  const btn = document.getElementById('connect-btn')
  if (btn.classList.contains('disabled')) return
  if (port) tabId != null && port.postMessage(options)
  else changeState('connecting '+serverUrl.value), setTimeout(() => {
    changeState(Math.random() < .5 ? 'connected '+serverUrl.value : 'idling Some example error has occured.')
  }, 1000)
}
function changeState(state) {
  if (typeof state != 'string') return
  const main = document.getElementById('main-view')
  const btn = document.getElementById('connect-btn')
  const err = document.getElementById('error-message')
  main.classList.remove('error')
  main.classList.remove('idling')
  main.classList.remove('connecting')
  main.classList.remove('connected')
  btn.classList.remove('disabled')
  if (state.slice(0,7) === 'idling ') {
    err.textContent = state.slice(7)
    state.slice(7) && main.classList.add('error')
    main.classList.add('idling')
    if (url === 'about:blank' || url.slice(0,9) === 'chrome://') {
      document.querySelector('body>.controls').textContent = '<Cannot connect here>'
    }
  } else if (state.slice(0,11) === 'connecting ') {
    serverUrl.value = state.slice(11)
    main.classList.add('connecting')
    btn.classList.add('disabled')
  } else if (state.slice(0,10) === 'connected ') {
    err.textContent = ''
    serverUrl.value = state.slice(10)
    main.classList.add('connected')
  } else throw new Error('Unknown state: ' + state)
}



if (navigator.webdriver) document.querySelector('body>.controls').textContent = '<Already auto-controlled, stop fooling around>'