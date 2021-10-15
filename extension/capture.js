// This only handles human connection.
//   (Puppeteer injects its own code, and only needs this backgroud page to exist.)



const tabState = Object.create(null)
//   { tabId:{ url, cancel:null|'connecting'|func, port:null|Port } }



chrome.runtime.onConnect.addListener(port => {
  if (port.name.slice(0,17) !== 'popupInteraction ') return
  const tabId = port.name.slice(17)
  if (!tabState[tabId]) {
    const state = tabState[tabId] = { cancel:null, port, url:'' }
    port.onDisconnect.addListener(p => cancel(tabId))
    port.onMessage.addListener((msg, sender, sendResponse) => {
      // `msg` is `{ tabId:…, url:…, …opts }`
      if (!msg || typeof msg != 'object' || !msg.url) return
      if (state.cancel === 'connecting') return // Never stop trying to connect.
      if (typeof state.cancel == 'function') cancel(tabId) // Stop on button click.
      else { // Start on button click.
        state.cancel = 'connecting', state.url = ''
        try {
          const socket = new WebSocket(state.url = msg.url) // Yeah, never just .close() this.
          updatePopup(tabId)
          socket.binaryType = 'arraybuffer', socket.onmessage = evt => {
              state.cancel = new Function(new TextDecoder().decode(evt.data))()(socket, msg)
              updatePopup(tabId)
          }, socket.onerror = evt => {
            socket.close(), state.cancel = null, state.url = 'Connection failed', updatePopup(tabId)
          }
        } catch (err) {
          let s = err.message
          if (s.slice(0,33) === "Failed to construct 'WebSocket': ") s = s.slice(33)
          state.cancel = null, state.url = s, updatePopup(tabId)
        }
      }
    })
  }
  if (tabState[tabId].cancel !== null) return // Reject already-active connections.
  updatePopup(tabId)
})
function updatePopup(tabId) {
  const state = tabState[tabId], port = state && state.port, u = state && state.url
  port.postMessage(!state || state.cancel === null ? 'idling '+u : (state.cancel === 'connecting' ? 'connecting ' : 'connected ') + u)
}
function cancel(tabId) {
  const state = tabState[tabId]
  typeof state.cancel == 'function' && state.cancel()
  state.port.disconnect()
  delete tabState[tabId]
}