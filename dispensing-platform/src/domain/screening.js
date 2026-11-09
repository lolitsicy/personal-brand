// Deterministic clinical screening rules.
//
// Rule findings are the safety floor. An AI reviewer can ADD findings but can
// never remove, downgrade or clear a rule finding. Hard stops can only be
// overridden by a pharmacist who records a reason and confirms they contacted
// the prescriber.
//
// Every finding carries a reasoning trace (the inputs used, the rule applied,
// and its source) so the decision can be audited later.
//
// The thresholds and tables below are DEMO VALUES to show the mechanism. A
// production system would take dose limits, renal adjustments, interactions
// and LASA pairs from a licensed, maintained knowledge base (e.g. one mapped
// to NZMT/NZULM) and have a pharmacist clinically validate each rule.

export const RULES_VERSION = 'demo-rules-2026.11';

export const SEVERITY_ORDER = ['hard_stop', 'high', 'moderate', 'info'];

export const SPECIALISTS = {
  pharma: 'Medication review',
  pharmacology: 'Clinical pharmacology',
  regulatory: 'Regulatory',
  advocacy: 'Patient advocacy',
};

const INTERACTIONS = [
  { a: 'oxycodone', b: 'codeine', severity: 'high', msg: 'Two opioids together: additive CNS and respiratory depression', src: 'Demo interaction table' },
  { a: 'oxycodone', b: 'diazepam', severity: 'high', msg: 'Opioid + benzodiazepine: risk of profound sedation and respiratory depression', src: 'Demo interaction table' },
  { a: 'atorvastatin', b: 'clarithromycin', severity: 'high', msg: 'Clarithromycin inhibits CYP3A4, raising atorvastatin levels: myopathy/rhabdomyolysis risk', src: 'Demo interaction table (CYP3A4)' },
  { a: 'metformin', b: 'iodinated contrast', severity: 'moderate', msg: 'Withhold metformin around iodinated contrast', src: 'Demo interaction table' },
];

const CNS_DEPRESSANTS = new Set(['oxycodone', 'codeine', 'diazepam']);

const finding = (f) => ({ ...f, id: `${f.code}:${f.subject ?? ''}`.toLowerCase() });

function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) age--;
  return age;
}

/**
 * @param ctx {
 *   medicine, item, patient,
 *   otherMeds: [{ ingredient, therapeutic_class, name, source }],   // active queue + recent supplies + external history
 *   lastRelease: { at, periodDays } | null,
 * }
 * @returns findings[]
 */
export function screen({ medicine, item, patient, otherMeds = [], lastRelease = null }) {
  const out = [];
  const ingredient = medicine.ingredient.toLowerCase();
  const allergies = JSON.parse(patient.allergies || '[]').map((a) => a.toLowerCase());
  const age = ageFrom(patient.dob);

  // ── Allergy (direct or class) ── hard stop
  const allergyHit = allergies.find((a) => a === ingredient || (medicine.allergy_class && a === medicine.allergy_class.toLowerCase()));
  if (allergyHit) {
    out.push(finding({
      code: 'ALLERGY', subject: ingredient, severity: 'hard_stop', specialist: 'pharma',
      message: `Recorded ${allergyHit === ingredient ? '' : `${allergyHit}-class `}allergy: ${medicine.name} is contraindicated`,
      trace: { inputs: { allergies, ingredient, allergyClass: medicine.allergy_class }, rule: 'Ingredient or allergy class matches a recorded allergy', source: 'Patient allergy record' },
    }));
  }

  // ── Dose ceiling ── hard stop
  if (medicine.max_daily_mg && medicine.unit_mg && item.dose_units && item.doses_per_day) {
    const daily = medicine.unit_mg * item.dose_units * item.doses_per_day;
    if (daily > medicine.max_daily_mg) {
      out.push(finding({
        code: 'DOSE_CEILING', subject: ingredient, severity: 'hard_stop', specialist: 'pharma',
        message: `Daily dose ${daily} mg exceeds the ${medicine.max_daily_mg} mg ceiling for ${medicine.name}`,
        trace: { inputs: { unitMg: medicine.unit_mg, doseUnits: item.dose_units, dosesPerDay: item.doses_per_day, dailyMg: daily }, rule: `daily mg = unit mg × units/dose × doses/day > ${medicine.max_daily_mg}`, source: 'Formulary dose ceiling (demo)' },
      }));
    }
  } else if (medicine.max_daily_mg) {
    out.push(finding({
      code: 'DOSE_UNSTRUCTURED', subject: ingredient, severity: 'moderate', specialist: 'pharma',
      message: 'Dose is free text only, so the dose ceiling could not be checked automatically. Check the directions manually.',
      trace: { inputs: { directions: item.directions }, rule: 'Structured dose required for automated ceiling check', source: 'System' },
    }));
  }

  // ── Renal dosing ──
  if (patient.egfr != null) {
    if (medicine.renal_avoid_egfr != null && patient.egfr < medicine.renal_avoid_egfr) {
      out.push(finding({
        code: 'RENAL_AVOID', subject: ingredient, severity: 'hard_stop', specialist: 'pharma',
        message: `eGFR ${patient.egfr}: avoid ${medicine.name} below ${medicine.renal_avoid_egfr}`,
        trace: { inputs: { egfr: patient.egfr, threshold: medicine.renal_avoid_egfr }, rule: 'eGFR below the contraindication threshold', source: 'Formulary renal table (demo)' },
      }));
    } else if (medicine.renal_adjust_egfr != null && patient.egfr < medicine.renal_adjust_egfr) {
      out.push(finding({
        code: 'RENAL_ADJUST', subject: ingredient, severity: 'high', specialist: 'pharma',
        message: `eGFR ${patient.egfr}: ${medicine.name} needs dose review below ${medicine.renal_adjust_egfr}`,
        trace: { inputs: { egfr: patient.egfr, threshold: medicine.renal_adjust_egfr }, rule: 'eGFR below the dose-adjustment threshold', source: 'Formulary renal table (demo)' },
      }));
    }
  }

  // ── Whole-list review: duplication + interactions ──
  for (const other of otherMeds) {
    const oi = other.ingredient.toLowerCase();
    if (oi === ingredient) {
      out.push(finding({
        code: 'DUPLICATE', subject: oi, severity: 'high', specialist: 'pharma',
        message: `${medicine.ingredient} is already on the patient's medication list (${other.source})`,
        trace: { inputs: { ingredient, other }, rule: 'Same active ingredient on the medication list', source: 'Medication list' },
      }));
      continue;
    }
    if (medicine.therapeutic_class && other.therapeutic_class === medicine.therapeutic_class) {
      out.push(finding({
        code: 'THERAPEUTIC_DUPLICATION', subject: oi, severity: 'high', specialist: 'pharma',
        message: `Two ${medicine.therapeutic_class} medicines: ${medicine.ingredient} and ${other.ingredient} (${other.source})`,
        trace: { inputs: { class: medicine.therapeutic_class, other }, rule: 'Same therapeutic class on the medication list', source: 'Formulary class (demo)' },
      }));
    }
    const ix = INTERACTIONS.find((r) => (r.a === ingredient && r.b === oi) || (r.b === ingredient && r.a === oi));
    if (ix) {
      out.push(finding({
        code: 'INTERACTION', subject: oi, severity: ix.severity, specialist: 'pharmacology',
        message: `${medicine.ingredient} + ${other.ingredient}: ${ix.msg}`,
        trace: { inputs: { ingredient, other }, rule: 'Pair listed in the interaction table', source: ix.src },
      }));
    }
  }

  // ── Early repeat ──
  if (lastRelease?.periodDays) {
    const daysSince = (Date.now() - Date.parse(lastRelease.at)) / 86_400_000;
    if (daysSince < lastRelease.periodDays * 0.75) {
      out.push(finding({
        code: 'EARLY_REPEAT', subject: ingredient, severity: 'high', specialist: 'regulatory',
        message: `Repeat requested ${Math.floor(daysSince)} days after the last supply (period ${lastRelease.periodDays} days)`,
        trace: { inputs: { lastSupplyAt: lastRelease.at, periodDays: lastRelease.periodDays, daysSince: Math.floor(daysSince) }, rule: 'Repeat before 75% of the supply period has elapsed', source: 'Repeat interval rule (demo)' },
      }));
    }
  }

  // ── Older adult + CNS depressant ──
  if (age != null && age >= 65 && CNS_DEPRESSANTS.has(ingredient)) {
    out.push(finding({
      code: 'OLDER_ADULT_CNS', subject: ingredient, severity: 'moderate', specialist: 'pharma',
      message: `Patient is ${age}: ${medicine.name} increases falls and confusion risk in older adults`,
      trace: { inputs: { age, ingredient }, rule: 'Age ≥ 65 with a CNS depressant', source: 'Older-adult prescribing caution (demo)' },
    }));
  }

  // ── Regulatory ──
  if (medicine.controlled_class) {
    out.push(finding({
      code: 'CONTROLLED', subject: ingredient, severity: 'info', specialist: 'regulatory',
      message: `Class ${medicine.controlled_class} controlled drug: register entry and pharmacist check required`,
      trace: { inputs: { class: medicine.controlled_class }, rule: 'Controlled drug classification', source: 'Misuse of Drugs Act schedule (formulary flag)' },
    }));
  }

  // ── Patient advocacy ──
  if (patient.preferred_language && patient.preferred_language !== 'en') {
    out.push(finding({
      code: 'LANGUAGE', subject: patient.preferred_language, severity: 'info', specialist: 'advocacy',
      message: `Preferred language is ${patient.preferred_language}: offer counselling and written information in that language`,
      trace: { inputs: { preferredLanguage: patient.preferred_language }, rule: 'Non-English preferred language on record', source: 'Patient record' },
    }));
  }

  for (const w of JSON.parse(medicine.warnings || '[]')) {
    out.push(finding({ code: 'COUNSEL', subject: w.slice(0, 24), severity: 'info', specialist: 'advocacy', message: w, trace: { inputs: {}, rule: 'Medicine counselling point', source: 'Formulary' } }));
  }

  return dedupe(out);
}

/** LASA check at data entry: medicines whose names are easily confused with this one. */
export function lasaFindings(medicine, formulary) {
  const pairs = JSON.parse(medicine.lasa || '[]');
  return pairs
    .map((code) => formulary.find((m) => m.code === code))
    .filter(Boolean)
    .map((m) => finding({
      code: 'LASA', subject: m.code, severity: 'moderate', specialist: 'pharma',
      message: `Look-alike/sound-alike: confirm this is ${medicine.name} ${medicine.strength}, not ${m.name} ${m.strength}`,
      trace: { inputs: { selected: medicine.code, confusableWith: m.code }, rule: 'Medicine is on the LASA list', source: 'LASA list (demo)' },
    }));
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
}

export function sortFindings(list) {
  return [...list].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/**
 * Pharmacist sign-off validation. Returns null if OK, else an error message.
 *   hard_stop -> { action: 'override', reason, prescriberConfirmed: true }
 *   high      -> { action: 'acknowledge', note? }  (or an override)
 *   moderate / info -> no decision needed
 */
export function validateDecisions(findings, decisions = {}) {
  for (const f of findings) {
    const d = decisions[f.id];
    if (f.severity === 'hard_stop') {
      if (!d || d.action !== 'override' || !d.reason?.trim() || d.prescriberConfirmed !== true) {
        return `Hard stop "${f.message}" needs an override with a reason and confirmation that the prescriber was contacted`;
      }
    } else if (f.severity === 'high') {
      if (!d || !['acknowledge', 'override'].includes(d.action)) {
        return `"${f.message}" must be reviewed and acknowledged`;
      }
    }
  }
  return null;
}
