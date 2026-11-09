// Demo data: staff, a small formulary with stock, and one patient allergy so
// the clinical check has something to catch. All figures are illustrative,
// not real Pharmac subsidies.

export function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

  const user = db.prepare('INSERT INTO users (name, initials, role) VALUES (?, ?, ?)');
  user.run('Priya Shah', 'PS', 'pharmacist');
  user.run('Tom Rangi', 'TR', 'pharmacist');
  user.run('Lucy Chen', 'LC', 'technician');
  user.run('Ben Taylor', 'BT', 'courier');

  const med = db.prepare(
    `INSERT INTO medicines (code, name, ingredient, form, strength, pack_size, subsidy_cents, patient_charge_cents, controlled_class, warnings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stock = db.prepare('INSERT INTO stock (medicine_id, on_hand) VALUES (?, ?)');
  const formulary = [
    ['MET500', 'Metformin', 'metformin', 'tablet', '500 mg', 100, 420, 500, null, ['Take with food'], 500],
    ['ATO40', 'Atorvastatin', 'atorvastatin', 'tablet', '40 mg', 90, 610, 500, null, [], 270],
    ['AMX500', 'Amoxicillin', 'amoxicillin', 'capsule', '500 mg', 20, 380, 500, null, ['Finish the course'], 10],
    ['OXY5', 'Oxycodone', 'oxycodone', 'capsule', '5 mg', 20, 950, 500, 'B', ['May cause drowsiness — do not drive', 'Avoid alcohol'], 40],
    ['PAR500', 'Paracetamol', 'paracetamol', 'tablet', '500 mg', 100, 250, 500, null, ['Do not exceed 8 tablets in 24 hours'], 1000],
    ['COD30', 'Codeine phosphate', 'codeine', 'tablet', '30 mg', 100, 540, 500, 'C', ['May cause drowsiness'], 100],
    ['CLA500', 'Clarithromycin', 'clarithromycin', 'tablet', '500 mg', 14, 730, 500, null, ['Finish the course'], 28],
  ];
  for (const [code, name, ing, form, str, pack, sub, charge, cls, warn, qty] of formulary) {
    const r = med.run(code, name, ing, form, str, pack, sub, charge, cls, JSON.stringify(warn));
    stock.run(Number(r.lastInsertRowid), qty);
  }

  // Opening CD register balance for the controlled drugs.
  for (const row of db.prepare("SELECT m.id, s.on_hand FROM medicines m JOIN stock s ON s.medicine_id = m.id WHERE controlled_class IS NOT NULL").all()) {
    db.prepare("INSERT INTO cd_register (medicine_id, change, balance, reason) VALUES (?, ?, ?, 'Opening balance')").run(row.id, row.on_hand, row.on_hand);
  }

  // James Wilson (one of the mock e-script patients) has a recorded
  // amoxicillin allergy, so his antibiotic script trips the clinical check.
  db.prepare(
    "INSERT INTO patients (nhi, name, dob, address, phone, allergies) VALUES ('ZZZ0024', 'James Wilson', '1990-11-02', '4 Rimu Rd, Mt Eden, Auckland', '022 555 0199', ?)",
  ).run(JSON.stringify(['amoxicillin']));
}
