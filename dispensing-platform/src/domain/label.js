// Dispensing label text. Field set follows the usual NZ legal minimum
// (pharmacy name/address/phone, patient name, medicine + strength + form,
// quantity, directions, date, identifier, "keep out of reach of children").
// Confirm exact requirements against the Medicines Regulations 1984 and
// Pharmacy Council standards before production use.

export function buildLabel({ pharmacy, patient, medicine, item, job, prescriber, checkerInitials = '__' }) {
  const date = new Date().toLocaleDateString('en-NZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const repeatsLeft = item.repeats_authorised + 1 - (item.dispensings_count + 1);
  const lines = [
    `${medicine.name} ${medicine.strength} ${medicine.form}`.toUpperCase(),
    `Qty: ${job.quantity_supplied}${job.owing ? ` (owing ${job.owing})` : ''}`,
    item.directions,
    '',
    patient.name,
    `Dr ${prescriber.name.replace(/^Dr\.?\s*/i, '')}    ${date}    Rx ${job.id}-${job.sequence}`,
    `Repeats remaining: ${Math.max(repeatsLeft, 0)}    Checked: ${checkerInitials}`,
    ...JSON.parse(medicine.warnings || '[]').map((w) => `• ${w}`),
    'KEEP OUT OF REACH OF CHILDREN',
    `${pharmacy.name}, ${pharmacy.address}  Ph ${pharmacy.phone}`,
  ];
  return lines.join('\n');
}
