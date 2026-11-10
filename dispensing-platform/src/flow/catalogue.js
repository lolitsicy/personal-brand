// Step catalogue for pharmacy flows (pipelines).
//
// Every step is either:
//   auto  — run by the flow engine (as the Automation user where an acting user is needed)
//   human — maps 1:1 to a workflow action in src/domain/workflow.js. The engine never
//           performs a human step itself, with one exception: data_entry may be
//           auto-confirmed for structured e-scripts (config.autoFor). The Automation
//           user is a technician, so it can never do a clinical or final check.

export const SOURCES = ['nzeps', 'paper', 'signature_exempt', 'fax', 'phone'];

/**
 * Sources whose data entry may be auto-confirmed. Only structured electronic scripts
 * qualify: paper, signature-exempt and fax scripts are keyed from an image and phone
 * orders are transcribed by staff, so a person must confirm what was keyed.
 */
export const AUTO_ENTRY_SOURCES = ['nzeps'];

/** Human step type -> workflow action (transition name). */
export const HUMAN_ACTIONS = {
  data_entry: 'enter',
  clinical_check: 'clinical_check',
  assemble: 'assemble',
  final_check: 'final_check',
  handover: 'release',
};

const STEPS = [
  {
    type: 'receive', kind: 'auto', label: 'Receive',
    description: 'Record the script as received (source, SCID, payload hash) and check the stored copy is intact.',
    configSchema: [],
  },
  {
    type: 'match_patient', kind: 'auto', label: 'Match patient',
    description: 'Confirm the script is linked to a patient record with an NHI. A missing NHI is recorded as a warning; the flow continues.',
    configSchema: [],
  },
  {
    type: 'verify_original', kind: 'auto', label: 'Verify original',
    description: 'Integrity-check the stored original (payload hash and any scanned documents) and list differences between what was received and what is being dispensed.',
    configSchema: [],
  },
  {
    type: 'map_formulary', kind: 'auto', label: 'Map to formulary',
    description: 'Look the medicine up in the formulary module (NZF link and source). Skipped if no formulary module is installed.',
    configSchema: [],
  },
  {
    type: 'data_entry', kind: 'human', label: 'Data entry',
    description: 'A technician or pharmacist enters the script. Can be auto-confirmed for structured e-scripts only.',
    configSchema: [
      { key: 'autoFor', label: 'Auto-confirm for sources', type: 'sources', default: [], allowed: AUTO_ENTRY_SOURCES },
    ],
  },
  {
    type: 'check_stock', kind: 'auto', label: 'Check stock',
    description: 'Compare stock on hand with the quantity needed. Does not move stock (assembly does that).',
    configSchema: [
      { key: 'reserve', label: 'Count this job against stock for other jobs (soft reservation)', type: 'boolean', default: false },
      { key: 'allowOwing', label: 'Allow an owing if short', type: 'boolean', default: true },
    ],
  },
  {
    type: 'check_history', kind: 'auto', label: 'Check history',
    description: 'Prior supplies of the same ingredient for this patient, open duplicates, and a supply-duration check.',
    configSchema: [
      { key: 'lookbackDays', label: 'Look back (days)', type: 'number', default: 90, min: 1, max: 3650 },
      { key: 'maxSupplyDays', label: 'Flag supplies longer than (days)', type: 'number', default: 90, min: 1, max: 3650 },
    ],
  },
  {
    type: 'screen', kind: 'auto', label: 'Clinical screening',
    description: 'Run deterministic rules, formulary checks and (optionally) the de-identified AI reviewer. Findings await pharmacist sign-off.',
    configSchema: [
      { key: 'useAi', label: 'Use AI reviewer', type: 'boolean', default: true },
    ],
  },
  {
    type: 'clinical_check', kind: 'human', label: 'Clinical check',
    description: 'Pharmacist reviews findings against the original and signs off. Always required.',
    configSchema: [],
  },
  {
    type: 'print_worksheet', kind: 'auto', label: 'Print worksheet',
    description: 'Produce the assembly worksheet (print module). Skipped if no print module is installed.',
    configSchema: [],
  },
  {
    type: 'assemble', kind: 'human', label: 'Assemble',
    description: 'Pick, count and label. Stock moves here.',
    configSchema: [],
  },
  {
    type: 'final_check', kind: 'human', label: 'Final check',
    description: 'Pharmacist checks the assembled supply. Always required; must be a different person from the assembler.',
    configSchema: [],
  },
  {
    type: 'generate_label', kind: 'auto', label: 'Delivery label',
    description: 'Generate the delivery/courier address label once handed over for delivery or courier. Skipped for pickup.',
    configSchema: [],
  },
  {
    type: 'book_courier', kind: 'auto', label: 'Book courier',
    description: 'Book the courier once every item in the order has been released. Only for courier fulfilment; skipped otherwise.',
    configSchema: [
      { key: 'provider', label: 'Courier provider', type: 'string', default: 'default' },
    ],
  },
  {
    type: 'handover', kind: 'human', label: 'Handover',
    description: 'Release the supply to a fulfilment (pickup, delivery, courier or compliance pack).',
    configSchema: [],
  },
  {
    type: 'notify_patient', kind: 'auto', label: 'Notify patient',
    description: 'Tell the patient their medicine is ready or on its way (mock message; no medicine names are sent).',
    configSchema: [
      { key: 'channel', label: 'Channel', type: 'string', default: 'sms', options: ['sms', 'email'] },
    ],
  },
  {
    type: 'submit_claim', kind: 'auto', label: 'Claim',
    description: 'Confirm a subsidy claim exists for the supply (claims are created at release and submitted in batches).',
    configSchema: [],
  },
];

for (const s of STEPS) s.required = ['clinical_check', 'final_check'].includes(s.type);

export const STEP_TYPES = STEPS.map((s) => s.type);
export const BY_TYPE = Object.freeze(Object.fromEntries(STEPS.map((s) => [s.type, Object.freeze(s)])));

/** Catalogue as served by GET /api/flows/catalogue (a fresh copy each call). */
export function catalogue() {
  return structuredClone(STEPS);
}

/** Step config with catalogue defaults filled in. */
export function configWithDefaults(type, config = {}) {
  const out = {};
  for (const f of BY_TYPE[type]?.configSchema ?? []) out[f.key] = structuredClone(f.default);
  for (const [k, v] of Object.entries(config ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}
