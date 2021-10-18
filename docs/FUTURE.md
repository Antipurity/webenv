This document outlines what still needs to be done to reach MVP state (or the "ready" state).

- Make the Python example production-ready:
    - `state[0]` maximization. (Sure, just giving a model a binary feedback signal may sound non-scalable because of the need to supervise all possible edge cases, but have you ever tried using the model's world understanding: say, bringing up what it did long ago, possibly on the microphone, and hitting that reward button, making it clear that these are very related? WebEnv is a general environment with user interaction. Expand your mind!)
        - To make leaving holes in `state[0]` (as should be done most of the time) not screw up `state[0]` over time, AND to not have an extra model just for reward prediction, have to split the RNN and its gradient in twain:
            - (`s[i]` really means `s[..., i]` here. `A` is `x[:mid]`, `B` is `x[mid:]`.)
            - `reinforcement_learning.Split(f, ins, outs, *, **)`: if `ins != outs`, have another NN that turns input into same-sized input `x`; then `x→(concat f(concat A B.detach())[:mid] f(concat A.detach() B)[mid:])`. ...Is that right? How would loss be computed with this?
                - Or should input for `concat` be supplied via `recurrent.recurrent`'s `input`, made differentiable?...
            - Prediction error is unchanged, since it's only on the first half. Goal-maximization becomes `f(concat A.detach() B)[0].sum()` with a frozen `f`. ...How do we get that frozen `f`, if we only have `.Split`? Should we really just read its prop?

With that, this really will be all I can do.

---

## Post-MVP (when useful)

- Logo, for the extension, and for impressions.

- An entertaining GIF in `README.md` (of an agent trained on `RandomURL` now that we have that), so that people's eyes don't glaze over from all that *text*. A video is the hallmark of a serious project.

- Visualization:
    - Allow listening to real & predicted audio.
    - Plots of numbers-over-time, like the score.
    - Give the prediction's args to `visualize`rs too, and properly show the computation delay. (Use `(stream._stepId - stream._lastStepId)>>>0` to know how many steps in the past the prediction is.)

- Extra features for better control in `webenv.remote`, mostly controlled through the popup:
    - Allow viewing observations+predictions, exactly like `webenv.visualize` does;
    - 2 buttons for ±1 `directScore`, with the ability to bind them to in-page keybindings for convenience;
    - Cut out a DOM element (putting an absolutely-positioned rect on top of it, removable via click), to draw predictions on top of it;
    - Directly link [microphone/camera/etc](https://developer.mozilla.org/en-US/docs/Web/API/Media_Streams_API) data (play audio-only data in-page, to re-use a data channel that agents should already understand);
    - An option to (try to) disable navigation for less user annoyance, via https://stackoverflow.com/questions/821011/prevent-a-webpage-from-navigating-away-using-javascript when all else fails.
    - (And other potential 'prompt-engineering' helpers, once they are known.)

- Bugfix: make `<iframe>`s work like they do for humans (scroll when scrolling with mouse over them, accept mouse/keyboard control when focused, accumulate `directLink`s).

- Communication:
    - Replace Web Socket communication with WebRTC, to drop dropped packets rather than re-send them.
    - Compression. Examples:
        - Values: only transmit the difference between values and a simple shared prediction model, and entropy-encode that.
        - Control (JSON and JS, currently): just compress. And strip comments from JS, and minify it.
        - Computation: possibly, communicate each value's precision, so that agents only have to predict the general area, not the precise imprecise values. (If agents are well-trained, this allows users to safely use a really low resolution, maybe 4-bits-per-value.)