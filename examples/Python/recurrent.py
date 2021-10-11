# ½-day to develop. ¼-day to debug.
import torch
import asyncio
import numpy as np



# Input: gather state along streams, and put observations into it.
def webenv_ignore(state, obs_t):
  """
  Ignores observations. Loss will take them into account anyway.
  """
  return state
def webenv_add(state, obs_t):
  """
  Teacher Forcing.
  Adds WebEnv observations to internal state, properly ignoring holes (NaNs).
  """
  padded = torch.nn.functional.pad(obs_t, (0, state.shape[-1] - obs_t.shape[-1]), value=np.nan)
  return torch.where(torch.isnan(padded), state, state + padded)
def webenv_merge(state, obs_t):
  """
  Merges (writes) WebEnv observations into internal state, properly ignoring holes (NaNs).

  Note that this overwrites predictions, so the model cannot access them. If you want your model to know both real and predicted numbers, use `input=webenv_concat` in `recurrent`.
  """
  padded = torch.nn.functional.pad(obs_t, (0, state.shape[-1] - obs_t.shape[-1], 0,0), value=np.nan)
  return torch.where(torch.isnan(padded), state, padded)
def webenv_concat(state, obs_t):
  """
  Puts observations after predictions. Expect twice the numbers in your transition model.

  Holes (NaNs) in observations will be replaced with the prediction, allowing observation resizing at the cost of repetition.
  """
  obs2 = webenv_merge(state, obs_t)
  return torch.cat((state, obs2), dim=-1)



# Output.
async def webenv_slice(lock, state, indices, obs, act_len):
  """
  Turns two PyTorch state tensors (pre-step and pre-output) (and what WebEnv received: observations and action lengths) into post-step state and lists of predictions and actions, asynchronously.
  """
  # `obs` and `act_len` are lists of equal length `state.shape[0]`.
  with torch.no_grad():
    max_slice = state.shape[-1] # Only allow up to 100% in a slice.
    preds, acts = [], []
    for i in range(len(obs)):
      # Slice obs and actions from ends. (Reverse actions for stability.)
      ind = indices[i, 0]
      pred_t = state[ind, 0:min(max_slice, obs[i].shape[-1])]
      act_t = state[ind, max_slice - min(max_slice, act_len[i]):max_slice].flip(-1)
      # Asynchronously copy to CPU.
      pred = torch.zeros_like(pred_t, layout=torch.strided, device='cpu', memory_format=torch.contiguous_format)
      act = torch.zeros_like(act_t, layout=torch.strided, device='cpu', memory_format=torch.contiguous_format)
      pred.copy_(pred_t, non_blocking=True)
      act.copy_(act_t, non_blocking=True)
      preds.append(pred)
      acts.append(act)
    lock.set_result(None)
    # Wait until all GPU→CPU copies are done, then return lists of predictions and actions.
    event = torch.cuda.Event()
    event.record()
    while not event.query():
      await asyncio.sleep(.001)
    return [p.numpy() for p in preds], [a.numpy() for a in acts]



# Pre-input and pre-output.
def webenv_gather(state1, indices): # → state2
  if state1.shape[0] == 1: return state1
  indices = torch.tensor(indices, device = state1.device)
  indices = indices.expand(indices.shape[0], *state1.shape[1:]) # Apparently required for the backward pass to work.
  return torch.gather(state1, 0, indices)
def webenv_scatter(state1, indices, state2): # → state1
  if state1.shape[-1] != state2.shape[-1]:
    raise TypeError('Pre/post transition sizes mismatch')
  if state1.shape[0] == 1: return state2
  indices = torch.tensor(indices, device = state1.device) # Double op; inefficient.
  indices = indices.expand(indices.shape[0], *state1.shape[1:]) # Apparently required for the backward pass to work:
  #   https://pytorch.org/docs/stable/generated/torch.Tensor.scatter_.html
  return state1.clone().scatter_(0, indices, state2)



# Minimization targets.
def L1(pred, got, *_):
  return (pred - got).abs().sum()
def L2(pred, got, *_):
  return .5*(pred - got).square().sum()



# RNN.
def recurrent(
  state,
  loss = L1,
  optimizer=None,
  device='cuda',
  unroll_length=16,
  unrolls_per_step=1,
  synth_grad=None,
  synth_grad_loss = L2,
  input = webenv_merge,
  output = webenv_slice,
  gather = webenv_gather,
  scatter = webenv_scatter,
):
  """
  Creates a decorator, which creates a real-time recurrent multi-stream transformer (input→output).

  Args:
    `state`: the initial state or its shape, such as `(1,64)`. The decorated `transition` takes a state and returns a state, as PyTorch tensors.
      (This is never re-allocated, so make sure to never go above this.)
    `loss`: computes the number to minimize, given `pred` and `actual` (and all args). L1 by default.
      (`pred` and `actual` differ only in `input`. The shared parts can be conditioned-on, by learned losses.)
    `optimizer`: the PyTorch optimizer. Adam by default.
    `device`: the device to use for numeric computations. `'cuda'` by default.
    `unroll_length`: how long to accumulate gradients before applying them, either a number or a function that takes a number and returns a bool. 16 by default.
      (Backpropagation-through-time.)
      (A high unroll length adds a lot of latency to some frames, because PyTorch has no easy way to desynchronize the backward pass at the cost of some correctness.)
      (If 1, specify `synth_grad`.)
    `unroll_per_step`: how many unrolls per `optimizer` step. 1 by default.
      (This is technically the upper bound, because not all streams have data available at every step.)
    `synth_grad`: a function from state to its gradient, which stitches different unrolls together. `None` by default.
    `synth_grad_loss`: computes the number to minimize. L2 by default.
    `input`: goes from PyTorch state and observation to the updated state. `webenv_merge` by default.
    `output`: goes from PyTorch state and step's args to the output, async. `webenv_slice` by default.
    `gather`: extracts stream state slices before `input`. `webenv_gather` by default.
    `scatter`: reunites stream state slices after `output`. `webenv_scatter` by default.
  After these args, supply the `transition` in another call.
  Then, await calls to step, passing in indices (`0` to only have one stream, else `np.array([[0],[1],[3],[4]], dtype=np.int64)`), observations (NaN-filled where lengths mismatch), and any other args.
  """
  def rec(transition):
    nonlocal optimizer, state
    if optimizer is None:
      optimizer = torch.optim.Adam(transition.parameters(), lr=3e-4)
    if isinstance(state, list) or isinstance(state, tuple):
      if len(state) != 2:
        raise TypeError('State must be 2D')
      state = torch.zeros(*state, device=device)
    else:
      state = state.copy(device=device)
    state.detach_().requires_grad_()
    start_state = state
    unroll_index = 0
    unroll_loss = 0
    unrolls = 0
    async def step(lock, indices, obs, *args):
      # Step.
      nonlocal start_state, state, unroll_index, unroll_loss, unrolls
      obs_t = list_to_torch(obs, device)
      state2 = gather(state, indices)
      prev_state2 = state2
      state2 = input(prev_state2, obs_t)
      # Prev frame predicts this one:
      unroll_loss = unroll_loss + loss(prev_state2, (webenv_merge(prev_state2, obs_t) if input is not webenv_merge else state2).detach(), obs_t, *args)

      state2 = transition(state2)
      state = scatter(state, indices, state2)
      unroll_index += 1
      # Backprop.
      if unroll_length(unroll_index) if callable(unroll_length) else (unroll_length <= unroll_index):
        if synth_grad is not None:
          with torch.no_grad():
            grad = state - synth_grad(state)
          unroll_loss = unroll_loss + (state * grad).sum()
        unroll_loss.backward()
        unroll_loss = 0.
        if synth_grad is not None:
          st = start_state.detach()
          synth_grad_loss(synth_grad(st), st - start_state.grad).backward()
        unrolls += 1
        if unrolls >= unrolls_per_step:
          unrolls = 0
          optimizer.step()
          optimizer.zero_grad()
        start_state = state = state.detach().requires_grad_(True)
        unroll_index = 0
      return await output(lock, state, indices, obs, *args)
    return step
  return rec
def list_to_torch(xs, device):
  # NaN-pad these 1D NumPy arrays to their max length and stack, then send to `device`.
  max_dim = max(x.shape[-1] for x in xs)
  xs = np.stack([np.pad(x, (0, max_dim - x.shape[-1]), constant_values=np.nan) for x in xs])
  return torch.tensor(xs, device=device)



if __name__ == '__main__':
  async def test(n, device):
    obs = np.random.randn(1, 32).astype('float32') * .1
    obs[0,2] = np.nan

    class Dense(torch.nn.Module):
      def __init__(self, N, device):
        super(Dense, self).__init__()
        p = torch.nn.Parameter
        self.weights = p(torch.randn(N, N, device=device), requires_grad=True)
        self.bias = p(torch.randn(N, device=device), requires_grad=True)
        self.scale = p(torch.randn(N, device=device), requires_grad=True)
      def forward(self, x):
        x = torch.matmul(x, self.weights.data.requires_grad_(True))
        x = x / (x.square().sum().sqrt() + 1e-12)
        x = x * self.scale
        x = x + self.bias
        return x

    N = 128
    transition = Dense(N, device)
    synth = Dense(N, device)
    optim = torch.optim.Adam([*transition.parameters(), *synth.parameters()], lr=.001)
    stream = recurrent(
      (1,N), device=device, optimizer=optim, unroll_length=2, synth_grad=synth,
    )(transition)

    import time
    start = time.time()
    indices = np.array([[0]], dtype=np.int64)
    for i in range(n):
      preds, acts = await stream(asyncio.Future(), indices, obs, [0])
      with torch.no_grad():
        print('L1:', np.nansum(np.abs(preds[0] - obs)))
    print('Time:', time.time() - start, 's')
  asyncio.run(test(5000, 'cuda'))