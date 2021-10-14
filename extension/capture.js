// This only handles human connection.
//   (Puppeteer injects its own code, and only needs this backgroud page to exist.)



const tabState = Object.create(null) // { tabId:{ cancel:null|'connecting'|func, port:null|Port } }



chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popupInteraction') return
  const tab = port.sender.tab
  const tabId = tab.id, w=tab.width, h=tab.height // These are nice props.
  if (!tabState[tabId]) {
    const state = tabState[tabId] = { cancel:null, port:port, url:'' }
    port.onDisconnect.addListener(p => cancel(tabId))
    port.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg != 'object' || !msg.url) return // Expect { url:…, …opts }
      if (state.cancel === 'connecting') return // Never stop trying to connect.
      if (typeof state.cancel == 'function') cancel(tabId) // Stop on button click.
      else { // Start on button click.
        state.cancel = 'connecting', sendPopupStateOf(port, tabId)
        const socket = new WebSocket(state.url = msg.url) // Yeah, never just .close() this.
        socket.binaryType = 'arraybuffer', socket.onmessage = evt => {
            state.cancel = new Function(new TextDecoder().decode(evt.data))()(socket, { bytesPerValue:1|2|4 })
            sendPopupStateOf(port, tabId)
        }, socket.onerror = evt => { socket.close(), state.cancel = null, state.url = evt.reason, sendPopupStateOf(port, tabId) }
      }
    })
  }
  if (tabState[tabId].cancel !== null) return // Reject already-active connections.
  sendPopupStateOf(port, tabId)
})
function sendPopupStateOf(port, tabId) {
  const u = tabState[tabId].url
  port.postMessage(!(tabId in tabState) || tabState[tabId].cancel === null ? 'idling '+u : (tabState[tabId].cancel === 'connecting' ? 'connecting ' : 'connected ') + u)
}
function cancel(tabId) {
  typeof tabState[tabId].cancel == 'function' && tabState[tabId].cancel()
  tabState[tabId].port.close()
  delete tabState[tabId]
}