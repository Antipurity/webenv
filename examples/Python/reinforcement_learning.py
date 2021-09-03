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



def add_one_hot_to_actions(x, N=None):
  """Puts a one-hot embedding in the middle of the state tensor."""
  # This is so long-winded.
  if N is None:
    return x
  with torch.no_grad():
    inds = torch.arange(N, device=x.device)
    act = torch.nn.functional.one_hot(inds, N)
    while len(act.shape) < len(x.shape)+1:
      act = act.unsqueeze(-1)
    mask = torch.ones_like(act)
    pads = [(x.shape[i] - N + j) // 2 for i in range(len(x.shape)) for j in range(2)]
    pads = [*reversed(pads),0,0] # Yeah, this interface makes perfect sense.
    act = torch.nn.functional.pad(act, pads)
    mask = torch.nn.functional.pad(mask, pads)
  return x * mask + act
class Stacked(torch.nn.Module):
  """
  Stacks results of models, CPU-side.
  Args:
    `N`: how many times to stack.
    `Model`: how to construct model/s.
    Others: args to `Model`.
  """
  def __init__(self, N, Model, *args, **kwargs):
    super(Stacked, self).__init__()
    self.models = torch.nn.ModuleList([Model(*args, **kwargs) for i in range(N)])
  def forward(self, x):
    # torch.nn.Linear did not bother with an option to not share weights, so, slow CPU-batching.
    return torch.stack([self.models[i](x) for i in range(len(self.models))])
def actions_as_is(x, N=None):
  """Do not change actions.
  The model must stack computations manually (such as via `Stacked` in this module)."""
  return x
def expand_actions(x, N=None):
  """
  Repeats state N times, inserting `(1,N)` at the start of dimensions.
  The model must have different weights for each action.
  """
  if N is None:
    return x.squeeze(0)
  x = x.unsqueeze(0)
  x = x.unsqueeze(0)
  return x.expand(1, N, *x.shape[2:])



class Maximize(torch.nn.Module):
  """
  Makes the model maximize a metric.
  Presumably, the actual action will be encoded in the model's result.

  Constructor args:
    `model`: the model in question.
    `max_over`: the metric, from state to a number. Learn it separately.
    `action_info=...`: given state and `N`, creates `N` distinct actions in a tensor. Puts a one-hot embedding into state by default.
    (Options, in this module: `expand_actions` (needs N× more memory, and model support), `actions_as_is`+`Stacked` (needs N× more memory), `add_one_hot_to_actions` (not diverse).)
    `N=2`: how many actions to consider each time. Compute and memory requirements scale linearly with this, but so does performance.
  
  Forward-pass args: `x`, `random_action=False`
  """
  def __init__(self, model, max_over, action_info=add_one_hot_to_actions, N=2):
    super(Maximize, self).__init__()
    self.model = model
    self.max_over = max_over
    self.action_info = action_info
    self.N = N
  def forward(self, x, random_action=False):
    # Tile and transition and argmax and select.
    t = self.action_info(x, self.N)
    t = self.model(t)
    with torch.no_grad():
      if not random_action:
        max_metric = self.max_over(t).argmax(0).expand(*t.shape)
      else:
        max_metric = torch.randint(0, self.N, (), device=t.device).expand(*t.shape)
    t = torch.gather(t, 0, max_metric)
    t = self.action_info(t)
    return t[0,...]



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
  # Test Maximize.
  max_N = ins
  for N in range(1, max_N+1):
    scores = []
    for tries in range(100):
      model = Stacked(N, torch.nn.Linear, ins, ins, bias=False)
      return_model = torch.nn.Linear(ins, 1, bias=False)
      ret = Return(return_model, time_horizon=0.)
      m = Maximize(model, ret, N=N, action_info=actions_as_is)
      optim = torch.optim.Adam([*m.parameters()], lr=.01)
      input = torch.randn(ins)
      for iter in range(100):
        # Get more accurate data before commiting. (Only helps a bit.)
        out = m(input, random_action = True if iter < 50 else False)
        # Detach `out` to make return-prediction not interact with the `model`.
        loss = ret.reward(out.detach(), reward(out))[1]
        loss.backward()
        optim.step(), optim.zero_grad()
      scores.append(reward(out).sum().detach())
    print('N', N, 'score mean', str(np.mean(scores)), 'std-dev', str(np.std(scores)))