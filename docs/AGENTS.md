# Awareness

Know: the WebEnv environment is intended to be usable with any models that you can come up with, in almost any programming language.

To create your agents, use your imagination.

If you have none, or simply want to read smart-sounding stuff to pass the time, here are some basic guidelines to use when developing your AGI models.

The single most important point for developing AGI is:

- **Have huge computational capabilities**: be rich, research for the rich, and/or live in the future.

Less importantly, problems always define their solutions, so you want to implement generality and intelligence:    
the model must do anything, and change what it does.

# Behavior (speedy)

The two most important parts of any behavior are *external* and *internal*.    
For generality, both must display diverse performance under pretty much any metrics.

- Externally, the **environment** (awareness).    
If the Web, which contains a lot of what humans have achieved, and into which many humans pour their lives, is not general, then you have bigger problems than inability to train AGI models.    
If the Web is not enough for your tastes, contribute to it, and/or live in the future.

- Internally, the **agent** (generality).    
Say, `matMul(input, weights)` (dense layer) connects all inputs to all outputs, and a non-linearity even makes the transformation non-linear and thus able to approximate any pure function.    
Just don't forget to incorporate past state, and prevent value and gradient from getting too big or too small.    
For example, an LSTM.    
(If the agent mirrors the environment, it should learn to be exactly as diverse as that automatically.)

For changing behavior, the system must also pursue arbitrary goals, along with the instrumental goal "how fast other goals are reached".

- Gotta go **fast**, or the model will be left behind by developers (speed).    
WebEnv is intended to be used with very big observation and action spaces, so a dense layer is far too slow.    
Recent research on general architectures that deal with scalability includes [Perceiver](https://arxiv.org/abs/2103.03206) and linearithmic dense layers.    
(Also, might want to focus your agents on throughput and parallelization, to use compute efficiently.)

- Everything that lives is created to die, and all behavior is designed to **change** (learning).    
And for every way to change, we can specify a goal that it improves, meaning that any change method is an optimizer.    
So, infinite goal complexity; we can analyze it the same way we've analyzed infinite behavior complexity.

To summarize this section:

> Models that use WebEnv should be scalable general-purpose architectures.

# Optimization (compression)

Building an understanding of a data stream is synonymous with compressing it.    
Compression of own history encourages coherent behavior.

Consider implementing this explicitly.

- **Optimizer** (speed).    
Scalability is the most important aspect of the way the model changes.    
Stochastic gradient descent (SGD) and its variants (such as Adam) is very commonly used, though it can be challenging to ensure constant-time steps when training RNNs with backprop-through-time and standard ML frameworks.    
Alternatively, you can experiment with other ways-to-change, for example, Hebbian rules or HTM; do tell others how it went.    
(Speed is the instrumental goal of all other goals: if facts are inferred faster, then the predicted-valid action is more accurate. So even learned optimizers would learn speed.)

- **Actions** (learned goals).    
One of the most important architectural decisions for your model is: whether it outputs one action, or best-of-many.    
Fundamentally, answering "what is AGI?" is answering "what is a good life?".    
× Perhaps, having an immutable lifelong objective, and performing an initially-random search over actions that best satisfy that objective, such as money or status or safety or food or action? Probably not: that often leads to addiction or trauma, both known for lack of accomplishments.    
× Perchance, knowing the general shape of what humans can achieve, then intermittently deciding to achieve a thing, figuring out all its implementation details and thus gaining a skill? Possibly, yes.    
It's the latter that AGI implementers should implement: self-supervised learning and self-determination. It only needs one action too, so, very easy to implement and compute.    
(Self-determination is based on past opportunity much more than goal-seeking, so as long as you don't allow your models to implement ways to kill humans no matter how much a military would pay you, you should be fine on the AI safety front.)

- **Loss** (generalization via compression).    
We recommend only using next-observation prediction.    
This might seem like giving up on all other objectives, however, the environment is so general that all objectives are in fact contained in its prediction.    
For example, you can create a web-page that shows a reinforcement learning agent play a game, and directly link the agent's value-function predictions and policy and action, and next-observation prediction will have to learn that; or it might learn to think in words from all the humans that write down their thought processes, or learn what humans find desirable, or learn how humans act.    
And what is learned is easy to choose to use, for self-determination or for transfer learning or for user interaction.    
(While there's overhead from having to learn to parse and connect all those things, the benefit of having one ML model that effectively contains all other ML models justifies generality.)

- **Non-averaging** (awareness).    
The main enemy of self-determination is averaging: in open-ended situations, it makes predictions not found in reality, making actions that are based on them incoherent.    
Unfortunately, essentially all basic distance-minimizing loss functions average outcomes.    
(For example, in most NLP models (such as [GPT](https://proceedings.neurips.cc/paper/2020/file/1457c0d6bfcb4967418bfb8ac142f64a-Paper.pdf)), un-averaging is done at run time: the word probability is averaged, then sampled to generate words. Without cherry-picking of results, or prompt engineering, such a model has no style of its own, and spits out random guesses in open-ended situations.)    
We recommend losses that learn and maximize plausibility, effectively learning the distance metric. In other words, make your model the generator of a GAN like [pix2pix](https://phillipi.github.io/pix2pix/) did, or come up with something similar but cleverer.    
(Even though self-supervised loss does not dictate actions directly, plausible outcomes should still allow optimizers to be learned around actions, to explain their style.)

> Models should model WebEnv by learning and maximizing plausibility.

# Agent (learned goals)

We have briefly touched on actions previously; here are more details.

An agent takes observations, considers possible actions, and chooses the best one: reinforcement learning (RL). WebEnv has no reward to measure "best" against, so agents have to do intrinsically-motivated learning.

Free will, agency, that sort of thing. Though modern reinforcement learning is hardly equipped to tackle those except by technicality.

- **Scalability** (speed).    
WebEnv is intended to require very-high-dimensional actions, so that there is no way to enumerate all actions and estimate the future values of the objective of each action.    
Agents have to consider very few actions, possibly even one.    
(Though historically, human-computer interaction has been all about high-dimensional human observations and low-dimensional human actions, so WebEnv actions are rather low-dimensional by default. Even face-to-face human interactions have significantly more actions. Please contribute web-pages that creatively use `directLink` with many inputs.)

- **Completeness** (generalization).    
Those few actions have to fully cover the space of future possibilities, with an understanding of all that can be done.    
This is typically addressed by enumerating all possible actions, however, this is at odds with scalability, since most actions may be effectively the same in many environments.    
WebEnv is intended to capture all environments, which makes any pre-programmed understanding of possibilities not universal, and makes learning the whole agent the preferable solution to completeness.

- **Exploration** (awareness).    
Agents have to solve the classic exploration-exploitation tradeoff: getting more accurate knowledge of the objective, while using its knowledge to maximize the objective.    
While it is possible to estimate known unknowns, such as by measuring misprediction of what is seen, estimating unknown unknowns is somewhat impossible to pre-program.    
Still, it is not out of the question that some methods of estimating unknown unknowns work better in an environment than other methods.    
Learned exploration strategies could exploit such situations, suggesting that learning the agent (and its exploration) is better than not.

- **Mesa-optimization** (learned goals).    
One lesson from machine learning is that you can learn more than you can program.    
The most important aspect of free will is that it's learned, not given: learn agents, don't program them.    
Agents are complex, so they will only be learned if a different agent improves the base objective at every point during development, which significantly limits the solution space.    
The more advanced the base agent is, the harder it is for learned agents to replace, so it is natural to make the base agent only consider one action, making it hardly an agent.

Every programmer should be suspicious of having to solve essentially the same problems twice, so why implement RL separately from self-supervised learning?

A random initialization would perform essentially random actions.    
This random behavior space is already fully general, but not useful.    
Self-supervised learning compresses this space to be both general and useful, as in, general intelligence: AGI.    
Reinforcement learning limits this behavior space to be near actions with high reward, which can only hinder generality.

Though if you dislike self-determination for any reason, such as the lack of guarantees about safety, WebEnv does nothing to prevent you from creating actual agents. (Though explicitly-programmed control is at most as safe as its hardware+software stack, which is [very](https://cromwell-intl.com/cybersecurity/hardware.html) [unsafe](https://owasp.org/www-community/vulnerabilities/).)

> To research self-determination, try to avoid non-loss base objectives.

> Make sure that adding/removing interfaces at the end is stable. If the internal state is a big vector of numbers, slice its beginning as next-observation predictions, and slice-and-reverse its ending as actions.

---

WebEnv turns the question "how can we combine everything that can happen in one model of the whole world?" into "why is our agent's loss not going down?" and "why is this not being learned, and can we visualize its learning as a web page?".

In other words, AGI is inevitable, get off your ass and make it already, if you can.