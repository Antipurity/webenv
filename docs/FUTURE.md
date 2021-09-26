This document outlines what still needs to be done to reach MVP state (or the "ready" state).

(These are breaking changes. After this, there shouldn't be any breaking changes.)

- To make the training set uniform for all users, and lower the barrier to entry: `RandomWebPage`, using [the Common ](https://index.commoncrawl.org/)[Crawl Index](https://github.com/trivio/common_crawl_index). Probably best done as a dataset. For usability, only store status-200 URLs (uncompressed for random access), and allow users to choose to randomly drop URLs to get to a certain file size (500GB is a lot for a mere link storage).

- Batch size > 1:
    - Modify `webenv.io`'s protocol: both send and receive the 4-byte index before each packet. The agent's job is then to read all indices (all are ints as small as possible, so the state store can just be a dense tensor), gather & compute & scatter, and write them in the same order that they arrived in; make the Python bridge do all that.
        - In addition, be able to send de-allocation events: 4-byte index, then `0xFFFFFFFF` for the read length, indicating that parameters can be reset. (In case memory re-use is undesired.)
    - Extract all observation+action stuff from `webenv` to a dictionary on `webenv`.
        - Clean up cruft: observers (data from extension) should be an interface, which fills others' spots on read. Should deduplicate interface objects, so that there is only one whenever we include an image/audio interface.
        - Relaunch individually when a connection is lost.
        - Make every spot's read+step+write cycle independent from all others (with the timing initialized from others if possible): this is the easiest-to-implement option. (As long as we don't get torn writes to `webenv.io` or `webenv.remote`, we're good.)
            - To discourage individual spots from causing resource starvation, maintain a running average of time-per-step (without read/write time: don't want slow connections to slow down fast ones), and where needed, delay each spot's step to be the average of all averages.
        - Make `webenv.io` actually send streams per-spot.
        - Make `webenv.webView` actually `<select>` the stream to view, via sub-URLs.
    - Extra streams: have `webenv.browser(...interfaces)`, which allocates a stream for itself and does what `webenv` used to. If non-stream interfaces are present at top-level, wrap them in a browser, for convenience.
    - Make the Capture extension communicate through a Web Socket rather than CDP (gaining speed via not having to communicate through JSON+base64), AND be fully responsible for all/most reads via `remoteRead`, AND for all/most writes via `remoteWrite`.
        - Isolate all `page.` and `._cdp` uses, in `read` and `write` and triggers, and replace as many as we can with in-extension `remoteRead` and `remoteWrite` versions.
        - Share the web server with `webenv.webView`. In fact, have just one HTTP/S server, launched always, since it'll always be used.
        - Turn that one silly max-overlapping-step-count interface into a whole object for per-`webenv` options, because we'll probably need more than 1.
        - Protocol: `0xFFFFFFFF StrLen Str` for reinitialization (execute `f = Function(Str)(f, socket, bytesPerValue=2)` to get new JS code, or update old code in-place only as needed; cancel via `f()`, even the very first version will do), `Index PredLen Pred WriteLen Write JsonLen Json` for an observation (which demands exactly one `Index ReadLen Read` back).
        - For higher throughput at the cost of dropped packets not being re-sent, use WebRTC instead of Web Sockets. (Have to implement reliability manually, though: the browser should send packets periodically rather than in response.)
	- Extension-only user streams: have `webenv.remote(path='/', max=16)`, which for each incoming Web Socket connection, refuses it if over the limit, else establishes the control connection, re-using all code from the Capture's rework.
        - Make sure that the Capture extension can be installed by actual humans.
    - Make the Capture extension usable by humans — or author a separate extension, so that `webenv.browser`s don't have to parse all that extra code.
        - If `!navigator.webdriver`, do not start control automatically, but only manually. Provide a nice UI, with the server URL and the button to control the current tab, canceling if it gets closed.
        - In non-Chromium browsers (wherever `chrome.tabCapture` is unavailable, [mainly Firefox](https://bugzilla.mozilla.org/show_bug.cgi?id=1391223)), use [`navigator.mediaDevices.getDisplayMedia`](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API), even though it is much more error-prone for users (have to manually select the tab, and not anything else since there's no way to constrain the shown options).
        - Extra features for better control, mostly controlled through the popup:
            - 2 buttons for ±1 `directScore`, with the ability to bind them to in-page keybindings for convenience;
            - Allow viewing observations+predictions, exactly like `webenv.webView` does;
            - Draw predictions in-page, via canvases that are only non-transparent where the observation is `NaN` (best if these are not observed, but video capturing APIs don't allow that, so, make this an option);
            - Cut out a DOM element, to draw predictions on top of it;
            - Directly link [microphone/camera/etc](https://developer.mozilla.org/en-US/docs/Web/API/Media_Streams_API) data;
            - An option to show `directScore` prediction through the action button's color.

- An entertaining GIF in `README.md`, so that people's eyes don't glaze over from all that *text*.