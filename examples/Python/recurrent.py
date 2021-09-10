# ½-day to develop. ¼-day to debug.
import torch
import asyncio
import numpy as np



def webenv_add(state, obs, pad_with=np.nan):
  """
  Adds WebEnv observations to internal state, properly ignoring holes (NaNs).
  """
  padded = torch.nn.functional.pad(obs, (0, state.shape[-1] - obs.shape[-1]), value=pad_with)
  return torch.where(torch.isnan(padded), state, state + padded)
def webenv_merge(state, obs, pad_with=np.nan):
  """
  Merges WebEnv observations into internal state, properly ignoring holes (NaNs).

  Note that this overwrites predictions, so the model cannot access them. If you want your model to know both real and predicted numbers, use `input=webenv_concat` in `recurrent`.
  """
  padded = torch.nn.functional.pad(obs, (0, state.shape[-1] - obs.shape[-1]), value=pad_with)
  return torch.where(torch.isnan(padded), state, padded)
def webenv_concat(state, obs):
  """
  Puts observations after predictions. Expect twice the numbers in your transition model.

  Holes (NaNs) in observations will be replaced with the prediction, allowing observation resizing at the cost of repetition.
  """
  obs2 = webenv_merge(state, obs, 0.)
  return torch.cat((state, obs2), dim=-1)



async def webenv_slice(state, obs, act_len):
  """
  Turns a PyTorch tensor (and what WebEnv received: observation and action length) into prediction and action, asynchronously.
  """
  with torch.no_grad():
    max_slice = state.shape[-1] # Only allow up to 100% in a slice.
    # Slice obs and actions from ends. (Reverse actions for stability.)
    pred_t = state[0:min(max_slice, obs.shape[-1])]
    act_t = state[state.shape[-1] - min(max_slice, act_len):state.shape[-1]].flip(-1)
    # Asynchronously copy to CPU.
    pred = torch.zeros_like(pred_t, layout=torch.strided, device='cpu', memory_format=torch.contiguous_format)
    act = torch.zeros_like(act_t, layout=torch.strided, device='cpu', memory_format=torch.contiguous_format)
    pred.copy_(pred_t, non_blocking=True)
    act.copy_(act_t, non_blocking=True)
    event = torch.cuda.Event()
    event.record()
    while not event.query():
      await asyncio.sleep(0)
    return pred.numpy(), act.numpy()



def L1(pred, got, *_):
  return (pred - got).abs().sum()
def L2(pred, got, *_):
  return .5*(pred - got).square().sum()



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
):
  """
  Creates a decorator, which creates a real-time recurrent stream transformer (input→output).

  Args:
    `state`: the initial state or its shape, such as `(64,)`. The decorated `transition` takes a state and returns a state, as PyTorch tensors.
    `loss`: computes the number to minimize, given `pred` and `got` (and all args). L1 by default.
      (`pred` and `got` differ only in `input`. The shared parts can be conditioned-on, by learned losses.)
    `optimizer`: the PyTorch optimizer. Adam by default.
    `device`: the device to use for numeric computations. `'cuda'` by default.
    `unroll_length`: how long to accumulate gradients before applying them, either a number or a function that takes a number and returns a bool. 16 by default.
      (Backpropagation-through-time.)
      (A high unroll length adds a lot of latency to some frames, because PyTorch has no easy way to desynchronize the backward pass at the cost of some correctness.)
      (If 1, specify `synth_grad`.)
    `unroll_per_step`: how many unrolls per `optimizer` step. 1 by default.
    `synth_grad`: a function from state to its gradient, which stitches different unrolls together. `None` by default.
    `synth_grad_loss`: computes the number to minimize. L2 by default.
    `input`: goes from PyTorch state and observation to the updated state. `webenv_merge` by default.
    `output`: goes from PyTorch state and step's args to the output, async. `webenv_slice` by default.
  After these args, supply the `transition` in another call. Then, await calls to step.
  """
  def rec(transition):
    nonlocal optimizer, state
    if optimizer is None:
      optimizer = torch.optim.Adam(transition.parameters(), lr=3e-4)
    if isinstance(state, list) or isinstance(state, tuple):
      state = torch.zeros(*state, device=device)
    else:
      state = state.copy(device=device)
    state.detach_().requires_grad_()
    start_state = state
    unroll_index = 0
    unroll_loss = 0
    unrolls = 0
    async def step(obs, *args):
      nonlocal start_state, state, unroll_index, unroll_loss, unrolls
      # Step.
      obs_t = torch.tensor(obs, device=device)
      prev_state = state
      state = input(state, obs_t)
      unroll_loss = unroll_loss + loss(prev_state, state.detach(), obs_t, *args)
      state = transition(state)
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
      return await output(state, obs_t, *args)
    return step
  return rec



if __name__ == '__main__':
  async def test(n, device):
    obs = np.random.randn(32).astype('float32') * .1
    obs[2] = np.nan

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
      (N,), device=device, optimizer=optim, unroll_length=2, synth_grad=synth,
    )(transition)

    for i in range(n):
      pred, act = await stream(obs, 0)
      with torch.no_grad():
        print('L1:', np.nansum(np.abs(pred - obs)))
  asyncio.run(test(5000, 'cuda'))