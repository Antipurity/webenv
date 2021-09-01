# WebEnv

Extensible machine learning environment for training general intelligence.

Agents interact with the Web by continuously receiving observations and sending actions.
- There is no explicit reward signal (see [General agents](docs/AGENTS.md) for reasons). Agents must be fully self-supervised.
- Both observations and actions can be very-high-dimensional, so models must be scalable.
- The particular interface format can be defined by both initialization and web-pages, so only fully general architectures can succeed.
- One environment is one continuous bidirectional stream of data. Agents have to learn online, possibly through many parallel environments.

Setting up an infinite loop that allows useful learning in any situation is essential for the most interesting applications of intelligence. WebEnv provides a clean interface to the real world, while discouraging practices that act as barriers to learning.

## Index

- TODO: Getting started, just below.
- TODO: Examples, to base agents on top of.
- [Choose the static interfaces](docs/INTERFACES.md)
- [Choose additional datasets](tools/README.md)
- [General agents](docs/AGENTS.md)
- TODO: Also Q&A, as in, explain *why* of many decisions.

## Features

- Multimodal interfaces: the Web contains text-in-pages, video, audio, interactive UI, games, and other data streams. Large ML datasets often scrape small parts of all this. Here, challenge the shapeshifting master of data.
    - Extensible: choose the particular static interfaces that your agent can rely on, and allow web pages to dynamically establish direct links, though no page currently does that. Pre-empt the age of neural interfaces by using `directLink` in your website.

- Universality: WebEnv is able to include all ML datasets and environments, behavior of ML solutions in them, and most of human ingenuity. When data gets too big to memorize, generality is the only solution.
    - Open-ended: there is no explicit evaluation metric, though web pages can call `directScore` to vote on your agent's performance (feel free to call it in your websites). One way to describe general intelligence is "good zero-shot performance on unseen tasks", and the most unseen tasks are ones that do not exist yet. If you create a task, be creative. If you train an agent, use it for a long time instead of throwing it away as usual.

- Focus on throughput: combining all formats introduces a significant representation overhead, so WebEnv compensates with efficiency.
    - Real-time: agents must focus on their throughput and frame-time consistency too. This presents novel challenges to many ML frameworks (in other words, proper BPTT handling is pain, easier to use synthetic gradients).

- Self-determination: the Web is a source of information, not control. So, self-supervised learning only. Even a random agent will be able to visit essentially all of the Web (with "view random page" actions), then with too many histories to memorize, decide and remember its own goals. Research learned agency at scale.
    - Understandable: general intelligence can only be judged by general intelligence, so interfaces (mostly) share a human-usable format, and observations and their predictions are easy to inspect visually. To make inspections even easier, web pages can also deliberately create visual holes in themselves, which agents replace with next-observation predictions.

## Getting started

TODO: ...what, do we just say how to install it? Need to upload an NPM package for this first, right?