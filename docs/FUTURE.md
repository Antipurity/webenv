## Post-MVP (when useful)

- Logo, for the extension, and for impressions.

- An entertaining GIF in `README.md` (of an agent trained on `RandomURL` now that we have that), so that people's eyes don't glaze over from all that *text*. A video is the hallmark of a serious project.

- Visualization:
    - Allow listening to real & predicted audio.
    - Plots of numbers-over-time, like the score.
    - Give the prediction's args to `visualize`rs too, and properly show the computation delay. (Use `(stream._stepId - stream._lastStepId)>>>0` to know how many steps in the past the prediction is.)

- Extra features for better control in `webenv.remote`, mostly controlled through the popup:
    - Allow viewing observations+predictions, exactly like `webenv.visualize` does;
    - Directly link [microphone/camera/etc](https://developer.mozilla.org/en-US/docs/Web/API/Media_Streams_API) data (play audio-only data in-page, to re-use a data channel that agents should already understand);
    - 2 buttons for ±1 `directScore`, with the ability to bind them to in-page keybindings for convenience (this might sound non-scalable because every possible edge case has to be covered, but the more advanced the agent, the less you have to cover, especially if you do things like bring up what it did long ago on the microphone or such before hitting that button);
    - Cut out a DOM element (putting an absolutely-positioned rect on top of it, removable via click), to draw predictions on top of it;
    - An option to (try to) disable navigation for less user annoyance, via https://stackoverflow.com/questions/821011/prevent-a-webpage-from-navigating-away-using-javascript when all else fails.
    - (And other potential 'prompt-engineering' helpers, once they are known.)

- Bugfix: make `<iframe>`s work like they do for humans (scroll when scrolling with mouse over them, accept mouse/keyboard control when focused, accumulate `directLink`s).

- Communication:
    - Replace Web Socket communication with WebRTC, to drop dropped packets rather than re-send them.
    - Compression. Examples:
        - Values: only transmit the difference between values and a simple shared prediction model, and entropy-encode that.
        - Control (JSON and JS, currently): just compress. And strip comments from JS, and minify it.
        - Computation: possibly, communicate each value's precision, so that agents only have to predict the general area, not the precise imprecise values. (If agents are well-trained, this allows users to safely use a really low resolution, maybe 4-bits-per-value.)

- A more sophisticated data pipeline for training on edge cases than "see them once, perform 1 update".

- At least mouse+keyboard interaction with native applications (games), because it's probably where you spend most of your time anyway, and WebEnv is all about taking your agents with you through your life.

- Unit tests.