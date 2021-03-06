"""
Linearithmic dense layers.
NN layer combination.
Minimal gated unit.



They all support the `out_slice=...` keyword, which can speed up `out[out_slice]` for shallow nets.
"""

import math
import torch
import numpy as np



class Linear(torch.nn.Module):
  """The simplest all-to-all linear connectivity of a vector.
  Impractical for large vector sizes."""
  def __init__(self, ins, outs, bias=True, device='cpu'):
    super(Linear, self).__init__()
    sk = math.sqrt(1 / ins)
    self.w = torch.nn.Parameter(torch.rand(ins, outs, device=device, requires_grad=True))
    self.b = torch.nn.Parameter(torch.rand(outs, device=device, requires_grad=True)) if bias else None
    with torch.no_grad(): # Be like torch.nn.Linear at init.
      self.w[:] = (self.w*2-1) * sk
      if self.b is not None: self.b[:] = (self.b*2-1) * sk
  def forward(self, x, out_slice=...):
    if out_slice is ...: return torch.matmul(x, self.w) + (self.b if self.b is not None else 0)
    sl = out_slice if isinstance(out_slice, slice) else out_slice[-1]
    w, b = self.w[:, sl], (self.b[sl] if self.b is not None else 0)
    return torch.matmul(x, w) + b



class LinDense(torch.nn.Module):
  """
  An implementation of linearithmic dense layers for PyTorch.
  These avoid quadratic mixing by reshaping into `n`-sized dimensions, and mixing along each separately.

  This improves same-parameter capacity (45%→95% on CIFAR100 train-set accuracy, 18.5%→19% on test-set accuracy: https://github.com/antipurity/conceptual/blob/master/tgba/tgba.pdf), and allows big inputs/outputs.

  ==========
  Arguments:
  - `ins`: how many inputs there are.
  - `outs`: how many outputs there will be.
  - `n=16`: the max size of each dimension. The layer works best if `ins = a * n**c` and `outs = b * n**c`, especially if `ins = outs` (with `skip_connections`).
  - `batch_dims=1`: this many leading dimensions (1 or more) will share weights, the rest will have unique weights. (Vector inputs have a batch dimension inserted automatically.)
  - `unique_dims=()`: the sizes of non-batched non-mixed dimensions, for initialization. Total input dimension count must be `batch_dims + len(unique_dims) + 1`.
  - `weight_stdev=1`: the initial standard deviation of all weights.
  - `Nonlinearity=None`: the constructor of non-linearities between sub-layers, given the input size.
  - `bias=True`: whether a static vector should be added after each mix/sub-layer.
  - `skip_connections=True`: whether the previous sub-layer result should be added, for improved gradient flow. Works best if `ins == outs`.
  - `local_first=False`: whether to mix among the closest or the furthest numbers first. Local-first mixing breaks `out_slice` speedups.
  - `out_slice=...`: returns `out[out_slice]` but faster.
  - `device`
  """
  def __init__(self, ins, outs, *, n=16, batch_dims=1, unique_dims=(), weight_stdev=1, Nonlinearity=None, bias=True, skip_connections=True, local_first=False, device='cuda'):
    if not isinstance(ins, int):
      raise TypeError('Input size must be an int')
    if not isinstance(outs, int):
      raise TypeError('Output size must be an int')
    if not isinstance(n, int):
      raise TypeError('Dimension size must be an int')
    super(LinDense, self).__init__()
    self.n = n
    self.ins = ins
    self.outs = outs
    dims = math.ceil(math.log(max(ins, outs), n) - 1e-8)
    self.ins_dims = _dims_of(ins, n, dims)
    self.outs_dims = _dims_of(outs, n, dims)
    self.real_ins_dims = self.ins_dims # Reshape instead of Unflatten, because the latter can't be `torch.jit.trace`d.
    self.contract = torch.nn.Flatten(-len(self.ins_dims))
    if local_first:
      self.ins_dims = list(reversed(self.ins_dims))
      self.outs_dims = list(reversed(self.outs_dims))
    self.biases = [None] * dims if bias else None
    self.weights = [None] * dims
    self.nonlinearities = [None] * dims
    self.skip_connections = skip_connections
    self.local_first = local_first
    if batch_dims < 1:
      raise TypeError('Always include some batch dimension/s')
    self.batch_dims = batch_dims
    self.weight_stdev = weight_stdev
    for i in range(dims):
      if Nonlinearity is not None and i > 0:
        self.nonlinearities[i] = Nonlinearity()
    got_ins = np.prod(self.ins_dims)
    self.pre_pad = None if got_ins == ins else torch.nn.ConstantPad1d((0, got_ins - ins), 0)
    got_outs = np.prod(self.outs_dims)
    self.post_slice = got_outs != outs
    with torch.no_grad(): # Create Weights and Biases eagerly, the lazy way.
      self.forward(torch.zeros(*([1] * batch_dims), *unique_dims, ins, device=device))
    # Register params & sub-modules with PyTorch.
    def to_params(arr): # Why can't PyTorch just work?
      return torch.nn.ParameterList(torch.nn.Parameter(x) if x is not None else x for x in arr)
    self.biases = to_params(self.biases) if bias else None
    self.weights = to_params(self.weights)
    self.nonlinearities = torch.nn.ModuleList(self.nonlinearities)
  def forward(self, x, out_slice=...):
    # Pad. Reshape. Bring in batches. Mix. Bring batches out. Un-reshape. Slice.
    un1 = False
    if len(x.shape) == 1:
      x = torch.unsqueeze(x, 0)
      un1 = True
    batch_end = self.batch_dims
    if self.pre_pad is not None:
      x = self.pre_pad(x)
    x = torch.reshape(x, [*x.shape[:-1], *self.real_ins_dims])
    layer_dims = list(range(len(x.shape) - len(self.ins_dims), len(x.shape)))
    x = torch.transpose(x, batch_end-1, -2)
    layer_dims[-2] = batch_end-1
    # Get what we need to slice.
    outer_slice = ...
    extras = ()
    if not self.local_first:
      if out_slice is not ...:
        sl = out_slice if isinstance(out_slice, slice) else out_slice[-1]
        begin, end, step = sl.indices(self.outs)
        mul = self.n ** (len(self.outs_dims)-1)
        outer_slice = slice(begin // mul, -((-end) // mul))
        extras = (slice(None),) * (len(self.outs_dims)-1)
        start = begin - mul*outer_slice.start
        final_slice = slice(begin - mul*outer_slice.start, start + end-begin)
    else:
      layer_dims = list(reversed(layer_dims))
    # Loop.
    for i in range(len(self.ins_dims)):
      # Nonlinearity, mix along a dimension (and bias), and skip.
      y = self.nonlinearities[i](x) if self.nonlinearities[i] is not None else x
      dim_at = layer_dims[i]
      y = torch.transpose(y, dim_at, -1)
      if self.weights[i] is None:
        self.weights[i] = torch.randn(*y.shape[batch_end:-2], self.ins_dims[i], self.outs_dims[i], requires_grad=True, device=y.device)
        self.weights[i][:] *= self.weight_stdev
      w = self.weights[i]
      if outer_slice is not ...:
        w = w[..., outer_slice] if i==0 else w[[..., outer_slice, *extras]]
      y = torch.matmul(y, w)
      if self.biases is not None:
        if self.biases[i] is None:
          self.biases[i] = torch.randn(*y.shape[batch_end:-2], 1, self.outs_dims[i], requires_grad=True, device=y.device)
        b = self.biases[i]
        if outer_slice is not ...:
          b = b[..., outer_slice] if i==0 else b[[..., outer_slice, *extras]]
        y = y + b
      y = torch.transpose(y, -1, dim_at)
      if self.skip_connections and self.ins_dims[i] == self.outs_dims[i]:
        x = y + (x if outer_slice is ... or i>0 else x[[..., outer_slice, *extras]])
      else:
        x = y
    x = torch.transpose(x, -2, batch_end-1)
    x = self.contract(x)
    if self.post_slice and outer_slice is ...:
      x = x[..., :self.outs]
    if un1:
      x = torch.squeeze(x, 0)
    return x[out_slice] if self.local_first else x if outer_slice is ... else x[..., final_slice]
def _dims_of(N, n, len):
  dims = [1] * len
  size = 1
  for i in reversed(range(len)):
    dim = n if size * n < N else -(-N // size)
    dims[i] = dim
    size *= dim
  if size < N:
    raise RuntimeError('Invariant violated')
  return dims



class NormSequential(torch.nn.Module):
  """
  Creates a sequence of linear transformations, all activations initialized to 0-mean 1-variance.

  Args:
    `ins`: the input vector's size.
    `outs`: the output vector's size.
    `Layer(ins, outs, device, **kwargs)`: creates a linear layer.
    `layer_count`: how many linear transformations to create.
    `Nonlinearity()`: creates a non-linearity, put between layers. `None` by default.
    `skip_connections=True`: whether to add the previous layer's result to the next one if possible, for better gradient flow.
    `example_batch_shape=(2,)`: shape of example input (without the last `ins`), for compile-time normalization. `False` to disable that.
    `device`
    `**kwargs`
  """
  def __init__(self, ins, outs, Layer, layer_count, Nonlinearity=None, skip_connections=True, example_batch_shape=(2,), device='cuda', **kwargs):
    super(NormSequential, self).__init__()
    self.skip_connections = skip_connections
    self.ins_equal_outs = ins == outs
    self.layers = [Layer(ins, ins if i < layer_count-1 else outs, Nonlinearity=Nonlinearity, skip_connections=skip_connections, device=device, **kwargs) for i in range(layer_count)]
    self.nonlinearities = [Nonlinearity() for i in range(layer_count-1)] if Nonlinearity is not None else [None] * (layer_count-1)
    self.mult = [1.] * layer_count
    # Normalize. (Hacky: divide each layer's params by standard deviation, to make it 1.)
    with torch.no_grad():
      def norm(y, i, self):
        if y.shape[-1] <= 1: return y
        std = y.std(-1).mean()
        self.mult[i] /= std
        return y / std
      if example_batch_shape is not False:
        example_inputs = torch.randn(*example_batch_shape, ins, device=device)
        self.forward(example_inputs, norm)
        example_inputs = torch.randn(*example_batch_shape, ins, device=device)
        self.forward(example_inputs, norm)
    def to_params(arr): # Why can't PyTorch just work?
      pl, p = torch.nn.ParameterList, torch.nn.Parameter
      return pl(p(torch.tensor(x) if isinstance(x, float) else x) if x is not None else x for x in arr)
    self.mult = to_params(self.mult)
    self.layers = torch.nn.ModuleList(self.layers)
    self.nonlinearities = torch.nn.ModuleList(self.nonlinearities)
  def forward(self, x, on_layer_done = None, out_slice=...):
    for i in range(len(self.layers)):
      y = x
      first, last = i==0, i==len(self.layers)-1
      if not first:
        y = self.nonlinearities[i-1](y)
      y = self.layers[i](y, out_slice = ... if not last else out_slice)
      y = y * self.mult[i]
      if on_layer_done is not None:
        y = on_layer_done(y, i, self)
      if self.skip_connections and (not last or self.ins_equal_outs):
        y = y + (x if not last or out_slice is ... else x[out_slice])
      x = y
    x = torch.clamp(x, -1000, 1000) # Just in case.
    return x
  def parameters(self):
    for m in self.layers:
      yield from m.parameters()
    for m in self.nonlinearities:
      if m is not None:
        yield from m.parameters()
    for p in self.mult:
      if not isinstance(p, float):
        yield p



class MGU(torch.nn.Module):
  """
  Minimal gated unit: `x → (1-f)*x + f*tanh(h(f*x)) f:sigmoid(z(x))`.
  The constructor accepts the `Layer`-constructing function and `ins` and `outs`, and all its args.
  Incorporate extra state (inputs) at the end.

  Gradient will (learn to) flow unchanged through this unit unless the model handles it.

  Features:
  - Overridable `Layer`. (PyTorch's implementation hardcodes quadratic dense layers, which are no good for very-high-dimensional data.)
  - Forget gate `f`, for `x → (1-f)*x + f*next(x)`. (Closest to skip-connections `x → x+next(x)`, but easily able to counteract value drift where `x`'s magnitude keeps increasing, making it more suitable for RNNs.)
  - Due to `tanh`, output is mostly -1…1. (Perfect for WebEnv.)
  - Simplified to empirically perform well, while requiring few parameters: https://arxiv.org/abs/1603.09420
  (MGU is a simplification of GRU (a helpful illustration: https://static.posters.cz/image/750/%D0%9F%D0%BB%D0%B0%D0%BA%D0%B0%D1%82%D0%B8/despicable-me-2-gru-and-minions-i14553.jpg), which is a simplification of LSTM.)
  """
  def __init__(self, Layer, ins, outs, *args, out_mult=1., **kwargs):
    super(MGU, self).__init__()
    self.z = Layer(outs, outs, *args, **kwargs)
    self.h = Layer(outs, outs, *args, **kwargs)
    self.input = Layer(ins, outs, *args, **kwargs) if ins != outs else None
    self.out_mult = out_mult
    self.ins, self.outs = ins, outs
  def forward(self, x, out_slice=...):
    # Why think about different non-linearities when you can just, not.
    y = self.input(x) if self.input is not None else x
    f = torch.sigmoid(self.z(y)) # 0…1
    if self.ins != self.outs: x = x[..., 0:self.outs]
    if out_slice is not ...: x = x[out_slice]
    f_slice = f if out_slice is ... else f[out_slice]
    return (1 - f_slice) * x + f_slice * self.out_mult * torch.tanh(self.h(f * y, out_slice=out_slice))



if __name__ == '__main__':
  # L2 goes down to about 1e-8.
  def report_mean_stdev(f, ins, size, device): # Calibrate.
    with torch.no_grad():
      ins = torch.randn(ins, size, device=device)
      outs = f(ins)
      print('After going from mean=0 std-dev=1 (best if these are preserved):')
      print('    mean:', outs.mean().cpu().numpy(), 'std-dev:', outs.std().cpu().numpy())

  n = 16
  k = 4
  N = 16**k - 5 # Not perfectly-aligned, for testing.
  kwargs = {
    'n': 16,
    'weight_stdev': 2**-k,
    'bias': False,
    'Nonlinearity': torch.nn.Softsign,
  }
  ldl = LinDense(N, N, **kwargs)
  optim = torch.optim.Adam(ldl.parameters(), lr=.01)
  need = torch.rand(N, device='cuda') * 2 - 1
  report_mean_stdev(ldl, 10, N, 'cuda')

  # Check that slices work.
  def test_out_slices(fn, need):
    def run(fn, *args, **kwargs):
      A, B = torch.cuda.Event(enable_timing=True), torch.cuda.Event(enable_timing=True)
      A.record()
      result = fn(*args, **kwargs)
      B.record()
      torch.cuda.synchronize()
      return [result, A.elapsed_time(B)]
    with torch.no_grad():
      sliced_time = 0
      output, full_time = run(fn, need)
      times = 5000
      for _ in range(times):
        import random
        start = random.randint(0, need.shape[-1])
        sl = slice(start, random.randint(start, need.shape[-1]))
        correct = output[sl]
        got, sliced_time_here = run(fn, need, out_slice=sl)
        sliced_time += sliced_time_here
        if correct.shape != got.shape or ((correct - got).abs() > 1e-3).any():
          print('out_slice does not work:', sl, correct.shape, got.shape)
          raise RuntimeError('Output slicing does not work')
      return [full_time * times, sliced_time]
  ldl_full_time, ldl_small_time = test_out_slices(ldl, need)
  print('Output slicing works; ' + str(int(ldl_full_time/ldl_small_time*100-100)) + '% speedup.')
  mgu_full_time, mgu_small_time = test_out_slices(MGU(NormSequential, N, N, LinDense, layer_count=2, **kwargs), need)
  print('MGU output slicing works; ' + str(int(mgu_full_time/mgu_small_time*100-100)) + '% speedup.')
  import time
  time.sleep(2)

  for _ in range(500):
    optim.zero_grad()
    L = (ldl(need) - need).square().sum() # One-sample autoencoder.
    print('L2:', L.cpu().detach().numpy())
    L.backward()
    optim.step()