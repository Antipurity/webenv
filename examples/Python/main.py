# 10+ debugging days.

from torch.utils.tensorboard import SummaryWriter
import ldl
import recurrent
import webenv

import torch

# Lots of hyperparams, so code is overly complex; pretend that non-picked `if` branches do not exist, at first.

hparams = {
  'batch_size': 1,

  'lr': .001,
  'optim': 'Adam', # https://pytorch.org/docs/stable/optim.html

  'synth_grad_lr': .03,
  'obs_loss': 'L2', # 'L1', 'L2'
  'loss_divisor': 1, # A very rough estimate of the input count. Or 1.

  'N_state': 8 * 2**12, # Cost is linearithmic in this.
  'unroll_length': 1, # Every `1/UL`th step will have `2*UL`× more cost.
  'synth_grad': True, # Unless UL is thousands, this gradient-prediction is a good idea.
  'merge_obs': 'concat', # 'add', 'merge' (Teacher Forcing in ML), 'concat'.
  #   'add' makes predictions' magnitude too big, 'merge' cuts off gradient, 'concat' is expensive.

  'time_horizon': .0, # Without planning, this has to be non-zero, to transfer reward from future to past.

  'gradmax': 0., # Multiplier of planning via gradient.
  'gradmax_only_actions': False, # Where GradMax's gradient goes: only actions, or the whole state.
  'gradmax_pred_gradient': False, # Whether GradMax's gradient to state includes reward misprediction.
  'gradmax_momentum': .99,

  'layers': 1, # Makes computations-over-time more important than reactions, and increases FPS.
  'nonlinearity': 'Softsign', # (With layers=1, this is only used in synthetic gradient.)
  'ldl_local_first': True,
  'out_mult': 1.1, # 1.1 makes predicting pure black/white in MGU easier.

  'console': True,
  'tensorboard': False, # TODO: True
}
relevant_hparams = ['lr', 'gradmax', 'unroll_length', 'nonlinearity'] # To be included in the run's name.

add_input_on_concat = False # Output can be boring if input is added to prediction.



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
N_ins = N if hparams['merge_obs'] != 'concat' else 2*N
dev = 'cuda'
ns = ldl.NormSequential
nl = getattr(torch.nn, hparams['nonlinearity'])
lf = hparams['ldl_local_first']
layers = hparams['layers']

transition = ldl.MGU(ns, N_ins, N, ldl.LinDense, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev, example_batch_shape=(2,), unique_dims=(), out_mult = hparams['out_mult'])

if hparams['synth_grad']:
  synth_grad = ns(N, N, ldl.LinDense, layer_count = layers + 1, Nonlinearity=nl, local_first=lf, device=dev)
else:
  synth_grad = None
from reinforcement_learning import GradMaximize, Return
if hparams['time_horizon']>0:
  return_model = Return(ns(N, 1, ldl.LinDense, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev), time_horizon=hparams['time_horizon'])
else:
  return_model = None
if hparams['gradmax']>0:
  max_model = GradMaximize(
    ns(N, 1, ldl.LinDense, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev),
    strength=hparams['gradmax'],
    pred_gradient=hparams['gradmax_pred_gradient'],
    momentum=hparams['gradmax_momentum'])
else:
  max_model = None
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
if hparams['tensorboard']:
  writer = SummaryWriter(log_dir=run_p)
  writer.add_hparams(hparams, {}) # Would have been nice if this worked without TF.
i = 0
def loss(pred, got, obs, act_len):
  global i;  i += 1
  if hparams['merge_obs'] == 'concat': # Un-concat if needed.
    got = got[..., pred.shape[-1]:].detach()
    if add_input_on_concat:
      pred = pred + recurrent.webenv_merge(torch.zeros_like(pred), obs, 0.)
  L = obs_loss(pred, got) / hparams['loss_divisor']
  if hparams['console']:
    print(str(obs.shape[0])+'×', (L / pred.shape[0]).cpu().detach().numpy())
  if hparams['tensorboard']:
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
      # (Lazy: if streams are wildly different in action length, then gradients are inconsistent.)
      acts = max(act_len) if isinstance(act_len, list) else act_len
      act_only = torch.cat((pred[..., :-acts].detach(), pred[..., -acts:])) if acts > 0 else pred.detach()
    else:
      act_only = pred
    L = L + max_model(act_only, Return.detach())
  return L
def output(lock, state, indices, obs, act_len): # Add previous frame to next, if needed.
  if hparams['merge_obs'] == 'concat' and add_input_on_concat:
    state = state + recurrent.webenv_merge(state, obs, 0.)
  return recurrent.webenv_slice(lock, state, indices, obs, act_len)
agent = recurrent.recurrent(
  (hparams['batch_size'], N), loss=loss, optimizer=optim,
  unroll_length=hparams['unroll_length'], synth_grad=synth_grad,
  input = getattr(recurrent, 'webenv_' + hparams['merge_obs']),
  output=output,
  device=dev,
)(transition)



we_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'webenv.js')
webenv.webenv(
  agent,
  'we.defaults',
  [
    'we.settings',
    '{ homepage:"about:blank" }', # TODO: https://www.google.com/
    # Note: ideally, the homepage would be a redirector to random websites.
    #   (Install & use the RandomURL dataset if you can. No pre-existing website is good enough.)
  ],
  *[['we.browser'] for i in range(hparams['batch_size'])],
  webenv_path=we_p)