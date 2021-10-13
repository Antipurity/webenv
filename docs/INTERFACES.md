This documents what interfaces are available for use in WebEnv.

Think of this as a wish-list of what you want your agents to use.

# Contents

- [Contents](#contents)
- [Entry point](#entry-point)
- [Essentials](#essentials)
- [Batch size](#batch-size)
- [Observations](#observations)
- [Actions](#actions)
- [Utilities](#utilities)
- [Defaults](#defaults)
- [Contributing](#contributing)

# Entry point

To initialize a web environment:

```javascript
const webenv = require('webenv')
const env = webenv.init(...interfaces)
```

This creates a strong and independent environment that runs by itself.

`env` defines:
- `env.reads` and `env.writes`: the exact current observation and action space sizes, respectively.
- `await env.relink(...interfaces)`: changes the basic interfaces dynamically.
- `await env.close()`: kills the environment.

Read the rest of this document for the available interfaces, and/or the runtime documentation `require('webenv').init.docs` for details.

You may want to write your own agent. Base it on `webenv.randomAgent()`:

```js
webenv.init(
    { async agent(stream, {obs, pred, act}) {
        await 'asteroid impact'
        for (let i = 0; i < act.length; ++i)
            act[i] = Math.random()*2-1
        return true
    } }
)
```

Alternatively, to think out of the box, simply include `webenv.defaults` and `webenv.settings({homepage:'…'})` and the agent, and be done with this documentation.

# Essentials

Always include these.

```js
webenv.settings({ ……… })
```

Defines settings.

These include:

- `homepage:'about:blank'`: the URL to open a browser window to. (For example, set it to the RandomURL dataset.)
- `simultaneousSteps:16`: how many steps are allowed to run at once (at most). Set to `1` to fully synchronize on each step, which makes visualization nicer but introduces a lot of stalling.
- If for `webenv.browser`, `width:640` and `height:480`.
- If for `webenv.browser`, `userProfile`, which is a function from stream to the user profile directory. The default is `webenv/puppeteer-chrome-profile-INDEX`.
- `port:1234` and `httpsOptions:null`: the server's options.
    - Optionally, specify key and certificate in `httpsOptions`, [as specified here](https://nodejs.org/en/knowledge/HTTP/servers/how-to-create-a-HTTPS-server/).
- `hidePredictions:false`: whether extensions cannot see predictions (to really cut off all copyright complaints).

```js
webenv.userAgent(agent = 'WebEnv agent <https://github.com/Antipurity/webenv>')
```

Specifies the User-Agent string.

Identify yourself and include contact information to overcome some of [the prejudice against bots on the Web](https://www.w3.org/wiki/Bad_RDF_Crawlers).

```js
webenv.stability()
webenv.stability(timeout = 10, noCookies = true)
```

Increases stability.

In particular, this:
- Closes new tabs.
- Tries to enable ad blocking, because ML models shouldn't need that.
- Closes all dialogs opened by page JS.
- Opens new tabs in the main tab, so that there is only ever one tab, and image/audio capture doesn't break.
- Deletes cookies if `noCookies`, to be more stateless.
- Discards JS console entries, in case they accumulate and cause bother.
- To prevent infinite loops and/or heavy memory thrashing, if `timeout` (seconds) is non-zero: periodically checks whether JS takes too long to execute, and if so, re-launches the browser.

```js
webenv.directLink()
webenv.directLink(name = 'directLink', maxReads = 2**16, maxWrites = 2**16)
```

Allows web pages to dynamically establish high-bandwidth connections to the agent, via calling `directLink`.    
(Abusing this feature will cause agents to get very confused, as they have no way to know about format changes apart from prediction.)

(The closest analogue of a real-time data channel that has equal read and write capabilities for humans is music (high-effort art is too slow), which can be used to capture and convey the neural feel of arbitrary neural computations. Research music 2.0, preferably if you have a direct neural link device.)

In a page, `directLink(PageAgent, Inputs = 0, Outputs = 0)` will return `true` if successfully established, else `false`.    
`PageAgent` will be called automatically, until it does not return `true` and gets canceled.    
`PageAgent(Act, Obs)` synchronously reads from `Act` (of length `Inputs`) and writes to `Obs` (of length `Outputs`) after all asynchrony is done. All values are 32-bit floats, `-1`…`1` or `NaN`.    
(No predictions, and thus no iffiness about copyright.)

```js
webenv.directScore()
webenv.directScore(hidden=false, store={}, maxHorizon=100000, name='directScore')
```

Exposes a function that allows web pages to rate the agent's performance with a number, the higher the better: `typeof directScore=='function' && directScore(x)`.

The agents can access the normalized-to-`-1`…`1` `obs[0]` unless `hidden`, and model & maximize it. (Normalized so that there is no preference among pages, only for in-page performance. And to be in a sane range.)

SHA-256 hashes of URLs are reported to the server (for normalization), for as much privacy as possible.

Args:
- `hidden`: if `false`, exposes 1 number to the agent at the beginning: the average score since the last frame, or `NaN`.
- `maxHorizon`: approximately how many most-recent samples to average over.
- `store`: the database of URL→momentums.
    - It is either `{ scoreFile='', saveInterval=300, maxUrls=1000000 }` for simple JSON-saving every 300 seconds, or
    - exposes the interface `{ get(k)→v, set(k, v→v), open(), close() }`.
    - (If you run many WebEnv instances, then you need one explicit database here.)
- name`: the name of the exposed-to-pages function.

# Batch size

By default, WebEnv runs only one browser.

To run more, use:

```js
webenv.browser(...interfaces)
```

Puppeteers a browser to make it into a data stream.

Ideally, you should not treat observations/actions as anything other than vectors of approximately `-1`..`1` 32-bit floats. (Not necessarily square, not necessarily an image. Very likely multimodal.)

Top-level interfaces given to `webenv.init(…)` are copied into all streams, so adding extra browsers can be done as simply `we.init(…, we.browser(), we.browser())` (which runs 2).

# Observations

These interfaces define numbers that agents can see.

All observations are numbers in `-1`..`1`.

(With `webenv.visualize()`, most of these can be easily visualized for debugging.)

```js
webenv.image()
webenv.image(maskColor = 0xfafafa)
```

Observations of the whole viewport. All R/G/B values are numbers.

Provide a mask color (`0xRRGGBB`) to mark exact matches as "should be replaced with its prediction" (NaN), or `null` to disable that. Non-black-and-white masks may get distorted by video compression, and thus become unusable.

Big and thus slow.

```js
webenv.imageRect()
webenv.imageRect(width = 50, height = width, quantize = 1, maskColor = 0xfafafa)
```

Observations of a rectangle centered around the mouse. All R/G/B values are numbers.

The effective mouse position will be altered to have both coordinates divisible by `quantize`, to reduce drift.

Provide a mask color (`0xRRGGBB`) to mark exact matches as "should be replaced with its prediction" (NaN), or `null` to disable that.

(A moving viewpoint acts as a crop of the image. And since web pages are typically consistent, this acts as the well-known augmentation for training visual models: two crops of the same image should have a very similar representation. No zooming like electromagnetic sensors in 3D environments get for free, though.)

```js
webenv.imageFovea()
webenv.imageFovea(radius = 100, numPoints = 5000, quantize = 1, RNG = mulberry32(53299), density = x=>x*x*x, maskColor = 0xfafafa)
```

Observations of arbitrarily-offset points around the mouse. All R/G/B values are numbers.

The effective mouse position will be altered to have both coordinates divisible by `quantize`.

Provide a mask color (`0xRRGGBB`) to mark exact matches as "should be replaced with its prediction" (NaN), or `null` to disable that.

```js
webenv.audio()
webenv.audio(samples = 2048, sampleRate = 44100)
```

Observations of most-recent audio data, as `samples` interleaved-channel numbers, each channel (2) providing `sampleRate` numbers per second.

```js
webenv.frameTime()
webenv.frameTime(fps = 20, maxMs = 1000)
```

Provides an observation of the time between frames, relative to the expected-Frames-Per-Second duration, in (less-than-1) multiples of `maxMs`.

```js
webenv.const()
webenv.const(value, interface)
webenv.const(value = 1, obsCount = 1, actCount = 0)
```

Tired of coding bias neurons?

Just create a constant input.

Also useful for not confusing agents when removing interfaces by not shifting others.

# Actions

These interfaces allow agents to interact with web pages.

All actions are numbers in `-1`..`1`.

```js
webenv.scrollBy()
webenv.scrollBy(sensitivity = 100)
```

2 actions, which add to X/Y viewport scroll position in pixels, multiplied by `sensitivity`.

```js
webenv.mouse()
webenv.mouse({
  left=true, right=false, middle=false,
  wheel=0, absolute=true, relative=0,
})
```

Exposes all actions related to mouse movement and buttons.

`left`/`right`/`middle` are button-related.

`wheel` dispatches `wheel` events, with delta X/Y multiplied by the specified parameter.

`absolute` sets X/Y viewport mouse coordinates; `relative` adds to X/Y coordinates, multiplied by the specified parameter.

(If `absolute`: neural networks have trouble distinguishing per-pixel differences in page offsets, so a non-learned loss makes predictions very blurry, even when the RNN has settled into a point-like attractor.)

```js
webenv.keyboard()
webenv.keyboard(Options = { maxAtOnce:3, ... }, Keys='...')
```

Exposes keyboard actions as buttons.

`Options` is passed on to the underlying `webenv.triggers(...)`.

`Keys` is a space-separated string of [keys](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values) (or `Spacebar`). `Shift`ed variants of keys have to be manually included.

```js
webenv.interval(func, sec = 60)
```

Periodically runs a trigger's start, such as `webenv.triggers.homepage` (which is particularly good when the homepage opens a random Web page).

Training-only (Puppeteer-only).

```js
webenv.triggers({
  threshold=.5, resetOnNewPage=true, maxAtOnce=0, cooldown=0, priority=0,
}, ...triggers)
```

Exposes a group of triggers, such as keys on a keyboard.

Each trigger is `{ start, stop,  injectStart, injectStop }`, all functions if defined.

(`start`/`stop` are functions if defined. `injectStart`/`injectStop` are arrays, where the first item is the funcs and the rest are its args; try to keep args static.)

For example: `webenv.triggers({ maxAtOnce:1, cooldown:600 }, {start(stream) { stream.page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ') }})`

`cooldown` is in agent steps, not real time.

```js
webenv.triggers.homepage
webenv.triggers({}, webenv.triggers.homepage)
```

Back to homepage.

Training-only (Puppeteer-only): users should not be asked to sample random web pages, or look at the datasets.

```js
webenv.triggers.goBack
webenv.triggers({}, webenv.triggers.goBack)
```

The back-button.

```js
webenv.triggers.randomLink
webenv.triggers({}, webenv.triggers.randomLink)
```

Picks a random file: or http: or https: link on the current page, and follows it.

# Utilities

These vacuous interfaces can be very useful for certain needs.

```js
webenv.visualize()
webenv.visualize(path = '')
```

Allows visualizing observations and predictions, by opening `localhost:1234/path` or similar in a browser.

To prevent others from seeing observations, use random characters as `path`. Not extremely secure, but visualization is not exactly a safety-critical application (and in-web-page authentication is slightly less convenient).

See runtime docs `require('webenv').visualize.docs` for details on how interfaces declare themselves viewable.

```js
webenv.filter()
webenv.filter(allowURL = ..., cache = null, maxCacheSize = 30 * 2**30)
```

Intercepts requests, allowing to disallow some URLs and to cache.

Example: `webenv.filter(null, 'cached')`

`allowURL`: `null`, a regex, or a function from URL and request object and the Puppeteer page to either `null` (to disallow) or the object `{ url }` (to allow).    
By default, this forbids non-`file:` pages to access `file:` URLs, so including `webenv.filter()` is a good idea for safety.
`robots.txt` is ignored.

`cache`: `null` or the path to the cache directory.

`maxCacheSize`: if `cache` is a string, 30GB is the default maximum compressed size.

```js
webenv.io()
```

Makes the actual agent reside in another process than this environment, connected through standard IO through a very simple protocol.

Useful for isolation, parallelization, and bridging to other languages.

If one stream in an env has this, then all other streams there must have this too.

For protocol details, refer to runtime documentation: `require('webenv').io.docs`. (In short, agents get stream-index and observations and action-length, and send stream-index and predictions and actions. No compression except via int encoding.)

```js
webenv.fps(fps = 30)
```

Replaces real time with virtual time, for semi-consistent time-per-frame.

This does not change video playback speed, but does control when JS timeouts fire.


```js
webenv.loopback()
webenv.loopback(count = 1)
```

Outputs the most recent action as the observation.

Agents might use this to compensate for latency.

```js
webenv.randomAgent(relative = 0)
```

Simply puts random `-1`..`1` floats as actions on each step, for testing.

If `relative` is not `0`, the agent meanders its action instead of jumping constantly.

```js
webenv.augmentations()
webenv.augmentations(severity = 1, transition = 2)
```

Some DOM-aware image augmentations: random [transforms](https://developer.mozilla.org/en-US/docs/Web/CSS/transform) and [filters](https://developer.mozilla.org/en-US/docs/Web/CSS/filter).

`severity` is the multiplier for many effects.

`transition` is the max duration of smooth transitions in seconds.

(This makes every frame open-ended, since augmentations can happen at any time. Losses that average outcomes would blur all predictions a little; plausibility-maximizing losses would not.)

```js
webenv.fetchSlice()
```

This replaces a dataset server for `file:` pages, for convenience. Puppeteer-only.

This exposes the `_fetchLocalFileSlice` function; see [`/tools/data/fetchSlice.js` for the function `fetchSlice(url, start = 0, end = null)`](../tools/data/fetchSlice.js) that dataset pages should use.

Reading the whole dataset into memory is often unfeasible, so, slicing is needed.

Some datasets have a fixed sample size, some separate their samples with newlines. Periodically fetch big slices and handle what you have.

# Defaults

```js
webenv.defaults = [
    webenv.stability(),
    webenv.directLink(),
    webenv.directScore(),
    webenv.userAgent(), // 'WebEnv agent <https://github.com/Antipurity/webenv>'; please override
    webenv.fetchSlice(),
    webenv.visualize(),
    webenv.filter(null, 'cached'),
    webenv.const(),
    webenv.loopback(),
    webenv.frameTime(),
    webenv.imageFovea(100, 5000, 1),
    webenv.scrollBy(),
    webenv.mouse({ absolute:false, relative:50 }),
    webenv.keyboard(),
    webenv.augmentations(),
    webenv.interval(webenv.triggers.homepage, 60),
    exports.triggers(
        { maxAtOnce:1, cooldown:3600 },
        exports.triggers.goBack,
        exports.triggers.randomLink),
]
```

This defines a very simple environment for agents that have a reasonable execution time per step even with non-high-end Nvidia hardware.

# Contributing

Have another application in mind? Contribute.

[Look at how interfaces are implemented](../webenv.js), and/or understand the basic principles, by looking at runtime documentation `require('webenv').init.docs` or `require('webenv').browser.docs`.