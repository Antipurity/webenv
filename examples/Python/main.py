# 5+ debugging days.

from torch.utils.tensorboard import SummaryWriter
import ldl
import recurrent
import webenv

import torch

hparams = {
  'lr': .001,
  'optim': 'Adam', # https://pytorch.org/docs/stable/optim.html

  'synth_grad_lr': .01,
  'obs_loss': 'L1', # Or 'L2'
  'loss_divisor': 1, # A very rough estimate of the input count. Or 1.

  'N_state': 1 * 2**16, # Cost is linearithmic in this.
  'unroll_length': 2, # Every `1/UL`th step will have `2*UL`× more cost.
  'synth_grad': True, # Unless UL is thousands, this gradient-prediction is a good idea.
  'merge_obs': True, # Whether inputs override state in-place (preventing gradient flow), or concatenated (with higher runtime cost).

  'actions': 1, # Cost is linear in this. No planning, only one-time action enumeration.
  'time_horizon': 0., # Without planning, this has to be non-zero, to transfer reward from future to past.

  'gradmax': 1., # Multiplier of planning via gradient.
  'gradmax_only_actions': True, # Where GradMax's gradient goes: only actions, or the whole state.

  'layers': 2,
  'nonlinearity': 'Softsign',
}
relevant_hparams = ['lr', 'gradmax', 'unroll_length'] # To be included in the run's name.



def params(*models):
  ps = set()
  for m in models:
    if hasattr(m, 'parameters'):
      for p in m.parameters():
        ps.add(p) # Prevent repetitions.
  return ps
def param_size(ps):
  sz = 0
  for p in ps:
    sz += 1 if isinstance(p,float) else torch.numel(p)
  return sz



N = hparams['N_state']
N_ins = N if hparams['merge_obs'] else 2*N
dev = 'cuda'
ns = ldl.NormSequential
nl = getattr(torch.nn, hparams['nonlinearity'])
layers = hparams['layers']
synth_grad = ns(N, N, ldl.LinDense, layer_count=layers, Nonlinearity=nl, device=dev) if hparams['synth_grad'] else None
actions = hparams['actions']
transition = ldl.MGU(ns, N_ins, N, ldl.LinDense, layer_count=layers, Nonlinearity=nl, device=dev, example_batch_shape=(1,actions) if actions>1 else (2,), unique_dims=(actions,) if actions>1 else ())
from reinforcement_learning import GradMaximize, Maximize, Return, expand_actions
return_model = Return(ns(N, 1, ldl.LinDense, layer_count=layers, Nonlinearity=nl, device=dev), time_horizon=hparams['time_horizon']) if hparams['time_horizon']>0 else None
if actions > 1:
  transition = Maximize(transition, return_model, action_info=expand_actions, N=actions)
max_model = GradMaximize(ns(N, 1, ldl.LinDense, layer_count=layers, Nonlinearity=nl, device=dev), strength=hparams['gradmax'], pred_gradient=False) if hparams['gradmax']>0 else None
optim = getattr(torch.optim, hparams['optim'])([
  { 'params':[*params(transition, return_model, max_model)] },
  { 'params':[*params(synth_grad)], 'lr':hparams['synth_grad_lr'] },
], lr=hparams['lr'])
hparams['params'] = param_size(params(synth_grad, transition, return_model, max_model))
obs_loss = getattr(recurrent, hparams['obs_loss'])

import os
import datetime
hparams_str = "__".join([k+"_"+str(hparams[k]) for k in relevant_hparams])
run_name = datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "_" + hparams_str
run_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'runs', run_name)
writer = SummaryWriter(log_dir=run_p)
writer.add_hparams(hparams, {}) # Would have been nice if this worked without TF.
i = 0
def loss(pred, got, obs, act_len):
  global i;  i += 1
  if not hparams['merge_obs']: # Un-concat if needed.
    got = got[pred.shape[-1]:].detach()
    pred = pred + recurrent.webenv_merge(torch.zeros_like(pred), obs, 0.)
  L = obs_loss(pred, got) / hparams['loss_divisor']
  writer.add_scalar('Loss', L, i-1)
  if return_model is not None or max_model is not None:
    # Note: autoencoder loss may be more appropriate as reward, because that makes internal state more important than external state, minimizing control of web-pages over the agent.
    divisor = 1000. # A base-10 logarithmic scale might be better.
    Return = torch.minimum(L/divisor-1., .1*(L/divisor-1.))
  if return_model is not None:
    Return, L0 = return_model.reward(got, Return)
    L = L + L0
  if max_model is not None:
    # Do not consider internal state as actions.
    if hparams['gradmax_only_actions']:
      act_only = torch.cat((pred[:-act_len].detach(), pred[-act_len:])) if act_len > 0 else pred.detach()
    else:
      act_only = pred
    L = L + max_model(act_only, Return.detach())
  print(L.cpu().detach().numpy()) # Why not print to console?
  return L
def output(state, obs, act_len): # Add previous frame to next.
  if not hparams['merge_obs']:
    state = state + recurrent.webenv_merge(state, obs, 0.)
  return recurrent.webenv_slice(state, obs, act_len)
agent = recurrent.recurrent(
  (N,), loss=loss, optimizer=optim,
  unroll_length=hparams['unroll_length'], synth_grad=synth_grad,
  input = recurrent.webenv_merge if hparams['merge_obs'] else recurrent.webenv_concat,
  output=output,
  device=dev,
)(transition)



we_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'webenv.js')
webenv.webenv(
  agent,
  'we.defaults',
  '"about:blank"', # Note: ideally, this would be a random website redirector. One that won't mark the agent as a bot, and ban it.
  webenv_path=we_p)

# TODO: Make LDL have the option to swap the order of mixed dimensions (to put locality first). Test that it works for LDL's test.
# TODO: Have the hyperparam `ldl_reverse_ops=False`.
#   ...Wait, does LDL transpose correct dimensions?

# TODO: Test that Void does put noise in the visualization.
# TODO: Test that all maximizers work together.

# TODO: Catch a screenshot. Have examples/README.md, describing this.

# TODO: Update AGENTS.md, removing learned loss, adding misprediction-maximization (curiosity-driven RL; to go from control-by-the-world to free-will, maximize autoencoder loss instead of prediction loss, which puts more emphasis on the more-voluminous thing, which is the internal state) to balance the convergence of prediction on past states, for bootstrapping.
#   ...If this is the only thing left, then does this mean that we won't be continuing here? (Apart from potentially making `directScore` directly-optimizable.)
#   "AGI does include literally everything under its umbrella, so, to not get lost, an extremely keen eye for redundancies is required. Here, we outline a minimal core that can learn everything. See [Examples](../examples/README.md) for implementations."