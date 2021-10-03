## WebEnv

Turn the most widely-used data interchange format (the Web) into a numeric interface (Env) for training general intelligence: learn a rich understanding of the world, then accomplish user-defined tasks with it.

Agents interact with the Web by continuously receiving observations and sending actions.
- Reward is decided dynamically, if ever. Agents ought to be self-supervised and/or integrated with human life.
- Both observations and actions can be extremely-high-dimensional, so models must be scalable.
- The particular interface format can be defined by both initialization and web-pages, so only fully general architectures can succeed.
- One environment is one continuous bidirectional stream of data. Agents have to learn online, possibly through many parallel environments.

Setting up an infinite loop that allows useful learning in any situation is essential for the most interesting applications of intelligence. WebEnv provides a clean interface to the real world, while discouraging practices that act as barriers to learning.

Have you ever been annoyed by how AI articles misrepresent progress in AI to average readers, making it seem like AI is a singular entity that can do all these amazing tasks and is about to take over their jobs? That's because the reality is that tasks are separated by years of research, not a quick "AI, please do this" prompt. If those articles were written about models in fully general environments such as WebEnv, that impression would have been much more accurate.

## Getting started

Using [NPM](https://www.npmjs.com/), as you commonly do in machine learning, install the `webenv-ml` package:

```bash
npm install -g webenv-ml
```

Then, `require` it in JavaScript, or use a bridge to another language, and use it:

## Index

- [Create your own agent, via copy-modify](https://github.com/antipurity/webenv/tree/master/examples)
- [Choose the static interfaces](https://github.com/antipurity/webenv/blob/master/docs/INTERFACES.md)
- [Choose additional datasets](https://github.com/antipurity/webenv/tree/master/tools)
- [What counts as solving WebEnv](https://github.com/antipurity/webenv/blob/master/docs/AGENTS.md)
- [Explanations of architectural decisions](https://github.com/antipurity/webenv/blob/master/docs/questionable.md)
- [Roadmap to MVP](https://github.com/antipurity/webenv/blob/master/docs/FUTURE.md)

## Features

No constraints to make learning easier. Brush against raw generality.

- Multimodal interfaces: the Web contains text-in-pages, video, audio, interactive UI, games, and other data streams. Large ML datasets often scrape small parts of all this. Here, challenge the shapeshifting master of data. (Train on the `RandomURL` dataset to randomly sample the Web.)
    - Extensible: choose the particular static interfaces that your agent can rely on, and allow web pages to dynamically establish direct links. Pre-empt the age of neural interfaces by using `directLink` in your website.

- Universality: WebEnv is able to include all ML datasets and environments, behavior of ML solutions in them, an agent's own behavior, and most of human ingenuity. Instead of creating a new agent for each task, re-use the same one for all. When data gets too big to memorize, generality is the only solution.
    - Open-ended: one way to describe general intelligence is "good zero-shot performance on unseen tasks", and the most unseen tasks are ones that do not exist yet. Web pages can call `directScore` to evaluate your agent, creating an expansive set of maximization tasks, which will only get bigger with time.

- Efficiency: combining all formats introduces a non-insignificant representation overhead, so WebEnv is fast and robust to compensate. It even supports batch sizes of more than `1`: simply write computations, not interfaces to data and users.
    - Real-time: agents must focus on their throughput and frame-time consistency too. This presents novel challenges to many ML frameworks (namely, efficient BPTT handling is pain, easier to use synthetic gradients).

- Self-determination: under constant pressure to represent essentially-infinitely-complex interactions with data and goals, only the most complete representations will survive, creating mesa-optimizers: aware of everything, general, quickly adaptable, and learned. Research learned agency at scale.
    - Understandable: general intelligence can only be guided and judged by general intelligence, so interfaces (mostly) share a human-usable format, and observations and their predictions are easy to inspect visually. This also makes it easy to ensure AI safety. (TBD: a built-in interface for humans to connect their browsing to agents with one click, for easy creation of AGI-as-a-service platforms.)

## Caveats

No constraints to make learning easier. Brush against raw generality.

- You can get IP-banned by some websites for running bots. ([Respect ](https://www.w3.org/wiki/Write_Web_Crawler)[the etiquette.](http://www.robotstxt.org/guidelines.html))

- Reliant on its community: people deciding to use `directLink` and `directScore` to create experiences that they cannot currently partake in. For example, there are currently no direct-link forum/chat/comments, nor Web-controlled robots. (AGI-as-a-service should help with adoption, with absolutely no chance of anything going wrong.)

- URLs are invisible to agents. Agents cannot interact with popups, and so, for example, cannot install extensions.

- Web code is not native code. Without an explicit bridge, it is impossible to send actions to or receive non-video observations from native applications. (In exchange, we leverage greater control over what happens, currently through navigation and visual augmentations.)

## License

MIT