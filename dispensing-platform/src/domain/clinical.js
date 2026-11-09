// Clinical safety checks run before a pharmacist signs off the clinical check.
// This is a deliberately small rule set to show the mechanism. A production
// system would use a licensed interaction/allergy knowledge base (e.g. one
// mapped to NZMT/NZULM) rather than a hand-written table.

const INTERACTIONS = [
  ['oxycodone', 'codeine', 'Opioid duplication: additive CNS and respiratory depression'],
  ['oxycodone', 'diazepam', 'Opioid + benzodiazepine: risk of profound sedation and respiratory depression'],
  ['atorvastatin', 'clarithromycin', 'Clarithromycin raises statin levels: myopathy risk'],
  ['metformin', 'iodinated contrast', 'Withhold metformin around iodinated contrast'],
];

function interactionFor(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return INTERACTIONS.find(([p, q]) => (p === x && q === y) || (p === y && q === x))?.[2] ?? null;
}

/**
 * @param ctx { medicine, patient, item, otherIngredients: string[], lastRelease: { at, periodDays } | null }
 * @returns [{ severity: 'high'|'info', code, message }]
 */
export function clinicalWarnings({ medicine, patient, otherIngredients = [], lastRelease = null }) {
  const warnings = [];
  const allergies = JSON.parse(patient.allergies || '[]').map((a) => a.toLowerCase());
  const ingredient = medicine.ingredient.toLowerCase();

  if (allergies.includes(ingredient)) {
    warnings.push({ severity: 'high', code: 'ALLERGY', message: `Patient has a recorded allergy to ${medicine.ingredient}` });
  }

  for (const other of new Set(otherIngredients)) {
    if (other.toLowerCase() === ingredient) {
      warnings.push({ severity: 'high', code: 'DUPLICATE', message: `Patient already has active ${medicine.ingredient} in the queue` });
      continue;
    }
    const msg = interactionFor(ingredient, other);
    if (msg) warnings.push({ severity: 'high', code: 'INTERACTION', message: `${medicine.ingredient} + ${other}: ${msg}` });
  }

  if (lastRelease?.periodDays) {
    const daysSince = (Date.now() - Date.parse(lastRelease.at)) / 86_400_000;
    if (daysSince < lastRelease.periodDays * 0.75) {
      warnings.push({
        severity: 'high',
        code: 'EARLY_REPEAT',
        message: `Repeat requested ${Math.floor(daysSince)} days after last supply (period ${lastRelease.periodDays} days)`,
      });
    }
  }

  if (medicine.controlled_class) {
    warnings.push({ severity: 'info', code: 'CONTROLLED', message: `Class ${medicine.controlled_class} controlled drug: register entry and pharmacist check required` });
  }
  for (const w of JSON.parse(medicine.warnings || '[]')) {
    warnings.push({ severity: 'info', code: 'COUNSEL', message: w });
  }
  return warnings;
}
