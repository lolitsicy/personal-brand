// The two flows every pharmacy starts with. seedDefaults() installs each as
// version 1 (active) of its key if that key has never been created.

const step = (type, config = {}, enabled = true) => ({ id: type.replace(/_/g, '-'), type, enabled, config });

function standardSteps({ autoFor }) {
  return [
    step('receive'),
    step('match_patient'),
    step('verify_original'),
    step('map_formulary'),
    step('data_entry', { autoFor }),
    step('check_stock', { reserve: false, allowOwing: true }),
    step('check_history', { lookbackDays: 90, maxSupplyDays: 90 }),
    step('screen', { useAi: true }),
    step('clinical_check'),
    step('print_worksheet'),
    step('assemble'),
    step('final_check'),
    step('generate_label'),
    step('book_courier', { provider: 'default' }),
    step('handover'),
    step('notify_patient', { channel: 'sms' }),
    step('submit_claim'),
  ];
}

export const DEFAULT_FLOWS = [
  {
    key: 'e-script-standard',
    definition: {
      name: 'E-script standard',
      description: 'Structured NZePS e-scripts. Data entry is auto-confirmed (by the Automation technician); a pharmacist still does the clinical and final checks.',
      appliesTo: ['nzeps'],
      steps: standardSteps({ autoFor: ['nzeps'] }),
    },
  },
  {
    key: 'written-script',
    definition: {
      name: 'Written script',
      description: 'Paper, signature-exempt, faxed and phoned scripts. A person keys and confirms data entry against the original.',
      appliesTo: ['paper', 'signature_exempt', 'fax', 'phone'],
      steps: standardSteps({ autoFor: [] }),
    },
  },
];

export function defaultFlows() {
  return structuredClone(DEFAULT_FLOWS);
}
