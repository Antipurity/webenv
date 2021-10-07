This document outlines what still needs to be done to reach MVP state (or the "ready" state).

- Joint training and deployment:
    - Make the Capture extension communicate through a Web Socket rather than CDP (gaining speed via not having to communicate through JSON+base64), AND be fully responsible for as many reads+writes as possible via `observers`.
        - Protocol: `0xFFFFFFFF StrLen Str BytesPerValue` for reinitialization (execute `f = Function(Str)(socket, f, bytesPerValue=2)` to get new JS code, or update old code in-place only as needed; cancel via `f()`, even the very first `f` will do); `Index PredLen Pred WriteLen Write JsonLen Json` for an observation (which demands a `Index ReadLen Read JsonLen Json` back).
            - The maybe-unreliable-protocol protocol, for much easier swapping: `setup(...whatever)→channel`, then `.write(bytes)` and `.skip()` (to specify a point where reading can resume after a dropped packet; does nothing for reliable streams) and `await .read(len)→bytes` (throws on dropped packets, so you can resume reading after the writer's `.skip()`).
            - Make `webenv.io` use the protocol-protocol for STDIO. (And implement it, trivially.)
            - Make `observers` use the protocol-protocol for Web Sockets, to deliver predictions & actions & JSON and receive observations. (And implement it; take the server URL.)
            - Make `observers` use the protocol-protocol for unordered & unreliable WebRTC made skippable. (And implement it: each packet has frame ID (2B) and in-frame packet ID (2B) and payload length (2B; less than packetSize (16kB) means that this packet is the last one — writing must send a 0-len packet if msg is divisible by packetSize) payload. Receiving next-frame invalidates incomplete-prev-frames promises after 10ms; reading reconstructs messages and concatenates proper bytes.)
        - Replace as many `.page` and `.cdp` uses, in `read` and `write` and triggers, as we can with in-extension `observer` versions.
            - There is no way to send `.isTrusted` events in JS, so, if a CDP channel is available for keyboard & mouse events, must use that instead of in-extension presses+clicks.
	- Extension-only user streams: have `webenv.remote(path='/', max=16)`, which for each incoming Web Socket connection (or WebRTC), refuses it if over the limit, else establishes the control connection, re-using all code from the Capture's rework.
        - Make sure that the Capture extension can be installed by actual humans.
    - Make the Capture extension usable by humans — or author a separate extension, so that `webenv.browser`s don't have to parse all that extra code (though it's once per startup, so it's cheap).
        - If `!navigator.webdriver`, do not start control automatically, but only manually. Provide a nice UI, with the server URL and the button to control the current tab, canceling if it gets closed.
        - In non-Chromium browsers (wherever `chrome.tabCapture` is unavailable, [mainly Firefox](https://bugzilla.mozilla.org/show_bug.cgi?id=1391223)), use [`navigator.mediaDevices.getDisplayMedia`](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API), even though it is much more error-prone for users (have to manually select the tab, and not anything else since there's no way to constrain the shown options).
        - Extra features for better control, mostly controlled through the popup:
            - 2 buttons for ±1 `directScore`, with the ability to bind them to in-page keybindings for convenience;
            - Allow viewing observations+predictions, exactly like `webenv.webView` does;
            - Draw predictions in-page, via canvases that are only non-transparent where the observation is `NaN` (best if these are not observed, but video capturing APIs don't allow that, so, make this an option);
            - Cut out a DOM element, to draw predictions on top of it;
            - Directly link [microphone/camera/etc](https://developer.mozilla.org/en-US/docs/Web/API/Media_Streams_API) data (play audio-only data in-page, to re-use a data channel that agents should already understand);
            - An option to (try to) disable navigation, via https://stackoverflow.com/questions/821011/prevent-a-webpage-from-navigating-away-using-javascript when all else fails;
            - An option to show `directScore` prediction through the action button's color.

- Make the Python example production-ready:
    - Save + load, checking that all unchangeable hyperparams are the same; also have a list of hparams that can change, such as the learning rate. Ask the user if they want to warm-start from the previous checkpoint if changed. (No tracing: batch size could pick up the slack.) ([Should be very easy.](https://pytorch.org/tutorials/beginner/saving_loading_models.html))
    - Weight decay, maybe only on 95% least-magnitude weights, as a kind of soft sparsification (might have synergy with LDL's greater-than-DL capacity).
    - Efficient output slicing, by slicing weights and such. (This would allow 3× more efficiency below.)
    - `state[0]` maximization. (Sure, just giving a model a binary feedback signal may sound inconvenient, but have you ever tried using its world understanding: say, bringing up what it did long ago, possibly on the microphone, and hitting that reward button? Maybe treat your model with some respect?)
        - To make leaving holes in `state[0]` (as should be done most of the time) not screw up everything, AND to not have an extra model just for reward prediction, have to split the RNN and its gradient in twain:
            - (`s[i]` really means `s[..., i]` here. `O` is observations `x[:mid]`, `A` is actions `x[mid:]`.)
            - Transition goes from `x→f(x)` to `x→(concat f(concat O A.detach())[:mid] f(concat O.detach() A)[mid:])`.
            - Prediction error is unchanged, since it's only on the first half.
            - Goal-maximization becomes `f(concat O.detach() A)[0].sum()`.

- Clean up:
    - Make `visualize`rs also accept actions, in case we want to visualize mouse actions and button presses and such.
    - An interface that provides stream ID observations, to guarantee that RNN states will never become indistinguishable.

- An entertaining GIF in `README.md` (of an agent trained on `RandomURL` now that we have that), so that people's eyes don't glaze over from all that *text*.

With that, this really will be all I can do. Besides, who would ever be impressed by WebEnv in its current state, without even a GIF?