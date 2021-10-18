from torch.utils.tensorboard import SummaryWriter
import ldl
import recurrent
import webenv

import os
import torch
import datetime

# Lots of hyperparams, so code is overly complex; pretend that non-picked `if` branches do not exist, at first.

hparams = {
  # The environment.
  'batch_size': 1,
  'remote_size': 1,
  'homepage': 'about:blank',

  # Optimization.
  'lr': .001,
  'optim': 'Adam', # https://pytorch.org/docs/stable/optim.html
  'synth_grad_lr': .03,
  'obs_loss': 'L2', # 'L1', 'L2'
  'loss_divisor': 1, # A very rough estimate of the input count. Or 1.

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
  'out_mult': 1.1, # 1.1 makes predicting pure black/white in MGU easier.
  'trace': True,

  # Reinforcement learning.
  'gradmax': 1., # Multiplier of planning via gradient.
  'gradmax_only_actions': True, # Where GradMax's gradient goes: only actions, or the whole state.
  'gradmax_pred_gradient': False, # Whether GradMax's gradient to state includes reward misprediction.
  'gradmax_momentum': .99,

  # Soft sparsification.
  'dropout': .2, # Causes "output differs" warnings when 'trace' is True.
  'weight_decay': .0001,
  'weight_decay_perc': .8,

  # Save/load.
  'save_every_N_steps': 1000,
  'preserve_history': False,

  # Visualization of metrics.
  'console': True,
  'tensorboard': False, # TODO: True
}
relevant_hparams = ['lr', 'gradmax', 'unroll_length', 'nonlinearity'] # To be included in the run's name.
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
nl = lambda: torch.nn.Sequential(
  torch.nn.Dropout(hparams['dropout']),
  getattr(torch.nn, hparams['nonlinearity'])(),
)
lf = hparams['ldl_local_first']
layers = hparams['layers']

transition = ldl.MGU(ns, N_ins, N, ldl.LinDense, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev, example_batch_shape=(2,), unique_dims=(), out_mult = hparams['out_mult'])

if hparams['synth_grad']:
  synth_grad = ns(N, N, ldl.LinDense, layer_count = layers + 1, Nonlinearity=nl, local_first=lf, device=dev)
else:
  synth_grad = None
import reinforcement_learning as RL
if hparams['gradmax']>0:
  # TODO: Don't have `max_model`, instead use `RL.split(fn, outs)` in `transition` instead (and to maximize reward, `transition.second(pred, out_slice=…)` — …except, isn't input of different size here…) (and to add misprediction bonuses, make some observation's number predict them, preferably the second one, and add those two together into the maximized reward).
  max_model = RL.GradMaximize(
    ns(N, 1, ldl.LinDense, layer_count=layers, Nonlinearity=nl, local_first=lf, device=dev),
    strength=hparams['gradmax'],
    pred_gradient=hparams['gradmax_pred_gradient'],
    momentum=hparams['gradmax_momentum'])
else:
  max_model = None
optim = getattr(torch.optim, hparams['optim'])([
  { 'params':[*params(transition, max_model)] },
  { 'params':[*params(synth_grad)], 'lr':hparams['synth_grad_lr'] },
], lr=hparams['lr'])
all_params = params(synth_grad, transition, max_model)
hparams['params'] = param_size(all_params)
obs_loss = getattr(recurrent, hparams['obs_loss'])

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
  'max_model': max_model.state_dict() if max_model else None,
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
        fr_shape = [slice(0, i) for i in fr.shape]
        to_shape = [slice(0, i) for i in to.shape]
        to[fr_shape] = fr[to_shape]
run_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'runs', state['run_name'])
save_p = os.path.join(os.path.dirname(os.path.realpath(__file__)), save_path)
try:
  state2 = torch.load(os.path.join(save_p, 'current.pth'))
  if state['hparams'] != state2['hparams']:
    print(dict(set(state['hparams'].items()) ^ set(state2['hparams'].items())))
    print('Hyperparams changed.')
  continuing = input('Load (else re-initialize)? [Y/n] ')
  continuing = 'y' in continuing or 'Y' in continuing
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
  writer = SummaryWriter(log_dir=run_p)
  writer.add_hparams(hparams, {}) # Would have been nice if this worked without TF.

def loss(pred, got, obs, act_len):
  state['step'] += 1
  L = obs_loss(pred, got) / hparams['loss_divisor']
  if hparams['console']:
    print(str(obs.shape[0])+'×', (L / pred.shape[0]).cpu().detach().numpy())
  if hparams['tensorboard']:
    writer.add_scalar('Loss', L, state['step']-1)
  if max_model is not None:
    # Note: autoencoder loss may be more appropriate as reward than prediction loss `L`, because that makes internal state more important than external state, minimizing control of web-pages over the agent.
    divisor = 1000. # A base-10 logarithmic scale might be better.
    Return = torch.minimum(L/divisor-1., .1*(L/divisor-1.))
    if hparams['gradmax_only_actions']:
      # Do not consider internal state as actions.
      # (Lazy: if streams are wildly different in action length, then gradients are inconsistent.)
      acts = max(act_len) if isinstance(act_len, list) else act_len
      act_only = torch.cat((pred[..., :-acts].detach(), pred[..., -acts:]), -1) if acts > 0 else pred.detach()
    else:
      act_only = pred
    L = L + max_model(act_only, Return.detach())
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
          threshold = p.max() * hparams['weight_decay_perc']
          p[:] *= torch.where(p.abs() > threshold, 1., 1 - hparams['weight_decay'])

agent = recurrent.recurrent(
  (hparams['batch_size'] + hparams['remote_size'], N), loss=loss, optimizer=optim,
  unroll_length=hparams['unroll_length'], synth_grad=synth_grad,
  input = getattr(recurrent, 'webenv_' + hparams['merge_obs']),
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
    # Note: ideally, the homepage would be a redirector to random websites.
    #   (Install & use the RandomURL dataset if you can. No pre-existing website is good enough.)
  ],
  *[['we.browser'] for i in range(hparams['batch_size'])],
  ['we.remote', '"/connect"', hparams['remote_size']],
  webenv_path=we_p)