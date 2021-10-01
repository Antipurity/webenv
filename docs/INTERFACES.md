This documents what interfaces are available for use in WebEnv.

Think of this as a wish-list of what you want your agents to use.

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

Read the rest of this document for the available interfaces.

You may want to write your own agent. Base it on `webenv.randomAgent()`:

```js
webenv.init(
    { async agent(obs, pred, act) {
        await 'asteroid impact'
        for (let i = 0; i < act.length; ++i)
            act[i] = Math.random()*2-1
        return true
    } }
)
```

Alternatively, for an out-of-the-box interface solution, simply include `webenv.defaults` and the homepage URL and the agent, and be done with this documentation.

# Essentials

Always include these.


```js
webenv.userAgent(agent = 'WebEnv')
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
webenv.directLink(name = 'directLink', maxReads = 16*2**20, maxWrites = 16*2**20, maxInterfaces = 1024)
```

Allows web pages to dynamically establish high-bandwidth connections to the agent, via calling `directLink`.

(The closest analogue of a real-time data channel that has equal read and write capabilities for humans is music, which can be used to capture and convey the neural feel of arbitrary neural computations. Research music 2.0, preferably if you have a direct neural link device.)

In a page, `directLink(PageAgent, Inputs = 0, Outputs = 0)` will return (a promise of) `true` if successfully established, else `false`.

`PageAgent` will be called automatically, until it returns a non-`true` value. `PageAgent(Act, Obs)` synchronously reads from `Act` (of length `Inputs`) and writes to `Obs` (of length `Outputs`) after all asynchrony is done. All values are 32-bit floats, `-1`…`1` or `NaN`.

```js
webenv.directScore()
webenv.directScore(hidden=false, maxHorizon=100000, maxUrls=1000000, scoreFile='', saveInterval=300, name='directScore')
```

Exposes a function that allows web pages to rate the agent's performance with a number, the higher the better.

The agents can access the normalized-to-`-1`…`1` `obs[0]` unless `hidden`, and model & maximize it. (Normalized so that there is no preference for pages, only in-page performance. And to be in a sane range.)

Please create web pages that use `typeof directScore!=''+void 0 && directScore(x)`, if applicable.

To view the latest improvement (the running average of normalized scores), access `env=webenv.init(…),  env.score.ALL[1]` in a WebEnv instance.

Args:
- `hidden`: if `false`, exposes 1 number to the agent at the beginning: the average score since the last frame, or `NaN`.
- `maxHorizon`: approximately how many most-recent samples to average over.
- `maxUrls`: how many statistics of reward streams to remember. No infinite memory allocation.
- `scoreFile`, for example, `'scores.json'`: the file to save per-page scores to.
- `saveInterval`: how often to save scores (and limit URL count), in seconds.
- `name`: the name of the exposed-to-pages function.

```js
webenv.fetchSlice()
```

This replaces a dataset server for `file:` pages, for convenience.

This exposes the `_fetchLocalFileSlice` function; see [`/tools/data/fetchSlice.js` for the function `fetchSlice(url, start = 0, end = null)`](../tools/data/fetchSlice.js) that dataset pages should use.

Reading the whole dataset into memory is often unfeasible, so, slicing is needed.

Some datasets have a fixed sample size, some separate their samples with newlines. Periodically fetch big slices and handle what you have.

# Observations

These interfaces define numbers that agents can see.

All observations are numbers in `-1`..`1`.

(With `webenv.webView()`, most of these can be easily visualized for debugging.)

```js
webenv.viewport()
webenv.viewport({ width=640, height=480 })
```

Sets the size of the layout viewport.

A pre-requisite for reading images.

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

(Neural networks have trouble distinguishing per-pixel differences in page offsets, so a non-learned loss makes predictions very blurry, even when the RNN has settled into a point-like attractor.)

```js
webenv.keyboard()
webenv.keyboard(Options = { maxAtOnce:3, ... }, Keys='...')
```

Exposes keyboard actions as buttons.

`Options` is passed on to the underlying `webenv.triggers(...)`.

`Keys` is a space-separated string of [keys](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values) (or `Spacebar`). `Shift`ed variants of keys have to be manually included.

```js
webenv.interval(func, ms = 60000)
```

Periodically runs a function, such as `webenv.triggers.homepage` (which is particularly good when the homepage opens a random Web page).

```js
webenv.triggers([...start], [...stop], {
  threshold=.5, resetOnNewPage=true, maxAtOnce=0, cooldown=0, priority=0
})
```

Actions which, when over `threshold`, execute their `start` functions, and execute their `stop` functions when under `threshold`.

For example: `webenv.triggers([page => page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ')], null, { maxAtOnce:1, cooldown:600 })`

`cooldown` is in agent steps, not real time.

```js
webenv.triggers.homepage
webenv.triggers([webenv.triggers.homepage])
```

Back to homepage.

```js
webenv.triggers.goBack
webenv.triggers([webenv.triggers.goBack])
```

The back-button.

```js
webenv.triggers.randomLink
webenv.triggers([webenv.triggers.randomLink])
```

Picks a random file: or http: or https: link on the current page, and follows it.

```js
webenv.triggers.randomInCache
webenv.triggers([webenv.triggers.randomInCache])
```

Navigates to a random previously-visited URL (most of the time).

Must only be used with `webenv.filter(...)`, with a string `cache` path.

(This is a very open-ended action. If the agent's loss averages outcomes, then predictions with this trigger would be quite gray and nonsensical; make sure to maximize plausibility instead, so that particular outcomes do not get penalized as long as they are plausible.)

# Utilities

These vacuous interfaces can be very useful for certain needs.

```js
webenv.mainPage(url)
```

The URL that is navigated-to whenever the browser re/launches.

```js
webenv.webView()
webenv.webView(port = 1234, httpsOptions = null, path = '')
```

Allows visualizing the observation streams as they are read, by opening `localhost:1234/path` or similar in a browser.

To use HTTPS instead of HTTP, [specify key and certificate](https://nodejs.org/en/knowledge/HTTP/servers/how-to-create-a-HTTPS-server/) in `httpsOptions`.

To prevent others from seeing observations, use random characters as `path`. Not extremely secure, but visualization is not exactly a safety-critical application.

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
webenv.io(intSize = 0)
```

Makes the actual agent reside in another process than this environment, connected through standard IO through a very simple protocol.

Useful for isolation, parallelization, and bridging to other languages.

For protocol details, refer to runtime documentation: `require('webenv').io.docs`. (In short, agents get stream-index and observations and action-length, and send stream-index and predictions and actions. No compression.)

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
webenv.injectScript(...functions)
```

Executes JS functions on every new document.

`functions` are either strings or functions that are converted to strings for in-page execution, no closure state, no NodeJS functions.

```js
webenv.injectScript.augmentations()
webenv.injectScript(webenv.injectScript.augmentations(severity = 1, transition = 1))
```

Some DOM-aware image augmentations: random [transforms](https://developer.mozilla.org/en-US/docs/Web/CSS/transform) and [filters](https://developer.mozilla.org/en-US/docs/Web/CSS/filter).

`severity` is the multiplier for many effects.

`transition` is the max duration of smooth transitions in seconds.

(This makes every frame very open-ended, since augmentations can happen at any time. Losses that average outcomes would blur all predictions, unlike GANs.)

```js
webenv.simultaneousSteps(n = 16)
```

Overrides how many steps WebEnv is allowed to run at once (at most).

Set this to `1` to fully synchronize on each step, which makes visualization nicer but introduces stalling.

# Defaults

```js
webenv.defaults = [
    webenv.stability(),
    webenv.directLink(),
    webenv.directScore(),
    webenv.userAgent(), // WebEnv, no contact info
    webenv.fetchSlice(),
    webenv.webView(),
    webenv.filter(null, 'cached'),
    webenv.viewport(), // 640×480
    webenv.const(),
    webenv.loopback(),
    webenv.frameTime(),
    webenv.imageFovea(100, 5000, 1),
    webenv.scrollBy(),
    webenv.mouse({ absolute:false, relative:50 }),
    webenv.keyboard(),
    webenv.injectScript(webenv.injectScript.augmentations()),
    webenv.interval(webenv.triggers.homepage), // Every minute, a random website
    webenv.triggers(
        [webenv.triggers.goBack, webenv.triggers.randomLink],
        null,
        { maxAtOnce:1, cooldown:3600 }),
    'http://random.whatsmyip.org/', // Has anti-bot protection, so, unsuitable for ML; please contribute a better entry point.
]
```

This defines a very simple environment for agents that have a reasonable execution time per step even with non-high-end Nvidia hardware.

# Creating your own interfaces

Have another application in mind? Contribute.

[Look at how interfaces are implemented](../webenv.js), and/or understand the basic principles:

- An interface is an object, which defines some properties/methods. Interfaces can be grouped into trees of arrays for convenience.
- All functions below can return a promise.
- Create/destroy:
    - `.init(page, env)=>state`,
    - `.deinit(page, state)` (on browser relaunching, only init);
- Read/process/write:
    - `.reads:Number`, `.read(page, state, obs)` (modify `obs` in-place);
      - `.observerInput(page, state)=>obsInput`, `.observer(obsInput, video:{grab(x,y,w,h)=>pixels}, audio:{grab(sampleN=2048, sampleRate=44100)=>samples}, obsOutput)` (before reading, these are collected from an automatically-installed extension);
    - `.agent(obs, pred, act)=>continues` (causes an automatic interpreter loop; return `false` to unlink the agent);
    - `.writes:Number`, `.write(page, state, pred, act)` (`pred` can predict the next read `obs`; do read from `act` and act on that);
- Convenience:
    - `.priority:Number` (if some interface must always go after another kind of interfaces, do not burden users, but give it a lower priority);
- Visualization, via `webenv.webView(...)`:
    - `.visState(page, state)=>vState` (the result must be JSON-serializable, sent once at init-time),
    - `.visualize(obs, pred, elem, vState)` (serialized into web-views to visualize data there, so write the function out fully, not as `{ f(){} }`).