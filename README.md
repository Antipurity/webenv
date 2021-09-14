# WebEnv

An extensible machine learning environment for training general intelligence.

Agents interact with the Web by continuously receiving observations and sending actions.
- There is no predefined reward signal. Agents ought to be self-supervised and/or integrated with human life.
- Both observations and actions can be extremely-high-dimensional, so models must be scalable.
- The particular interface format can be defined by both initialization and web-pages, so only fully general architectures can succeed.
- One environment is one continuous bidirectional stream of data. Agents have to learn online, possibly through many parallel environments.

Setting up an infinite loop that allows useful learning in any situation is essential for the most interesting applications of intelligence. WebEnv provides a clean interface to the real world, while discouraging practices that act as barriers to learning.

## Index

- [Get started](#getting-started)
- [Create your own agent, via copy-modify](examples/README.md)
- [Choose the static interfaces](docs/INTERFACES.md)
- [Choose additional ML datasets](tools/README.md)
- [What counts as solving WebEnv](docs/AGENTS.md)
- [Explanations of architectural decisions](docs/questionable.md)

## Features

No constraints to make learning easier. Brush against raw generality.

- Multimodal interfaces: the Web contains text-in-pages, video, audio, interactive UI, games, and other data streams. Large ML datasets often scrape small parts of all this. Here, challenge the shapeshifting master of data.
    - Extensible: choose the particular static interfaces that your agent can rely on, and allow web pages to dynamically establish direct links. Pre-empt the age of neural interfaces by using `directLink` in your website.

- Universality: WebEnv is able to include all ML datasets and environments, behavior of ML solutions in them, an agent's own behavior, and most of human ingenuity. Instead of creating a new agent for each task, re-use the same one for all. When data gets too big to memorize, generality is the only solution.
    - Open-ended: one way to describe general intelligence is "good zero-shot performance on unseen tasks", and the most unseen tasks are ones that do not exist yet. Web pages can call `directScore` to vote on your agent's performance. Whether you ignore it, learn it as any other input, or explicitly maximize it to launch an AGI-as-a-service platform, WebEnv is with you every step of the way.

- Focus on throughput: combining all formats introduces a significant representation overhead, so WebEnv compensates with efficiency.
    - Real-time: agents must focus on their throughput and frame-time consistency too. This presents novel challenges to many ML frameworks (in other words, efficient BPTT handling is pain, easier to use synthetic gradients).

- Self-determination: whether your agent simply learns consequences of its state or maximizes all user goals, eventually, mesa-optimizers are bound to be-learned then multiply: any agent will be able to visit essentially all of the Web, then with too many histories to memorize, decide/infer and remember its own goals. Research learned agency at scale.
    - Understandable: general intelligence can only be judged by general intelligence, so interfaces (mostly) share a human-usable format, and observations and their predictions are easy to inspect visually. To make this even easier, web pages can deliberately create visual holes in themselves, which agents replace with next-observation predictions (if they predict that).

## Caveats

No constraints to make learning easier. Brush against raw generality.

- Reliant on its community: people deciding to use `directLink` and `directScore` to create experiences that they cannot currently partake in. For example, there are no direct-link forum/chat/comments, nor Web-controlled robots. (AGI-as-a-service should help with adoption, with absolutely no chance of anything going wrong.)

- Communication is not a priority: human-made communication usually requires creating a per-site account, so we cannot provide a unified solution to identity management. (Fully understanding the Web is a priority, not this.)

- URLs are invisible to agents. Agents cannot interact with popups, and so cannot install extensions.

- Web code is not native code. Without an explicit bridge, it is impossible to send actions to or receive non-video observations from native applications. (In exchange, we leverage greater control over what happens, currently through navigation and visual augmentations.)

- You can get IP-banned by some websites for running bots. ([Follow ](https://www.w3.org/wiki/Write_Web_Crawler)[the etiquette.](http://www.robotstxt.org/guidelines.html))

## Getting started

TODO: Create a GitHub repo for this. `gh repo create webenv --public --license MIT -d "Extensible environment for training AGI"`

TODO: Create & upload this as an NPM package, after installing it locally and verifying that it works (via copying the example: that's the only way to be sure).

TODO: ...what, do we just say how to install it? Need to upload an NPM package for this first, right?