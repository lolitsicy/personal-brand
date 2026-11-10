// Human-facing labels for every internal value that can reach a person.
// Shared by the server (error messages, printouts) and the browser (served
// at /labels.js), so a status reads the same everywhere.
//
// Rule: internal codes (snake_case states, source ids, action names) never
// appear in the UI or in messages. Add a label here whenever a new value is
// introduced; `label()` falls back to a readable sentence-case version.

export const LABELS = {
  state: {
    queued: 'Received', entered: 'Data entry done', clinically_checked: 'Clinically checked',
    assembled: 'Assembled', checked: 'Final checked', released: 'Released', completed: 'Completed',
    on_hold: 'On hold', cancelled: 'Cancelled',
  },
  source: {
    nzeps: 'NZePS e-script', paper: 'Paper script', signature_exempt: 'Signature-exempt script',
    fax: 'Fax', phone: 'Phone order', other: 'Other',
  },
  method: { pickup: 'Pickup in store', delivery: 'Pharmacy delivery', courier: 'Courier', compliance_pack: 'Compliance pack' },
  fulfilment: { open: 'Open', out_for_delivery: 'Out for delivery', completed: 'Completed', failed: 'Delivery failed' },
  sale: { open: 'Open', paid: 'Paid', refunded: 'Refunded', partially_refunded: 'Partly refunded', void: 'Void' },
  claim: { pending: 'Pending', submitted: 'Submitted', accepted: 'Accepted', rejected: 'Rejected' },
  item: { active: 'Active', completed: 'All supplies made', cancelled: 'Cancelled' },
  prescription: { active: 'Active', completed: 'Completed', cancelled: 'Cancelled' },
  screening: { pending: 'Awaiting sign-off', signed_off: 'Signed off', superseded: 'Replaced by a newer screening' },
  role: { pharmacist: 'Pharmacist', technician: 'Technician', courier: 'Courier', admin: 'Administrator' },
  payment: { card: 'Card', cash: 'Cash' },
  ledger: {
    opening: 'Opening balance', received: 'Received', adjustment: 'Adjustment', dispensed: 'Dispensed',
    sold: 'Sold', returned: 'Returned to stock', refund_restock: 'Refund restocked',
  },
  // Verb phrases, for "A technician can't <verb>".
  actionVerb: {
    enter: 'confirm data entry', clinical_check: 'do the clinical check', assemble: 'assemble the script',
    final_check: 'do the final check', release: 'release the script', complete: 'complete the handover',
    hold: 'put the script on hold', resume: 'resume the script', cancel: 'cancel the script',
  },
  audit: {
    'prescription.received': 'Script received', 'job.enter': 'Data entry confirmed', 'job.clinical_check': 'Clinical check signed off',
    'job.assemble': 'Assembled', 'job.final_check': 'Final check signed off', 'job.release': 'Released',
    'job.hold': 'Put on hold', 'job.resume': 'Resumed', 'job.cancel': 'Cancelled', 'job.repeat_requested': 'Repeat requested',
    'job.owing_supplied': 'Owing supplied', 'job.source_verified': 'Checked against the original', 'job.worksheet_printed': 'Worksheet printed',
    'item.amended': 'Script edited', 'item.amended_at_entry': 'Script edited at data entry', 'screening.run': 'Screening run',
    'screening.hard_stop_override': 'Hard stop overridden', 'stock.adjust': 'Stock adjusted', 'claims.submitted': 'Claims submitted',
    'sale.paid': 'Sale paid', 'sale.refunded': 'Sale refunded', 'fulfilment.dispatch': 'Dispatched', 'fulfilment.complete': 'Handed over',
    'fulfilment.fail': 'Delivery failed', 'fulfilment.retry': 'Delivery retried', 'flow.step': 'Pipeline step', 'broker.update_failed': 'E-script service update failed',
  },
  entity: { job: 'Script', prescription: 'Prescription', fulfilment: 'Order', sale: 'Sale', medicine: 'Medicine', claim_batch: 'Claims batch', system: 'System', flow: 'Flow' },
  step: {
    receive: 'Receive', match_patient: 'Match patient', verify_original: 'Verify original', map_formulary: 'Map to formulary',
    data_entry: 'Data entry', check_stock: 'Check stock', check_history: 'Check history', screen: 'Clinical screening',
    clinical_check: 'Clinical check', print_worksheet: 'Print worksheet', assemble: 'Assemble', final_check: 'Final check',
    generate_label: 'Generate label', book_courier: 'Book courier', handover: 'Hand over', notify_patient: 'Notify patient',
    submit_claim: 'Submit claim',
  },
  specialist: { pharma: 'Medication review', pharmacology: 'Clinical pharmacology', regulatory: 'Regulatory', advocacy: 'Patient advocacy' },
  origin: { rules: 'Rule', formulary: 'Formulary', ai: 'AI reviewer' },
};

/** "out_for_delivery" -> "Out for delivery"; "job.clinical_check" -> "Job clinical check". */
export function humanize(value) {
  if (value == null || value === '') return '—';
  const s = String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.\-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function label(kind, value) {
  return LABELS[kind]?.[value] ?? humanize(value);
}

/** Reviewer names are stored as technical ids ("mock-reviewer", "claude:claude-opus-5-5"). */
export function reviewerLabel(name) {
  if (!name) return 'Not run yet';
  if (name.startsWith('claude')) return 'Claude AI reviewer';
  if (name === 'mock-reviewer') return 'Offline reviewer (demo)';
  if (name.startsWith('none')) return 'Rules only';
  return humanize(name);
}

/** Capitalise the first letter of a sentence fragment ("in the dispensing queue"). */
export const sentence = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
