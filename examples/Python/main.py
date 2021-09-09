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
  'obs_loss': 'L2', # 'L1', 'L2'
  'loss_divisor': 1, # A very rough estimate of the input count. Or 1.

  'N_state': 1 * 2**16, # Cost is linearithmic in this.
  'unroll_length': 2, # Every `1/UL`th step will have `2*UL`× more cost.
  'synth_grad': True, # Unless UL is thousands, this gradient-prediction is a good idea.
  'merge_obs': 'concat', # 'add', 'merge', 'concat'.
  #   'add' makes predictions too big, 'merge' cuts off gradient, 'concat' is expensive.

  'time_horizon': .0, # Without planning, this has to be non-zero, to transfer reward from future to past.

  'gradmax': 0., # Multiplier of planning via gradient.
  'gradmax_only_actions': True, # Where GradMax's gradient goes: only actions, or the whole state.
  'gradmax_pred_gradient': False, # Whether GradMax's gradient to state includes reward misprediction.

  'layers': 2,
  'nonlinearity': 'Softsign',
  'ldl_local_first': True,

  'console': True,
  'tensorboard': True,
}
relevant_hparams = ['lr', 'gradmax', 'unroll_length'] # To be included in the run's name.

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
def full_at_the_end(ins, outs, *args, **kwargs):
  if outs == 1:
    return torch.nn.Linear(ins, outs, device = kwargs['device'])
  return ldl.LinDense(ins, outs, *args, **kwargs)
synth_grad = ns(N, N, full_at_the_end, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev) if hparams['synth_grad'] else None
transition = ldl.MGU(ns, N_ins, N, full_at_the_end, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev, example_batch_shape=(2,), unique_dims=())
from reinforcement_learning import GradMaximize, Return
return_model = Return(ns(N, 1, full_at_the_end, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev), time_horizon=hparams['time_horizon']) if hparams['time_horizon']>0 else None
max_model = GradMaximize(ns(N, 1, full_at_the_end, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev), strength=hparams['gradmax'], pred_gradient=hparams['gradmax_pred_gradient']) if hparams['gradmax']>0 else None
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
    got = got[pred.shape[-1]:].detach()
    if add_input_on_concat:
      pred = pred + recurrent.webenv_merge(torch.zeros_like(pred), obs, 0.)
  L = obs_loss(pred, got) / hparams['loss_divisor']
  if hparams['console']:
    print(L.cpu().detach().numpy())
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
      act_only = torch.cat((pred[:-act_len].detach(), pred[-act_len:])) if act_len > 0 else pred.detach()
    else:
      act_only = pred
    L = L + max_model(act_only, Return.detach())
  return L
def output(state, obs, act_len): # Add previous frame to next, if needed.
  if hparams['merge_obs'] == 'concat' and add_input_on_concat:
    state = state + recurrent.webenv_merge(state, obs, 0.)
  return recurrent.webenv_slice(state, obs, act_len)
agent = recurrent.recurrent(
  (N,), loss=loss, optimizer=optim,
  unroll_length=hparams['unroll_length'], synth_grad=synth_grad,
  input = getattr(recurrent, 'webenv_' + hparams['merge_obs']),
  output=output,
  device=dev,
)(transition)



we_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'webenv.js')
webenv.webenv(
  agent,
  'we.defaults',
  '"https://www.google.com/"',
  # Note: ideally, the homepage would be a random website redirector.
  #   One that won't mark the agent as a bot, and then it.
  #   (The defaults include a possibility of such a redirector.)
  webenv_path=we_p)

# TODO: Re-run this gradmax=0 run, because browser-launching was failing so hard. (Not that it's much better now, actually. Still, statistical confidence, I guess?)
# TODO: Catch another screenshot (...then again, maybe we had enough). In examples/README.md, describe this.