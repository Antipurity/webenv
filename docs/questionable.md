Questions.

And answers.

### Why the "Web", and not the "Internet"?

Short.

### Why the Web?

An environment to learn in may be the most important part of a machine learning algorithm. Naturally, the most general learning algorithms require the most general environments.

We basically had a choice between simulation (OS or a browser) and the real world (robotics).

Comparing OS (an operating system, such as Windows) and a browser:

- Both contain potentially infinite parts: applications / web-pages.

- OS parts are behavior-oriented. Browser parts are data-oriented, and so, suitable for representation learning. In fact, the Web is non-local and thus contains far more information than an OS could (without a browser).

- OSes are not essentially stateless, so they gradually accumulate garbage and/or break from not-quite-proper usage. The Web is intended to be stateless.

- OSes run browsers. [But browsers can run OSes too](https://bellard.org/jslinux/), though the experience is significantly more limited.

Browser > OS.

Comparing software and hardware (the real world):

- Robots are expensive. Simulation is cheap.

- To learn, robots need to plot paths between every part of reality, without things like "dying" in between. On the Web, teleportation is the default.

Browser > robot.

### Why would machine learning (with the Web) be enough for AGI?

To solve AGI is to solve philosophy. Luckily, it's pretty easy. Unluckily, the solution does not satisfy any egos that humans spent a lot of time building up, and so it is always instantly dismissed.

If some thing [learns the world, can represent anything, can learn anything, and do it as efficiently as is reasonably possible](AGENTS.md) (and never ceases to exist). If you only consider the previous sentence rather than your intuitions, why *wouldn't* that thing be able to scale to the biggest concepts in human imagination, namely, general intelligence and the universe?

Let us go through some AGI conceptions that I know, from both AI-experts and common-sense.

- [Sparsity](https://numenta.com/a-thousand-brains-by-jeff-hawkins/): sparse-but-big representations encourage diversity (can combine far more easily than tightly-entangled features as in dense layers), in addition to simplicity-thus-generalization bonuses. Sparsity could be argued to be a part of "efficiency" (if factorizing dense layers counts as sparsity) or data, however, agents may have to implement it explicitly anyway. As long as internal vagueness hurts performance on some tasks, such as theorem proving or mesa-optimization, WebEnv encourages sparsity in agents: if explicit sparsity is so good, implement it and watch it perform well.

- Precise search (including [planning in Reinforcement Learning](https://arxiv.org/abs/2104.06303), and other [hybrid-AI approaches](https://opencog.org/)): clearly, artificial neural networks are too imprecise to solve precise tasks, so, add precision. [Though planning can be shallow, and is mostly useful for training](https://arxiv.org/abs/2011.04021). Sparsity + [meta-learning in RL](https://lilianweng.github.io/lil-log/2019/06/23/meta-reinforcement-learning.html) can learn precise searches, given data: RNN behavior is characterized by [attractors rather than individual transitions](https://arxiv.org/abs/1906.10720), so given sparsity, precise transitions can be learned and combined for exponential complexity and searches.

- [Combine all learning algorithms](https://singularitynet.io/): hard to argue that, when you can do everything, you are a general intelligence. But the formation of that "everything" was still caused by some optimizer (such as human needs), so, if you run a simple self-supervised-learning agent on all data, then it could learn all learning algorithms too. Compute+data is the answer.

- [Intelligence = compression](http://prize.hutter1.net/): prediction is how well the world is copied internally with max re-use, so, compression. For example, stochastic gradient descent would zero-out gradient for uncorrelated circuits and encourage modification of relevant circuits, so it maximizes re-use. WebEnv is made for next-frame prediction on big data, along with RL.
  - If we treat this angle more generously, it implies that agency could be learned from compressing own actions, so that a random walk through a largely-redundant space becomes a random walk through the most semantically meaningful space. WebEnv handles this trivially too.
  - If we treat it even more generously, agents should be able to compress everything including themselves, so that they could easily create agents equivalent to themselves, and self-replicate without self-replication mechanisms. Training ML models in the browser is rather unstable and minimal-functionality, mostly because Nvidia exists, and because GPUs are treated as a different world from CPUs. WebEnv is hardly ideal for learned self-replication.

- [Consciousness](https://plato.stanford.edu/entries/consciousness/): the place where all information (inputs, outputs, and even self) goes through, to be used or ignored as wanted, all experiences intermingled, with no fixed description of the system nor a simple way to exploit it. That is literally the description of an RNN that learns online, though.
  - More generously, self-awareness: the same, but, advanced, magical, not clearly visible in the mechanistic functions of the brain. Exactly like [mesa-optimization](https://arxiv.org/abs/1906.01820): generality can learn any behaviors, including general ones, resulting in a vague 'more advanced self'. Arguably, [some forms of meta-learning in RL](https://lilianweng.github.io/lil-log/2019/06/23/meta-reinforcement-learning.html) implement mesa-optimization, but do not sound *magical*. In fact, even plain RNNs can perform meta-learning too, because, well, they have state, and are technically Turing-complete. But where's the magic? Let's find the magic. (Skipping past vague criteria that are easily found in ML.)
  - Even more generously, self-knowledge: know yourself so well that you can easily convince others to be like you, even silicon (thus creating AGI). Yes, learned self-replication is hard. However, the more data and self-expression opportunities you have, the more prepared you are, and the Web is almost as big as your mother.

- Physics (no stone unturned). Consider also the scalability of AGI: it has essentially no limits, so what happens if you scale it up to the size of the reachable universe? It models the universe, it becomes the universe. This could be the future, and this could have been the past, too. If there is a possibility of AGI-universe-takeover, then with infinite time, it might as well be a certainty. And since every AGI performs a computation that learns through its past, this could be a justification for both [computational physics](https://www.wolframphysics.org/) and [fine-tuning](https://en.wikipedia.org/wiki/Fine-tuned_universe).    
(The motivation for WebEnv covers everything, from before the beginning of the world to after its end. Answers ooze from every crack. All hope for magic has been tracked down and eradicated. If not, contribute.)

Get a bigger computer, and computation is the only god that you will ever need. (Not that this sentence means much more than "stuff happens, and more stuff happening is better".)