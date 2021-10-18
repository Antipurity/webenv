The term "AGI" includes literally everything under its umbrella, so to not get lost in infinite possibilities, an extremely keen sense of redundancies is required. Here, we outline the minimal AGI solution; see [Examples](../examples/README.md) for implementations.

(The suggestions here are supported by well-known trends in machine learning: [learn by gradient descent](https://en.wikipedia.org/wiki/Gradient_descent); [use general-purpose architectures](https://deepmind.com/blog/article/building-architectures-that-can-handle-the-worlds-data); [have inputs and ](https://ai.facebook.com/blog/self-supervised-learning-the-dark-matter-of-intelligence/)[learn them](https://openai.com/blog/gpt-3-apps/); [have outputs and ](https://deepmind.com/blog/article/alphazero-shedding-new-light-grand-games-chess-shogi-and-go)[learn ](https://deepmind.com/blog/article/generally-capable-agents-emerge-from-open-ended-play)[them](https://deepmind.com/blog/article/learning-through-human-feedback). Here, we argue that integrating these in one environment and agent is both necessary and sufficient for AGI.)

## Problem definition

So, what counts as "solving" WebEnv?

It is a two-parter: handling infinite data complexity, and handling infinite goal complexity.

To be more precise:

1. Do next-frame predictions so well that, in eternal absence of observations (such as on the Void 'dataset'), humans cannot distinguish predictions and real histories, through neither accuracy nor diversity, even in open-ended situations such as a programming language REPL. Or at least be indistinguishable from human dreams. This requires a model of the world and the agent's role in it, useful for downstream tasks.

2. Be able to quickly satisfy arbitrary user goals, especially those that are impossible to solve without a world model: extremely-sparse-reward tasks that are described with words, such as "get a university degree". Optimization for goals of many others instead of only your own is: largely the same as being a society member, amortizes [deception risk](https://arxiv.org/abs/1906.01820) and turns it into self-determination, and propels an agent from a toy to a product.

If you do not know where to begin solving these two, then this guidance is for you. (Mostly intended for ML models, true.)

## Prerequisites

The WebEnv environment is intended to be usable with any models that you can come up with, in almost any programming language.

However.

[The single ](https://mathai-iclr.github.io/papers/papers/MATHAI_29_paper.pdf)[most important point](https://openai.com/blog/deep-double-descent/) for developing AGI is:

- **Have huge computational capabilities**: be rich, research for the rich, and/or live in the future.

Less importantly, problems always define their solutions, so you want to implement generality and intelligence:    
the model must do anything, and change what it does.

## What it does

If the agent mirrors the environment, then it should learn to be exactly as diverse as that, as long as it is theoretically able to.

The two most important parts of any behavior are *external* and *internal*: data and model.

- Externally, the **environment** (awareness).    
Use WebEnv.    
If the Web, which contains a lot of what humans have achieved, and into which many humans pour their lives, is not general, then you have bigger problems than inability to train AGI models.    
If the Web is not enough for your tastes, contribute to it, and/or live in the future.

- Internally, the **agent** (generality).    
Connect everything to everything, encode a graph, be Turing-complete, etc.    
For example, `matMul(input, weights)` (dense layer) connects all inputs to all outputs, and a non-linearity even makes the transformation non-linear and thus able to approximate any pure function.    
Do not forget to incorporate past state into input (recurrency), and prevent value and gradient from getting too big or too small. For example, use an LSTM.

The two most important parts of any agent are *external* and *internal*: optimization and efficiency.

- Internally: gotta go **fast**, or the model will be left behind by developers (speed).    
WebEnv is intended to be used with very big observation and action spaces, so a dense layer is far too slow. Need some linear-time-ish state transition.    
Recent research on fully general architectures that deal with scalability includes [Transformers](https://arxiv.org/abs/2103.03206) (of course), [other reshaping](../examples/Python/ldl.py), [matrix factorization](https://arxiv.org/pdf/2010.04196.pdf), and [sparsity](https://arxiv.org/abs/2102.01732).    
(Though historically, human-computer interaction has been all about high-dimensional human observations and low-dimensional human actions (such as mouse+keyboard), especially on the Web, so WebEnv actions are rather low-dimensional by default. Even face-to-face human interactions have significantly more actions. Please contribute web-pages that creatively use `directLink` with many inputs.)

- Externally: everything that lives is created to die, and all behavior is designed to **change** to make a number go up (learning).    
The line between optimization and change is blurry, because for every change, there exist numbers that go up. Still, an explicit optimizer is the best way to control behavior.    
(A [Transformer](https://arxiv.org/abs/2103.03206) can be seen as an inductive bias toward mesa-optimization, since [it can be seen as differentiable choices](https://antipurity.github.io/conceptual#tutorial%20softmax). However, we have to secure sources of change first.)    
So, infinite optimization complexity. We will analyze it in the same way we've analyzed infinite behavior complexity.

## What it will do

- **Generality**.    
To see what lies beyond the current model, have to enumerate/sample all possible models: search.    
Direct formalizations of this are trivial: [AIXI](http://www.hutter1.net/ai/uaibook.htm), [random search](https://en.wikipedia.org/wiki/Random_search).

- **Speed**.    
The problem with search at runtime is that it is extremely inefficient in large search spaces (such as parameters of a neural network).    
Rather than searching from scratch each time, it is far more efficient to only search a bit and remember results: learning.    
Stochastic gradient descent (SGD) and its variants are usually used for learning. It is ancient tech, but it still works well.    
Alternatively, you can experiment with other ways-to-change, for example, [Hebbian rules](https://en.wikipedia.org/wiki/Generalized_Hebbian_algorithm) or HTM (Thousand Brains); do tell others how it went.

- **Awareness**.    
If goals are intended to change, then it is better to not re-learn a model of the same world from scratch for each goal, but rather re-use the same one.    
Predict the world. Compress it into your agent.    
WebEnv is designed with next-frame prediction in mind, as an easy-to-inspect target.    
Directly minimize (`min = -max`) [a basic loss](https://ml-cheatsheet.readthedocs.io/en/latest/loss_functions.html), or to not assume direct causality, [learn a loss](https://en.wikipedia.org/wiki/Expectation%E2%80%93maximization_algorithm)[/goal and ](https://phillipi.github.io/pix2pix/)[adversarially optimize it](https://keras.io/examples/rl/ddpg_pendulum/).    
The benefit of generality outweighs its overhead: if datasets are augmented with ML models that solve them, and/or if the Web allows close interaction with other agents or even humans, then prediction would combine all models into one. Alternatively:

- **Change** (learn) goals.    
Learning a thing is more efficient than leaving it static. So what is the goal of your goal, or of all goals? The search space is infinite, so you will eventually encounter meta-circularity as the most stable arrangement.    
Without spoiling the experience, WebEnv's `directScore(x)` can provide a goal distribution that is both complex enough to average out heuristics, and is aligned with humanity's interests.    
Have to apply that compute, though. Both human-compute, making it a standard practice, and machine-compute, learning it.

Naturally, you can add anything you want to this base: exploration, [dropout](https://jmlr.org/papers/volume15/srivastava14a/srivastava14a.pdf), etc.

Moreover, arbitrary-goals might be enough to learn a consistent world model, making next-frame prediction unnecessary. However, self-supervised learning builds the most stable yet accurate knowledge base for any goal to use, so, universe assimilator > general intelligence, probably. Unclear without compute and human endorsement of those arbitrary goals.

Furthermore, remember that your agents are only as secure as the hardware+software stack that they are built on, which is [very ](https://cromwell-intl.com/cybersecurity/hardware.html)[unsafe](https://owasp.org/www-community/vulnerabilities/). Write secure code, people; if possible, isolate `webenv.browser`s in a VM or on another machine.

## Conclusion

If "integrated with anything, can represent anything, can learn anything, and is as efficient as it can be" is not enough for your conception of AGI, then you are probably overthinking it. Get a bigger computer, implement your conception, work out the kinks and redundancies, and you will probably arrive at equivalent functionality.

Yes, get a bigger supercomputer, in addition to an AGI-as-a-service platform.

If only I was more powerful.

I'm sorry.