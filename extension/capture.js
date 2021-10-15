if (!navigator.webdriver)
  // (Puppeteer injects its own code, and only needs this backgroud page to exist.)
  (function() {
    // This only handles human connections.
    const chrome = self.chrome
    const tabState = Object.create(null)
    //   { tabId:{ url, cancel:null|'connecting'|func, port:null|Port } }



    // Safeguard against malicious server-sent `.observer`s. We only want to give it the current tab.
    // I think this is every possibility accounted for. If not, contribute.
    //   (To access more of the `chrome` API, you have to add it here, or give up your dreams.)
    const navigationListeners = new WeakMap
    const realTabIds = Object.create(null), fakeTabIds = Object.create(null)
    function please(fake) {
      const tabId = realTabIds[fake]
      if (fake != null && tabId == null) throw new Error("You were not given access to "+fake)
      return tabId
    }
    const safe = {
      browser: undefined,
      eval: undefined,
      chrome:{ // It is too dangerous to be left alive.
        tabs:{
          executeScript(fake, ...a) {
            return chrome.tabs.executeScript(please(fake), ...a)
          },
          sendMessage(fake, ...a) {
            return chrome.tabs.sendMessage(please(fake), ...a)
          },
          query(opt, cb) {
            return chrome.tabs.query({ active:true, currentWindow:true }, tabs => {
              cb(tabs.map(t => {
                const fake = randomChars()
                fakeTabIds[t.id] = fake
                realTabIds[fake] = t.id // Never cleaned, though.
                return { id: fake, width: t.width, height: t.height }
              }))
            })
          },
          onUpdated:{ // Modifies the `tabId`.
            addListener(cb) {
              if (!navigationListeners.has(cb)) {
                let last = null
                navigationListeners.set(cb, tabId => {
                  tabId !== last && cb(fakeTabIds[tabId])
                  last = tabId
                })
              }
              chrome.tabs.onUpdated.addListener(navigationListeners.get(cb))
            },
            removeListener(l) { chrome.tabs.onUpdated.removeListener(navigationListeners.get(l)) },
            hasListener(l) { return chrome.tabs.onUpdated.hasListener(navigationListeners.get(l)) },
          },
        },
        runtime:{
          get lastError() { return chrome.runtime.lastError },
          // All event listeners expose the real tabId,
          //   but we always go through `realTabIds`,
          //   so it cannot be used for anything.
          onMessage: chrome.runtime.onMessage,
          onConnect: chrome.runtime.onConnect,
        },
        tabCapture:{
          capture: chrome.tabCapture.capture,
        },
      },
    }
    for (let k of Object.keys(safe)) self[k] = safe[k]



    // Finally, handle dis/connections.
    chrome.runtime.onConnect.addListener(port => {
      if (port.name.slice(0,17) !== 'popupInteraction ') return
      const tabId = port.name.slice(17)
      const state = tabState[tabId] || (tabState[tabId] = { cancel:null, port:null, url:'' })
      if (!state.port) {
        state.port = port
        port.onDisconnect.addListener(p => {
          state.port = null
          if (state.cancel == null) delete tabState[tabId]
        })
        port.onMessage.addListener((msg, sender, sendResponse) => {
          // `msg` is `{ tabId:…, url:…, …opts }`
          const state = tabState[tabId] || (tabState[tabId] = { cancel:null, port:null, url:'' })
          if (!msg || typeof msg != 'object') return
          if (state.cancel == null && !msg.url) return
          if (state.cancel === 'connecting') return // Never stop trying to connect. ×
          if (typeof state.cancel == 'function') cancel(tabId) // Stop on button click.
          else { // Start on button click.
            state.cancel = 'connecting', state.url = ''
            try {
              const socket = new WebSocket(state.url = msg.url) // × Yeah, never just .close() this.
              updatePopup(tabId)
              socket.binaryType = 'arraybuffer', socket.onmessage = evt => {
                state.cancel = new Function(
                  new TextDecoder().decode(evt.data)
                )()(socket, msg)
                updatePopup(tabId)
                state.cancel.onClose = () => { // On close, know that.
                  state.cancel = null, state.url = '', updatePopup(tabId)
                }
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
      updatePopup(tabId)
    })
    function updatePopup(tabId) {
      const state = tabState[tabId], port = state && state.port
      const c = state && state.cancel, u = state && state.url
      port && port.postMessage(!state || c === null ? 'idling '+u : (c === 'connecting' ? 'connecting ' : 'connected ') + u)
    }
    function cancel(tabId) {
      const state = tabState[tabId]
      state && typeof state.cancel == 'function' && state.cancel()
      updatePopup(tabId)
      if (!state.port) delete tabState[tabId]
    }
    function randomChars(len=16) {
        return new Array(len).fill().map((_,i) => (Math.random()*16 | 0).toString(16)).join('')
    }
  })()