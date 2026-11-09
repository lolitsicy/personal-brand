import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pharmacist','technician','courier','admin'))
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  nhi TEXT UNIQUE,
  name TEXT NOT NULL,
  dob TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  allergies TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prescribers (
  id INTEGER PRIMARY KEY,
  hpi_cpn TEXT UNIQUE,
  name TEXT NOT NULL,
  facility_hpi TEXT,
  facility_name TEXT,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  ingredient TEXT NOT NULL,
  form TEXT NOT NULL,
  strength TEXT NOT NULL,
  pack_size INTEGER NOT NULL,
  subsidy_cents INTEGER NOT NULL DEFAULT 0,
  patient_charge_cents INTEGER NOT NULL DEFAULT 500,
  controlled_class TEXT CHECK (controlled_class IN ('A','B','C')),
  warnings TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS stock (
  medicine_id INTEGER PRIMARY KEY REFERENCES medicines(id),
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0)
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY,
  scid TEXT UNIQUE,
  source TEXT NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  prescriber_id INTEGER NOT NULL REFERENCES prescribers(id),
  prescribed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prescription_items (
  id INTEGER PRIMARY KEY,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
  item_ref TEXT,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  directions TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  repeats_authorised INTEGER NOT NULL DEFAULT 0 CHECK (repeats_authorised >= 0),
  period_days INTEGER,
  dispensings_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled'))
);

CREATE TABLE IF NOT EXISTS fulfilments (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  method TEXT NOT NULL CHECK (method IN ('pickup','delivery','courier','compliance_pack')),
  address TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','out_for_delivery','completed','failed')),
  provider TEXT,
  tracking_ref TEXT,
  scheduled_for TEXT,
  proof TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS dispense_jobs (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES prescription_items(id),
  sequence INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  quantity_supplied INTEGER NOT NULL DEFAULT 0,
  owing INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  held_from TEXT,
  hold_reason TEXT,
  entered_by INTEGER REFERENCES users(id),
  clinical_checked_by INTEGER REFERENCES users(id),
  assembled_by INTEGER REFERENCES users(id),
  final_checked_by INTEGER REFERENCES users(id),
  warnings_acknowledged TEXT,
  label_text TEXT,
  fulfilment_id INTEGER REFERENCES fulfilments(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, sequence)
);

CREATE TABLE IF NOT EXISTS cd_register (
  id INTEGER PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  change INTEGER NOT NULL,
  balance INTEGER NOT NULL CHECK (balance >= 0),
  reason TEXT NOT NULL,
  job_id INTEGER REFERENCES dispense_jobs(id),
  user_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  job_id INTEGER UNIQUE NOT NULL REFERENCES dispense_jobs(id),
  patient_nhi TEXT,
  prescriber_cpn TEXT,
  medicine_code TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  subsidy_cents INTEGER NOT NULL,
  patient_charge_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','accepted','rejected')),
  batch_ref TEXT,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON dispense_jobs(state);
CREATE INDEX IF NOT EXISTS idx_items_rx ON prescription_items(prescription_id);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. Nested calls join the outer transaction. */
export function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.__inTx = false;
  }
}
