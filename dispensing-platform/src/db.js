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
  egfr REAL,
  weight_kg REAL,
  hepatic_impairment INTEGER NOT NULL DEFAULT 0,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  external_meds TEXT NOT NULL DEFAULT '[]',
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
  warnings TEXT NOT NULL DEFAULT '[]',
  therapeutic_class TEXT,
  allergy_class TEXT,
  unit_mg REAL,
  max_daily_mg REAL,
  renal_adjust_egfr REAL,
  renal_avoid_egfr REAL,
  lasa TEXT NOT NULL DEFAULT '[]',
  is_otc INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 0,
  par_level INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id INTEGER PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  change INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  reason TEXT NOT NULL,
  kind TEXT NOT NULL,
  job_id INTEGER,
  sale_id INTEGER,
  user_id INTEGER,
  at TEXT NOT NULL DEFAULT (datetime('now'))
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
  source_payload TEXT,            -- the script exactly as received (e-script) or as keyed (manual)
  source_hash TEXT,               -- sha256 of source_payload at receipt
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prescription_documents (
  id INTEGER PRIMARY KEY,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','application/pdf')),
  filename TEXT,
  data BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
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
  dose_units REAL,
  doses_per_day REAL,
  amendments TEXT NOT NULL DEFAULT '[]',
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
  pickup_code TEXT UNIQUE,
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

CREATE TABLE IF NOT EXISTS screenings (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES dispense_jobs(id),
  rules_version TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  findings TEXT NOT NULL,
  counselling TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed_off','superseded')),
  decisions TEXT,
  signed_off_by INTEGER REFERENCES users(id),
  signed_off_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER REFERENCES patients(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','refunded','partially_refunded','void')),
  total_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  payment_ref TEXT,
  user_id INTEGER REFERENCES users(id),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_lines (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  kind TEXT NOT NULL CHECK (kind IN ('rx','otc')),
  job_id INTEGER REFERENCES dispense_jobs(id),
  medicine_id INTEGER REFERENCES medicines(id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_cents INTEGER NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0
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
