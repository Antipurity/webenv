The term "AGI" includes literally everything under its umbrella, so to not get lost in infinite possibilities, an extremely keen sense of redundancies is required. Here, we outline the minimal AGI solution; see [Examples](../examples/README.md) for implementations.

## Problem definition

So, what counts as "solving" WebEnv?

It is a two-parter: handling infinite data complexity, and handling infinite goal complexity.

To be more precise:

1. Do next-frame predictions so well that, in eternal absence of observations (such as on the Void 'dataset'), humans cannot distinguish predictions and real histories, through neither accuracy nor diversity, even in open-ended situations such as a programming language REPL. This requires a model of the world and the agent's role in it, useful for downstream tasks.

2. Be able to quickly satisfy arbitrary user goals, especially those that are impossible to solve without a world model: extremely-sparse-reward tasks that are described with words, such as "get a university degree". Optimization for goals of many others is largely the same as being a society member, amortizes [deception risk](https://arxiv.org/abs/1906.01820) and turns it into self-determination, and propels an agent from a toy to a product.

If you do not know where to begin solving these two, then this guidance is for you. (Mostly intended for ML models, true.)

## Prerequisites

The WebEnv environment is intended to be usable with any models that you can come up with, in almost any programming language.

However.

The single most important point for developing AGI is:

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
So, infinite optimization complexity. We will analyze it in the same way we've analyzed infinite behavior complexity.

## What it will do

- **Generality**.    
To see what lies beyond the current model, have to enumerate/sample all possible models: search.    
Direct formalizations of this are trivial: [AIXI](http://www.hutter1.net/ai/uaibook.htm), [random search](https://en.wikipedia.org/wiki/Random_search).

- **Speed**.    
The problem with search at runtime is that it is extremely inefficient in large search spaces (such as parameters of a neural network).    
Rather than searching, it is more efficient to have searched: learning.    
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

Not mentioned: exploration, which in a sense *maximizes* loss through actions in addition to minimizing it, to offset exploitation and sample possibilities more uniformly. Could be useful. Could be supplanted by intermittent random-page transitions. Unclear right now.

Moreover, some representation-simplicity encouragement such as [dropout](https://jmlr.org/papers/volume15/srivastava14a/srivastava14a.pdf) or `x[N + random.randrange(len(x)-N):]` could improve generalization. The narrative (4 words twice) was already too complex, no need for more details.

Additionally, arbitrary-goals might be enough to learn a consistent world model, making next-frame prediction unnecessary. However, having arbitrary goals requires full human endorsement, prediction does not, and we at least have to start somewhere. Unclear right now.

Furthermore, remember that your agents are only as secure as the hardware+software stack that they are built on, which is [very](https://cromwell-intl.com/cybersecurity/hardware.html) [unsafe](https://owasp.org/www-community/vulnerabilities/). Write secure code, people; if possible, isolate WebEnv itself in a VM.

## Conclusion

If "integrated with anything, can represent anything, can learn anything, and is as efficient as it can be" is not enough for your conception of AGI, then you are probably overthinking it. Get a bigger computer, implement your conception, work out the kinks and redundancies, and you will probably arrive at equivalent functionality.

Yes, get a bigger supercomputer, in addition to an AGI-as-a-service platform.

If only I was more powerful.

I'm sorry.