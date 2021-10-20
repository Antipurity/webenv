import torch



def L1(pred, got):
  """Goes to median."""
  return (pred - got).abs().sum()
def L2(pred, got):
  """Goes to mean."""
  return .5*(pred - got).square().sum()



class Split(torch.nn.Module):
  """
  Splits an RNN (any `x→x` 1D function) into two RNNs, so that two goals can be optimized for without gradient interference, but with mutual awareness. Specify the loss separately.
  (Goals such as reward prediction and its maximization.)
  Provide the RNN and the expected output count.
  See methods.
  """
  def __init__(self, fn, outs):
    if outs % 2: raise TypeError('Output count must be even')
    super(Split, self).__init__()
    self.fn = fn
    self.frozen = False
    self.half_outs = outs // 2
    self.p = [p for p in fn.parameters() if p.requires_grad]
  def first(self, x, freeze=True, out_slice=..., chunks=None):
    """Evaluates the first RNN."""
    try:
      self.freeze(freeze)
      return self.fn(self.chunk(x, 0, chunks), out_slice=out_slice)
    finally:
      if freeze: self.freeze(False)
  def second(self, x, freeze=True, out_slice=..., chunks=None):
    """Evaluates the second RNN."""
    try:
      self.freeze(freeze)
      return self.fn(self.chunk(x, 1, chunks), out_slice=out_slice)
    finally:
      if freeze: self.freeze(False)
  def chunk(self, x, half=None, chunks=None):
    """Chunks the input into first half (`0`) and second half (`1`).
    The output is the same as the input, except it's only differentiable at that half.
    (Input size could be a multiple of output size, in which case input is treated as many inputs concatenated, meaning, halves are repeated.)"""
    if chunks is None:
      chunks = x.chunk(torch.div(x.shape[-1], self.half_outs, rounding_mode='trunc'), -1)
    if half is None: return chunks
    return torch.cat([c if i % 2 == half else c.detach() for i,c in enumerate(chunks)], -1)
  def freeze(self, do=True):
    """Un/freezes the model's trainable parameters.
    Use when computing a loss that's dependent on the model (such as prediction's maximization)."""
    if self.frozen != do:
      for p in self.p:
        p.requires_grad_(not do)
      self.frozen = do
  def forward(self, x):
    """(concat f(first)[:mid] f(second)[mid:])
    This but (up to 2×) faster for shallower networks."""
    # 
    m = self.half_outs
    chunks = self.chunk(x)
    a, b = (..., slice(None, m)), (..., slice(m, None))
    return torch.cat((self.first(x, False, a, chunks), self.second(x, False, b, chunks)), -1)



class AlsoGoalsForActions(torch.nn.Module):
  """Like `fn(x)`, but `fn(x)[2:4]` becomes `fn.second(x)[0:2]`. (It makes sense in `main.py`.)"""
  def __init__(self, fn):
    super(AlsoGoalsForActions, self).__init__()
    self.fn = fn
  def forward(self, x):
    out = self.fn(x)
    out[..., 2:4] = self.fn.second(x, out_slice=(..., slice(0,2)))
    return out



class GradMaximize(torch.nn.Module):
  """
  Old.
  Inferior (because reward prediction machinery can be reused, whereas this creates a separate predictor).
  Gradient-based reward maximization.

  In ML terms, this implements (simplified) Deep Deterministic Policy Gradients: https://spinningup.openai.com/en/latest/algorithms/ddpg.html

  Optimizes via an adversarial game: given the internal model `rew`, `rew(state)` is made equal to actual reward (without gradient to `state`), whereas `state` maximizes `rew(state)` (without gradient to `rew`).

  Constructor args:
  - `reward_model`: a function from state to reward (prediction).
  - `loss=L2`: a function from reward prediction and reality, to the number to minimize.
  - `strength=1.`: multiplier of maximization's loss.
  - `pred_gradient=False`: whether reward prediction gives gradient to the model too, for more accuracy.
  - `momentum=.99`: we keep a slowly-changing copy of `reward_model` with parameters updated by momentum, and maximize that for more stability. `0` for instant updates.

  Call args:
  - `x`: state.
  - `reward`: real reward/return; `.detach()` if differentiable.

  Call result: the loss to minimize (`.backward()`).

  Traditionally, Reinforcement Learning (reward maximization) is done via considering actions (or plans) and picking those with max predicted reward/return (let's call this "discrete RL" for convenience). Comparatively, GradMax has a few advantages, namely:
  - Discrete RL has to explicitly incorporate future rewards into the past, to compute the predicted & maximized return (via the Bellman equation). GradMax incorporates the future via RNN's gradient, with no extra machinery and no extra hyperparameter (unless you really want that sweet Bellman action in here).
  - Discrete RL can only directly give gradient to actions. GradMax, unless explicitly limited, gives gradient to the whole state.
  - For continuous actions, discrete RL has to create binary search trees. GradMax assumes continuous and differentiable actions, though a step function can be used in the interface to make them discrete.
  - Discrete RL has to evaluate each of N actions, multiplying runtime+memory cost by N. GradMax only doubles that, approximately.
  - For very-high-dimensional action spaces, discrete RL has to consider exponentially many actions. GradMax is as linear-time as gradient descent.
  """
  def __init__(self, reward_model, loss=L2, strength=1., pred_gradient=True, momentum=.99):
    super(GradMaximize, self).__init__()
    self.reward_model = reward_model
    self.loss = loss
    self.strength = strength
    self.pred_gradient = pred_gradient
    self.momentum = momentum
    self.copy = self.init_momentum(reward_model)
  def init_momentum(self, net):
    import copy
    cp = copy.deepcopy(net)
    for x,y in zip(net.parameters(), cp.parameters()):
      y.requires_grad_(False)
      y.data.copy_(x.data)
    return cp
  def update_momentum(self, net, cp, momentum):
    with torch.no_grad():
      for x,y in zip(net.parameters(), cp.parameters()):
        y.data = momentum * y.data + (1-momentum) * x.data
  def forward(self, x, reward):
    # 10 minutes to implement. 5 minutes to debug (more like, run).
    self.update_momentum(self.reward_model, self.copy, self.momentum)
    lR = self.loss(self.reward_model(x if self.pred_gradient else x.detach()), reward)
    lX = self.copy(x).sum() * self.strength
    return lR - lX # Predict reward, & maximize reward prediction.



if __name__ == '__main__':
  # Maximize a particular number in the state.
  #   `Split` is more direct, so can optimize the number far quicker.
  import numpy as np
  def str2(n):
    return np.array2string(n, precision=2)
  def reward(state):
    return state[...,0].unsqueeze(-1).detach()
  ins = 20
  N, tries = 1, 500
  # (Removed the test of `Maximize`, which enumerates actions. It was very non-scalable.)
  # Test `GradMaximize`: model & maximize the first number.
  for _ in range(N):
    scores = []
    for _ in range(tries):
      model = torch.nn.Linear(ins, ins, bias=False)
      max_model = GradMaximize(torch.nn.Linear(ins, 1, bias=False))
      optim = torch.optim.Adam([*model.parameters(), *max_model.parameters()], lr=.01)
      input = torch.randn(ins)
      for iter in range(100):
        out = model(input)
        max_model(out, reward(out)).backward()
        optim.step(), optim.zero_grad(True)
      scores.append(reward(out).sum().detach())
    print('GradMax', 'score: mean', str2(np.mean(scores)), 'std-dev', str2(np.std(scores)))
  # Test `Split`: second half maximizes the first number.
  import ldl
  for _ in range(N):
    scores = []
    for _ in range(tries):
      model = Split(ldl.Linear(ins, ins, bias=False), ins)
      optim = torch.optim.Adam(model.parameters(), lr=.01)
      input = torch.randn(ins)
      for iter in range(100):
        # Need `model(input)` and not just `input` to optimize output.
        out = model.second(model(input), out_slice=slice(0,1))
        L = -out.sum()
        L.backward()
        optim.step(), optim.zero_grad(True)
      scores.append(reward(out).sum().detach())
    print('Split', 'score: mean', str2(np.mean(scores)), 'std-dev', str2(np.std(scores)))