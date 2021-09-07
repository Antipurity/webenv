import torch



def L1(pred, got):
  """Goes to median."""
  return (pred - got).abs().sum()
def L2(pred, got):
  """Goes to mean."""
  return .5*(pred - got).square().sum()



class GradMaximize(torch.nn.Module):
  """
  Gradient-based reward maximization.

  In ML terms, this implements (simplified) Deep Deterministic Policy Gradients: https://spinningup.openai.com/en/latest/algorithms/ddpg.html

  Optimizes via an adversarial game: given the internal model `rew`, `rew(state)` is made equal to actual reward (without gradient to `state`), whereas `state` maximizes `rew(state)` (without gradient to `rew`).

  Constructor args:
  - `reward_model`: a function from state to reward (prediction).
  - `loss=L2`: a function from reward prediction and reality, to the number to minimize.
  - `strength=1.`: multiplier of maximization's loss.
  - `pred_gradient=False`: whether reward prediction gives gradient to the model too, for more accuracy.

  Call args:
  - `x`: state.
  - `reward`: real reward; `.detach()` if differentiable. (If integrating with `Return`, pass its result here.)

  Call result: the loss to minimize (`.backward()`).

  Traditionally, Reinforcement Learning (reward maximization) is done via considering actions (or plans) and picking those with max predicted reward/return (let's call this "discrete RL" for convenience). Comparatively, GradMax has a few advantages, namely:
  - Discrete RL has to explicitly incorporate future rewards into the past, to compute the predicted & maximized `Return` (via the Bellman equation). GradMax incorporates the future via RNN's gradient, with no extra machinery and no extra hyperparameter.
  - Discrete RL can only directly give gradient to actions. GradMax, unless explicitly limited, gives gradient to the whole state.
  - For continuous actions, discrete RL has to create binary search trees. GradMax assumes continuous and differentiable actions, though a step function can be used in the interface to make them discrete.
  - Discrete RL has to evaluate each of N actions, multiplying runtime+memory cost by N. GradMax only doubles that, approximately.
  - For very-high-dimensional action spaces, discrete RL has to consider exponentially many actions. GradMax is as linear-time as gradient descent.
  """
  def __init__(self, reward_model, loss=L2, strength=1., pred_gradient=True):
    super(GradMaximize, self).__init__()
    self.reward_model = reward_model
    self.loss = loss
    self.strength = strength
    self.pred_gradient = pred_gradient
    pars = reward_model.parameters()
    if hasattr(loss, 'parameters'):
      pars = [*pars, *loss.parameters()]
    self.params = [p for p in pars if hasattr(p, 'requires_grad') and p.requires_grad]
  def switch_param_gradient(self, requires_grad=True):
    for p in self.params:
      p.requires_grad_(requires_grad)
  def forward(self, x, reward):
    # 10 minutes to implement. 5 minutes to debug (more like, run).
    lR = self.loss(self.reward_model(x if self.pred_gradient else x.detach()), reward)
    self.switch_param_gradient(False)
    lX = self.reward_model(x).sum() * self.strength
    self.switch_param_gradient(True)
    return lR - lX # Predict reward, & maximize reward prediction.



class Return(torch.nn.Module):
  """
  Turns an instantaneous reward into its future return.
  Essentially, `predict(Return, (1-horizon)*Reward + horizon*Return)` and returns `Return`.

  Constructor args:
    `return_model`: a neural network from state to a number.
    `time_horizon=.99`: how much future impacts the past.
  
  Forward-pass args:
    `x`: state.
    `reward=None`: if specified, does prediction immediately, else specify it later, via `.reward(x, rew)`.
  
  Delayed-reward (`r.reward(x, rew)`) args:
    `x`: state.
    `reward`: reward.
  Result: `(Return, loss)`; minimize loss manually.
  """
  def __init__(self, return_model, time_horizon=.99):
    super(Return, self).__init__()
    self.return_model = return_model
    self.time_horizon = time_horizon
  def forward(self, x, rew=None):
    if rew is None:
      return self.return_model(x)
    else:
      ret, loss = self.reward(x, rew)
      loss.backward()
      # A shame that PyTorch requires explicit tracking of the loss.
      #   (Futures-of-reward like in Conceptual would have solved this neatly.)
      return ret
  def reward(self, x, rew):
    # Average: return = (1-horizon) * reward + horizon * return.
    ret = self.return_model(x)
    momentum = 1 - self.time_horizon
    return ret, (momentum * (ret - rew.detach())).square().sum()



if __name__ == '__main__':
  # Maximize a particular number in the state.
  # Dirscrete RL: performance increases with action-count and slowly saturates.
  #   (This test is like only picking the best-of-many initializations.)
  # GradMax: far better than the best discrete RL, at much lower cost: it optimizes, not just picks.
  import numpy as np
  def str(n):
    return np.array2string(n, precision=2)
  def reward(state):
    return state[...,0].unsqueeze(-1).detach()
  ins = 20
  # Test GradMaximize.
  for N in range(1, 2):
    scores = []
    for tries in range(100):
      model = torch.nn.Linear(ins, ins, bias=False)
      max_model = GradMaximize(torch.nn.Linear(ins, 1, bias=False))
      optim = torch.optim.Adam([*model.parameters(), *max_model.parameters()], lr=.01)
      input = torch.randn(ins)
      for iter in range(100):
        out = model(input)
        max_model(out, reward(out)).backward()
        optim.step(), optim.zero_grad()
      scores.append(reward(out).sum().detach())
    print('GradMax', 'score mean', str(np.mean(scores)), 'std-dev', str(np.std(scores)))