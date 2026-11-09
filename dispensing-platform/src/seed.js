// Demo data: staff, a small formulary (prescription and over-the-counter)
// with stock, and patient clinical details chosen so the screening has
// something to catch. All clinical thresholds and prices are ILLUSTRATIVE,
// not real Pharmac subsidies or validated clinical limits.

export function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

  const user = db.prepare('INSERT INTO users (name, initials, role) VALUES (?, ?, ?)');
  user.run('Priya Shah', 'PS', 'pharmacist');
  user.run('Tom Rangi', 'TR', 'pharmacist');
  user.run('Lucy Chen', 'LC', 'technician');
  user.run('Ben Taylor', 'BT', 'courier');

  const med = db.prepare(
    `INSERT INTO medicines (code, name, ingredient, form, strength, pack_size, subsidy_cents, patient_charge_cents,
       controlled_class, warnings, therapeutic_class, allergy_class, unit_mg, max_daily_mg, renal_adjust_egfr,
       renal_avoid_egfr, lasa, is_otc, price_cents, reorder_point, par_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stock = db.prepare('INSERT INTO stock (medicine_id, on_hand) VALUES (?, ?)');
  const ledger = db.prepare("INSERT INTO stock_ledger (medicine_id, change, balance, reason, kind) VALUES (?, ?, ?, 'Opening balance', 'opening')");

  // code, name, ingredient, form, strength, pack, subsidy, charge, CD, warnings, class, allergyClass,
  // unitMg, maxDailyMg, renalAdjust, renalAvoid, lasa, otc, price, reorderPt, par, onHand
  const formulary = [
    ['MET500', 'Metformin', 'metformin', 'tablet', '500 mg', 100, 420, 500, null, ['Take with food'], 'biguanide', null, 500, 3000, 45, 30, ['MTZ400'], 0, 0, 200, 600, 500],
    ['MTZ400', 'Metronidazole', 'metronidazole', 'tablet', '400 mg', 21, 520, 500, null, ['Avoid alcohol during and for 48 hours after the course'], 'nitroimidazole', null, 400, 2400, null, null, ['MET500'], 0, 0, 21, 63, 42],
    ['ATO40', 'Atorvastatin', 'atorvastatin', 'tablet', '40 mg', 90, 610, 500, null, [], 'statin', null, 40, 80, null, null, [], 0, 0, 90, 270, 270],
    ['AMX500', 'Amoxicillin', 'amoxicillin', 'capsule', '500 mg', 20, 380, 500, null, ['Finish the course'], 'penicillin', 'penicillin', 500, 3000, null, null, [], 0, 0, 20, 60, 10],
    ['OXY5', 'Oxycodone', 'oxycodone', 'capsule', '5 mg', 20, 950, 500, 'B', ['May cause drowsiness — do not drive', 'Avoid alcohol'], 'opioid', null, 5, 80, null, null, [], 0, 0, 20, 60, 40],
    ['PAR500', 'Paracetamol', 'paracetamol', 'tablet', '500 mg', 100, 250, 500, null, ['Do not exceed 8 tablets in 24 hours'], 'analgesic', null, 500, 4000, null, null, [], 0, 0, 200, 1000, 1000],
    ['COD30', 'Codeine phosphate', 'codeine', 'tablet', '30 mg', 100, 540, 500, 'C', ['May cause drowsiness'], 'opioid', null, 30, 240, null, null, [], 0, 0, 100, 200, 100],
    ['CLA500', 'Clarithromycin', 'clarithromycin', 'tablet', '500 mg', 14, 730, 500, null, ['Finish the course'], 'macrolide', null, 500, 1000, 30, null, [], 0, 0, 14, 42, 28],
    // Over-the-counter (GST-inclusive retail prices)
    ['PAR-OTC20', 'Paracetamol 20 pack', 'paracetamol', 'tablet', '500 mg', 1, 0, 0, null, [], 'analgesic', null, 500, 4000, null, null, [], 1, 450, 10, 40, 24],
    ['IBU-OTC24', 'Ibuprofen 24 pack', 'ibuprofen', 'tablet', '200 mg', 1, 0, 0, null, ['Take with food'], 'nsaid', null, 200, 1200, 30, null, [], 1, 899, 10, 30, 8],
    ['LOR-OTC30', 'Loratadine 30 pack', 'loratadine', 'tablet', '10 mg', 1, 0, 0, null, [], 'antihistamine', null, 10, 10, null, null, [], 1, 1299, 6, 20, 15],
  ];
  for (const [code, name, ing, form, str, pack, sub, charge, cls, warn, tclass, aclass, unit, maxd, radj, ravoid, lasa, otc, price, rop, par, qty] of formulary) {
    const r = med.run(code, name, ing, form, str, pack, sub, charge, cls, JSON.stringify(warn), tclass, aclass, unit, maxd, radj, ravoid, JSON.stringify(lasa), otc, price, rop, par);
    const id = Number(r.lastInsertRowid);
    stock.run(id, qty);
    ledger.run(id, qty, qty);
  }

  for (const row of db.prepare('SELECT m.id, s.on_hand FROM medicines m JOIN stock s ON s.medicine_id = m.id WHERE controlled_class IS NOT NULL').all()) {
    db.prepare("INSERT INTO cd_register (medicine_id, change, balance, reason) VALUES (?, ?, ?, 'Opening balance')").run(row.id, row.on_hand, row.on_hand);
  }

  const patient = db.prepare(
    `INSERT INTO patients (nhi, name, dob, address, phone, allergies, egfr, weight_kg, preferred_language, external_meds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Aroha: older adult, reduced kidney function, prefers te reo Māori, and is
  // taking clarithromycin from a prescription filled elsewhere, so her
  // metformin + atorvastatin script trips renal and interaction checks.
  patient.run('ZZZ0016', 'Aroha Ngata', '1958-03-14', '12 Kauri St, Ponsonby, Auckland', '021 555 0101', '[]', 38, 72, 'mi',
    JSON.stringify([{ ingredient: 'clarithromycin', name: 'Clarithromycin 500 mg', therapeutic_class: 'macrolide', source: 'filled at another pharmacy (history)' }]));
  // James: penicillin allergy, so his amoxicillin script is a hard stop.
  patient.run('ZZZ0024', 'James Wilson', '1990-11-02', '4 Rimu Rd, Mt Eden, Auckland', '022 555 0199', JSON.stringify(['penicillin']), 95, 80, 'en', '[]');
}
