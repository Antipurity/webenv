from torch.utils.tensorboard import SummaryWriter
import ldl
import webenv
import recurrent
import reinforcement_learning as RL

import os
import torch
import datetime
import numpy as np

# Lots of hyperparams, so code is overly complex; pretend that non-picked `if` branches do not exist, at first.

hparams = {
  # The environment.
  'batch_size': 1,
  'remote_size': 1,
  'homepage': 'about:blank',
  # Ideally, the homepage would be a redirector to random websites.
  #   (Install & use the RandomURL dataset if you can. No pre-existing website is good enough.)

  # Model capacity.
  'N_state': 8 * 2**12, # Cost is linearithmic in this.
  'unroll_length': 1, # Every `1/UL`th step will have `2*UL`× more cost.
  'synth_grad': True, # Unless UL is thousands, this gradient-prediction is a good idea.
  'merge_obs': 'concat', # 'ignore', 'add', 'merge' (Teacher Forcing in ML), 'concat'.
  #   'ignore' is a terrible idea, 'add' makes predictions' magnitude too big, 'merge' cuts off gradient, 'concat' is expensive.

  # Model.
  'layers': 1, # Makes computations-over-time more important than reactions, and increases FPS.
  'nonlinearity': 'Softsign', # (With layers=1, this is only used in synthetic gradient.)
  'ldl_local_first': False,
  'out_mult': 1.2, # 1.2 makes predicting pure black/white in MGU easier.
  'trace': True, # Gives a couple extra FPS at the cost of very slow startup.

  # Optimization.
  'lr': .001,
  'optim': 'Adam', # https://pytorch.org/docs/stable/optim.html
  'synth_grad_lr': .03,
  'obs_loss': 'L2', # 'L1', 'L2'
  'observation_importance': .1, # Relative to 'maximize'd numbers.

  # Reinforcement learning.
  'maximize': True,
  'error_reward': 1., # Misprediction is reward, with this multiplier.

  # Regularization, and soft sparsification. (Potentially unnecessary.)
  'dropout': .0, # Causes "output differs" warnings when 'trace' is True.
  'weight_decay': .0001,

  # Save/load.
  'save_every_N_steps': 1000,
  'preserve_history': False,

  # Visualization of metrics.
  'console': True,
  'tensorboard': True,
}
relevant_hparams = ['lr', 'unroll_length'] # To be included in the run's name.
save_path = 'models'



def params(*models):
  return set(p for m in models if hasattr(m, 'parameters') for p in m.parameters())
def param_size(ps):
  return sum(1 if isinstance(p,float) else torch.numel(p) for p in ps)



# Create parts of the model.
N = hparams['N_state']
N_ins = N if hparams['merge_obs'] != 'concat' else 2*N
dev = 'cuda'
ns = ldl.NormSequential
chosen_nl = getattr(torch.nn, hparams['nonlinearity'])
nl = (lambda: torch.nn.Sequential(
  torch.nn.Dropout(hparams['dropout']),
  chosen_nl(),
)) if hparams['dropout']>0 else chosen_nl
lf = hparams['ldl_local_first']
layers = hparams['layers']
merge_obs = getattr(recurrent, 'webenv_' + hparams['merge_obs'])

transition = ldl.MGU(ns, N_ins, N, ldl.LinDense, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev, example_batch_shape=(2,), unique_dims=(), out_mult = hparams['out_mult'])
if hparams['maximize']: transition = RL.Split(transition, N)
full_transition = transition # For calling .second(…) on.

if hparams['synth_grad']:
  synth_grad = ns(N, N, ldl.LinDense, layer_count = layers + 1, Nonlinearity=nl, local_first=lf, device=dev)
else:
  synth_grad = None
optim = getattr(torch.optim, hparams['optim'])([
  { 'params':[*params(transition)] },
  { 'params':[*params(synth_grad)], 'lr':hparams['synth_grad_lr'] },
], lr=hparams['lr'])
all_params = params(synth_grad, transition)
hparams['params'] = param_size(all_params)
obs_loss = {
  'L1': lambda pred,got: (pred - got).abs().sum(-1),
  'L2': lambda pred,got: .5*(pred - got).square().sum(-1),
}[hparams['obs_loss']]

if hparams['trace']:
  transition = torch.jit.trace(transition, torch.randn(2, N_ins, device=dev))
  if synth_grad:
    synth_grad = torch.jit.trace(synth_grad, torch.randn(2, N, device=dev))



# Handle saving/loading.
hparams_str = "__".join([k+"_"+str(hparams[k]) for k in relevant_hparams])
state = {
  'step': 0,
  'run_name': datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S") + "_" + hparams_str,
  'hparams': hparams,
  'transition': transition.state_dict(),
  'synth_grad': synth_grad.state_dict() if synth_grad else None,
  'optim': optim.state_dict(),
}
def force_state_dict(old, saved):
  if not isinstance(old, dict): return
  with torch.no_grad():
    for name, to in old.items():
      if name not in saved: continue
      if not torch.is_tensor(to): continue
      fr = saved[name]
      if to.shape == fr.shape:
        to.copy_(fr)
      else:
        to[[slice(0, i) for i in fr.shape]] = fr[[slice(0, i) for i in to.shape]]
save_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), save_path)
try:
  state2 = torch.load(os.path.join(save_p, 'current.pth'))
  if state['hparams'] != state2['hparams']:
    print(dict(set(state['hparams'].items()) ^ set(state2['hparams'].items())))
    print('Hyperparams changed.')
  continuing = input('Load (else re-initialize)? [Y/n] ')
  continuing = 'y' in continuing or 'Y' in continuing or continuing == ''
  if continuing:
    state['step'] = state2['step']
    state['run_name'] = state2['run_name']
    for k in state:
      if k != 'hparams' and k in state2:
        force_state_dict(state[k], state2[k])
except FileNotFoundError:
  pass



# Put together the loss & agent.
if hparams['tensorboard']:
  run_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'runs', state['run_name'])
  writer = SummaryWriter(log_dir=run_p)
  writer.add_hparams(hparams, {}) # Would have been nice if this worked without TF.

reward_slice = (..., slice(0,2)) if hparams['error_reward']>0. else (..., slice(0,1))
def loss(pred, got, obs, act_len):
  # Predict.
  state['step'] += 1
  pred2 = torch.cat((pred[..., :2].detach(), pred[..., 2:]), -1)
  error = obs_loss(pred2, got)
  L = error.sum() * hparams['observation_importance']
  # Misprediction & reward.
  #   (Random noise causes high input misprediction, so, would have been better to do something like autoencoder misprediction.)
  #     (That's more expensive, though.)
  err2 = error*11/obs.shape[-1] - 1. # A base-10 logarithmic scale might be better.
  err2 = torch.minimum(err2, .1*err2) # 1 at max error (obs.shape[-1], more or less).
  reward_loss = ((pred[..., 0] - got[..., 0]).square() + (pred[..., 1] - err2).square()).sum()
  L = L + reward_loss # Predict reward & misprediction.
  # Maximize next-next-reward by actions, because next-reward is a bit harder to keep track of here.
  if hparams['maximize']:
    next2 = full_transition.second(merge_obs(pred, got), out_slice=reward_slice)
    pure_reward = next2[..., 0]
    reward = (pure_reward + (next2[..., 1]*hparams['error_reward'] if next2.shape[-1] > 1 else 0)).sum()
    L = L - reward
  else: reward = None
  # IO stuff:
  with torch.no_grad():
    x = error.sum() / error.shape[0]
    if hparams['console']:
      print(str(obs.shape[0])+'×', '\terror:', np.around(x.cpu().numpy(), 1), '\treward: ' + str(np.around(reward.cpu().numpy(), 2)) if reward is not None else '')
    if hparams['tensorboard']:
      writer.add_scalar('Loss', x, state['step'])
      if reward is not None:
        writer.add_scalar('Total reward', reward, state['step'])
        writer.add_scalar('Pure reward', pure_reward, state['step'])
        writer.add_scalar('Total-reward loss', reward_loss, state['step'])
  if hparams['save_every_N_steps'] and state['step'] % hparams['save_every_N_steps'] == 0:
    # Save, though it's sync here: inefficient.
    os.makedirs(save_p, exist_ok=True)
    torch.save(state, os.path.join(save_p, 'current.pth'))
    torch.save(state, os.path.join(save_p, 'backup.pth'))
    if hparams['preserve_history']:
      import datetime
      now = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
      torch.save(state, os.path.join(save_p, now + '.pth'))
    print('Saved.')
  return L
def weight_decay(optimizer):
  optimizer.step()
  optimizer.zero_grad(set_to_none=True)
  if hparams['weight_decay'] > 0.:
    with torch.no_grad():
      for p in all_params:
        if len(p.shape):
          p[:] *= 1 - hparams['weight_decay']

agent = recurrent.recurrent(
  (hparams['batch_size'] + hparams['remote_size'], N), loss=loss, optimizer=optim,
  unroll_length=hparams['unroll_length'], synth_grad=synth_grad,
  input = merge_obs,
  update = weight_decay,
  device=dev,
)(transition)



we_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', '..', 'webenv.js')
webenv.webenv(
  agent,
  'we.defaults',
  [
    'we.settings',
    '{ homepage:"' + hparams['homepage'] + '" }',
  ],
  *[['we.browser'] for i in range(hparams['batch_size'])],
  ['we.remote', '"/connect"', hparams['remote_size']],
  webenv_path=we_p)