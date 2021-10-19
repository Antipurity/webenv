A PyTorch implementation of an agent.

## Files

- Basic:
  - `webenv.py`: a Python bridge to `webenv.js`.
  - `recurrent.py`: RNN training. (Backpropagation-through-time and synthetic gradient.)
- Replaceable:
  - `ldl.py`: linearithmic (time and space) dense layers. (For handling big inputs & outputs with neither quadratic scaling nor assumptions about structure.)
  - `reinforcement_learning.py`: maximization code, for non-prediction goals. (Mostly by modeling the reward and maximizing that model's output.)
  - `main.py`: putting it all together.

Unimplemented: save/load.

Did not implement opinions: non-static sparsity (to make [low-dimensional representations](https://arxiv.org/abs/1906.10720) high-dimensional by combining many); [Transformers](https://arxiv.org/abs/2103.03206); non-loss [exploration reward](https://arxiv.org/abs/2101.09458) to [optimize](http://proceedings.mlr.press/v32/silver14.pdf); experience replay; [GAN](https://phillipi.github.io/pix2pix/) or [DDPM](https://arxiv.org/abs/2006.11239) losses; [Siamese networks](https://arxiv.org/abs/2011.10566); literally anything else (use your imagination and/or ML expertise).

## Tutorial

If you ever woke up in the middle of the night to think, "damn, I **need** to know how to run this PyTorch example!" — well, you are in luck!

First, make sure to have [Python](https://www.google.com/search?q=install+python) 3.7+ (90 MB) and [PyTorch](https://www.google.com/search?q=install+pytorch) (1.2 GB, mostly due to CUDA) installed. And `npm install -g webenv-ml`, obviously.

Optionally, install [TensorBoard](https://www.google.com/search?q=install+tensorboard), to be able to create and view those loss plots. Pretty bad software though, would not recommend.

Then, launch `main.py` in this directory:

```bash
python main.py
```

To stop it, press Ctrl+C, or pour lava on your computer. On stopping, exceptions are normal, though not during runtime (if there are, then you are seeing a bug; open an issue).

If you want, modify hyperparameters in `main.py` (such as `tensorboard`), and/or copy this folder to another place and modify `webenv_path` at the bottom of `main.py` appropriately: if in a folder with the `webenv` NPM package installed, simply `webenv_path = 'webenv'`.

This marks the end of this tutorial.

## Results

Video prediction with agency is hard, but possible.

Here, predictions are on the right, delayed by a few frames. We used [Google's homepage](https://www.google.com/).

<p>
  <img width=49% src=images/agent-1.png>
  <img width=49% src=images/agent-2.png>
  <img width=49% src=images/agent-3.png>
  <img width=49% src=images/agent-4.png>
</p>

<p style="text-align:center">
  <img src=images/noexplore-anim.gif>
</p>

(The dots are similar to your own colorful patternful noise and fleeting afterimages near changed conditions, and hallucinations. This might show that your brain learns stuff, though data is inconclusive.)

The loss goes down, and reward goes up, though exploration hardly does anything in this simple environment.

TODO: Loss & reward plots of the new algo. (And preferably, another GIF, now that UI is updated.)

Here, `unroll_length`=`2` (orange) learns better than synthetic-gradient-only `unroll_length`=`1` (red):

<p style="text-align:center">
  <img width=342 src=images/unroll_length_2_is_better.png>
</p>

In conclusion:

Predictions are blurry, and loss is high. After a couple hours of training, video prediction is not solved, only poked at.

Not satisfied? Perfect: implement your own ideas on your big computer.

[For example, here are some LSTM tricks for slightly better handling of learning-through-time.](https://www.niklasschmidinger.com/posts/2020-09-09-lstm-tricks/)

## Bonus

Since math-y visualizations are always pretty, here is a comparison between vanilla dense layers and linearithmic dense layers:

<p style="text-align:center">
  <p style="margin:0 auto; display:table">
    <img width=49% src="images/dl_8.png">
    <img width=49% src="images/ldl_8.png">
  </p>
  <p style="margin:0 auto; display:table">
    <img width=49% src="images/dl_64.png">
    <img width=49% src="images/ldl_64.png">
  </p>
</p>

Every input→output connection is included (as a combination of a few others). So despite sparsity, the minimal reaction time is still `1` frame, no matter what needs to be reacted to.