// Dispensing workflow state machine for a single dispense job
// (one supply of one prescription item: the original or a repeat).
//
//   queued ──enter──▶ entered ──clinical_check──▶ clinically_checked
//      ──assemble──▶ assembled ──final_check──▶ checked ──release──▶ released
//      ──(fulfilment completes)──▶ completed
//
//   hold / resume: any pre-release state <-> on_hold
//   cancel:        any pre-release state (or on_hold) -> cancelled
//
// Each action lists which roles may perform it. Side effects (stock, CD
// register, labels, claims, broker status) live in the dispensing service.

import { label } from './labels.js';

export const STATES = [
  'queued',
  'entered',
  'clinically_checked',
  'assembled',
  'checked',
  'released',
  'completed',
  'on_hold',
  'cancelled',
];

export const ACTIVE_STATES = ['queued', 'entered', 'clinically_checked', 'assembled', 'checked'];

export const ACTIONS = {
  enter: { from: ['queued'], to: 'entered', roles: ['technician', 'pharmacist'] },
  clinical_check: { from: ['entered'], to: 'clinically_checked', roles: ['pharmacist'] },
  assemble: { from: ['clinically_checked'], to: 'assembled', roles: ['technician', 'pharmacist'] },
  final_check: { from: ['assembled'], to: 'checked', roles: ['pharmacist'] },
  release: { from: ['checked'], to: 'released', roles: ['technician', 'pharmacist'] },
  complete: { from: ['released'], to: 'completed', roles: ['technician', 'pharmacist', 'courier'] },
  hold: { from: ACTIVE_STATES, to: 'on_hold', roles: ['technician', 'pharmacist'] },
  resume: { from: ['on_hold'], to: null /* back to held_from */, roles: ['technician', 'pharmacist'] },
  cancel: { from: [...ACTIVE_STATES, 'on_hold'], to: 'cancelled', roles: ['pharmacist'] },
};

/** Throws a descriptive error if the transition isn't allowed. Returns the target state. */
export function planTransition(job, action, user) {
  const def = ACTIONS[action];
  if (!def) throw Object.assign(new Error(`Unknown action "${action}"`), { status: 400 });
  if (!user) throw Object.assign(new Error('A signed-in user is required'), { status: 401 });
  if (!def.roles.includes(user.role) && user.role !== 'admin') {
    throw Object.assign(
      new Error(`A ${label('role', user.role).toLowerCase()} can't ${label('actionVerb', action)}. This step needs a ${def.roles.map((r) => label('role', r).toLowerCase()).join(' or ')}.`),
      { status: 403 },
    );
  }
  if (!def.from.includes(job.state)) {
    throw Object.assign(
      new Error(`Can't ${label('actionVerb', action)} now: this script is at "${label('state', job.state)}".`),
      { status: 409 },
    );
  }
  return def.to ?? job.held_from;
}

export function availableActions(job, user) {
  return Object.entries(ACTIONS)
    .filter(([, d]) => d.from.includes(job.state) && (!user || d.roles.includes(user.role) || user.role === 'admin'))
    .map(([name]) => name)
    .filter((name) => name !== 'complete'); // completion is driven by fulfilment
}
