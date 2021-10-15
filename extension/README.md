<img src=extension.gif align=right>

This extension gives most video/audio/etc observations to agents, and processes most actions from agents.

It can be installed by humans, to provide an interface that allows connecting to a `webenv.remove` server that would control the active tab.

Without a pre-trained agent to fine-tune, it is pointless to install, so currently, there is no official way to install it.

If you want to install it anyway: [in Firefox, visit `about:debugging` and do it](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/); [in Chrome, visit `chrome://extensions` and do it](https://stackoverflow.com/a/24577660).

---

(Even though it needs the `<all_urls>` permission, it should still only allow server-sent JS to access the connected-to tab, not all, making it about as secure as it can be.)