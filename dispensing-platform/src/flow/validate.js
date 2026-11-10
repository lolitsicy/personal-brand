// Flow definition validation: every guardrail from docs/flow-contract.md.
// Returns { ok, errors[] } with human-readable messages; never throws.

import { BY_TYPE, SOURCES, AUTO_ENTRY_SOURCES, STEP_TYPES } from './catalogue.js';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// [earlier, later, why]
const ORDER_RULES = [
  ['screen', 'clinical_check', 'the pharmacist must see the screening findings at the clinical check'],
  ['clinical_check', 'assemble', 'nothing is assembled before a pharmacist has clinically checked it'],
  ['print_worksheet', 'assemble', 'the worksheet is used during assembly'],
  ['assemble', 'final_check', 'the final check inspects the assembled supply'],
  ['final_check', 'handover', 'nothing is handed over before the final check'],
  ['final_check', 'generate_label', 'delivery labels are produced only for checked supplies'],
  ['final_check', 'book_courier', 'a courier is booked only for checked supplies'],
];

export function validateFlow(definition) {
  const errors = [];
  if (!isObj(definition)) return { ok: false, errors: ['Flow definition must be an object'] };

  // name / description
  if (typeof definition.name !== 'string' || !definition.name.trim()) errors.push('Flow needs a name');
  else if (definition.name.length > 120) errors.push('Flow name must be 120 characters or fewer');
  if (definition.description != null && typeof definition.description !== 'string') errors.push('Description must be text');

  // appliesTo
  const appliesTo = definition.appliesTo;
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) {
    errors.push(`Choose at least one prescription source the flow applies to (${SOURCES.join(', ')})`);
  } else {
    const bad = appliesTo.filter((s) => !SOURCES.includes(s));
    if (bad.length) errors.push(`Unknown source(s) in appliesTo: ${bad.map(String).join(', ')} (allowed: ${SOURCES.join(', ')})`);
    if (new Set(appliesTo).size !== appliesTo.length) errors.push('appliesTo lists a source more than once');
  }

  // steps
  const steps = definition.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push('Flow needs at least one step');
    return { ok: false, errors };
  }

  const ids = new Set();
  const humanSeen = new Set();
  steps.forEach((step, i) => {
    const where = `Step ${i + 1}${isObj(step) && step.id ? ` ("${step.id}")` : ''}`;
    if (!isObj(step)) return errors.push(`${where} must be an object`);
    if (typeof step.id !== 'string' || !KEBAB.test(step.id)) {
      errors.push(`${where}: id must be lower-case kebab-case (e.g. "clinical-check")`);
    } else if (ids.has(step.id)) {
      errors.push(`${where}: duplicate step id "${step.id}" — step ids must be unique`);
    } else ids.add(step.id);

    const meta = BY_TYPE[step.type];
    if (!meta) return errors.push(`${where}: unknown step type "${step.type}" (known: ${STEP_TYPES.join(', ')})`);
    if (step.kind !== undefined && step.kind !== meta.kind) {
      errors.push(`${where}: ${meta.label} is a ${meta.kind} step; its kind cannot be changed to "${step.kind}"`);
    }
    if (step.enabled !== undefined && typeof step.enabled !== 'boolean') errors.push(`${where}: enabled must be true or false`);
    if (meta.kind === 'human') {
      if (humanSeen.has(step.type)) errors.push(`${where}: ${meta.label} appears more than once — each human checkpoint maps to one workflow action`);
      humanSeen.add(step.type);
    }
    if (step.config !== undefined && !isObj(step.config)) return errors.push(`${where}: config must be an object`);
    errors.push(...validateConfig(meta, step.config ?? {}).map((e) => `${where}: ${e}`));
  });

  // Required human checkpoints: present, enabled, human.
  for (const type of STEP_TYPES.filter((t) => BY_TYPE[t].required)) {
    const found = steps.filter((s) => isObj(s) && s.type === type);
    const label = BY_TYPE[type].label;
    if (!found.length) errors.push(`${label} is required in every flow and cannot be removed`);
    else if (found.some((s) => s.enabled === false)) errors.push(`${label} is required in every flow and cannot be disabled`);
  }

  // Ordering (by position, whether or not a step is enabled).
  const positions = (type) => steps.map((s, i) => (isObj(s) && s.type === type ? i : -1)).filter((i) => i >= 0);
  for (const [a, b, why] of ORDER_RULES) {
    const pa = positions(a);
    const pb = positions(b);
    if (!pa.length || !pb.length) continue;
    if (Math.max(...pa) > Math.min(...pb)) {
      errors.push(`${BY_TYPE[a].label} must come before ${BY_TYPE[b].label}: ${why}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateConfig(meta, config) {
  const errs = [];
  for (const f of meta.configSchema) {
    const v = config[f.key];
    if (v === undefined || v === null) continue; // unset -> catalogue default
    switch (f.type) {
      case 'boolean':
        if (typeof v !== 'boolean') errs.push(`"${f.label}" must be true or false`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`"${f.label}" must be a number`);
        else if ((f.min != null && v < f.min) || (f.max != null && v > f.max)) errs.push(`"${f.label}" must be between ${f.min} and ${f.max}`);
        break;
      case 'string':
        if (typeof v !== 'string' || !v.trim()) errs.push(`"${f.label}" must be text`);
        else if (f.options && !f.options.includes(v)) errs.push(`"${f.label}" must be one of ${f.options.join(', ')}`);
        break;
      case 'sources':
        if (!Array.isArray(v)) { errs.push(`"${f.label}" must be a list of sources`); break; }
        for (const s of v) {
          if (!SOURCES.includes(s)) errs.push(`"${f.label}": unknown source "${s}"`);
        }
        break;
    }
  }
  if (meta.type === 'data_entry' && Array.isArray(config.autoFor)) {
    const unsafe = config.autoFor.filter((s) => SOURCES.includes(s) && !AUTO_ENTRY_SOURCES.includes(s));
    if (unsafe.length) {
      errs.push(
        `data entry can only be auto-confirmed for structured e-scripts (${AUTO_ENTRY_SOURCES.join(', ')}); ` +
        `${unsafe.join(', ')} scripts are keyed or transcribed by staff, so a person must confirm the entry`,
      );
    }
  }
  return errs;
}
