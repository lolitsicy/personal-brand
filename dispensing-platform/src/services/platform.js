import { tx } from '../db.js';
import { assertScid } from '../domain/scid.js';
import { planTransition, availableActions } from '../domain/workflow.js';
import { screen, lasaFindings, sortFindings, validateDecisions, RULES_VERSION } from '../domain/screening.js';
import { randomInt, createHash } from 'node:crypto';
import { buildLabel } from '../domain/label.js';
import { DomainError, notFound, forbidden, conflict } from '../domain/errors.js';
import { createAudit } from './audit.js';

const OPEN_JOB_STATES = ['queued', 'entered', 'clinically_checked', 'assembled', 'checked', 'on_hold'];
const STOCK_HELD_STATES = ['assembled', 'checked'];

export function createPlatform({ db, adapters, config, hooks = {} }) {
  // hooks (filled in by server.js after construction):
  //   formulary      — { check(ctx) -> findings[], buildHistory(rows) } (synchronous)
  //   afterIntake    — async (prescription) => void
  //   afterTransition— async (jobId, action) => void
  //   afterFulfilment— async (fulfilmentId, action) => void
  const audit = createAudit(db);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  // ───────────────────────── lookups ─────────────────────────

  function getUser(id) {
    return id ? one('SELECT * FROM users WHERE id = ?', Number(id)) : null;
  }

  function loadJob(id) {
    const job = one(
      `SELECT j.*, i.prescription_id, i.medicine_id, i.item_ref, i.directions, i.quantity AS item_quantity,
              i.repeats_authorised, i.period_days, i.dispensings_count, i.status AS item_status,
              p.scid, p.source, p.patient_id, p.prescriber_id
       FROM dispense_jobs j
       JOIN prescription_items i ON i.id = j.item_id
       JOIN prescriptions p ON p.id = i.prescription_id
       WHERE j.id = ?`,
      Number(id),
    );
    if (!job) throw notFound('Dispense job', id);
    return job;
  }

  const medicine = (id) => one('SELECT * FROM medicines WHERE id = ?', id);
  const patient = (id) => one('SELECT * FROM patients WHERE id = ?', id);
  const prescriber = (id) => one('SELECT * FROM prescribers WHERE id = ?', id);
  const onHand = (medicineId) => one('SELECT on_hand FROM stock WHERE medicine_id = ?', medicineId)?.on_hand ?? 0;

  // ─────────────────── stock + controlled drug register ───────────────────

  function moveStock(medicineId, delta, { reason, jobId = null, userId = null, saleId = null, kind = 'adjustment' }) {
    const current = onHand(medicineId);
    const next = current + delta;
    if (next < 0) throw conflict(`Insufficient stock (on hand ${current}, need ${-delta})`);
    run(
      `INSERT INTO stock (medicine_id, on_hand) VALUES (?, ?)
       ON CONFLICT(medicine_id) DO UPDATE SET on_hand = excluded.on_hand`,
      medicineId,
      next,
    );
    run(
      'INSERT INTO stock_ledger (medicine_id, change, balance, reason, kind, job_id, sale_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      medicineId, delta, next, reason, kind, jobId, saleId, userId,
    );
    const med = medicine(medicineId);
    if (med.controlled_class) {
      run(
        'INSERT INTO cd_register (medicine_id, change, balance, reason, job_id, user_id) VALUES (?, ?, ?, ?, ?, ?)',
        medicineId, delta, next, reason, jobId, userId,
      );
    }
    return next;
  }

  function adjustStock(medicineId, delta, reason, user) {
    if (!user) throw new DomainError('Sign in required', { status: 401 });
    const med = medicine(Number(medicineId));
    if (!med) throw notFound('Medicine', medicineId);
    if (!Number.isInteger(delta) || delta === 0) throw new DomainError('delta must be a non-zero integer');
    if (med.controlled_class && !['pharmacist', 'admin'].includes(user.role)) {
      throw forbidden('Only a pharmacist can adjust controlled drug stock');
    }
    return tx(db, () => {
      const balance = moveStock(med.id, delta, { reason: reason || 'Stock adjustment', userId: user.id, kind: delta > 0 ? 'received' : 'adjustment' });
      audit.record({ userId: user.id, action: 'stock.adjust', entity: 'medicine', entityId: med.id, data: { delta, reason, balance } });
      return { medicineId: med.id, onHand: balance };
    });
  }

  // ───────────────────────── intake ─────────────────────────

  /** Universal intake: any script source is normalised to a CanonicalPrescription first. */
  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

  /** Validate an attached scan/photo of the original script. Returns { mime, filename, data, hash }. */
  function parseDocument(doc) {
    if (!doc) return null;
    const data = Buffer.from(String(doc.dataBase64 ?? ''), 'base64');
    if (!data.length) throw new DomainError('Attached document is empty');
    if (data.length > 6_000_000) throw new DomainError('Attached document is larger than 6 MB');
    const magic = data.subarray(0, 5);
    const mime = magic[0] === 0x89 && magic[1] === 0x50 ? 'image/png'
      : magic[0] === 0xff && magic[1] === 0xd8 ? 'image/jpeg'
      : magic.toString('latin1') === '%PDF-' ? 'application/pdf' : null;
    if (!mime) throw new DomainError('Original script must be a PNG, JPEG or PDF');
    return { mime, filename: String(doc.filename ?? '').slice(0, 120) || null, data, hash: sha256(data) };
  }

  async function ingest(canon, user, { sourcePayload, document = null, requireDocument = false } = {}) {
    if (!user) throw new DomainError('Sign in required', { status: 401 });
    if (!canon?.patient || !canon?.prescriber || !Array.isArray(canon.items) || canon.items.length === 0) {
      throw new DomainError('Prescription needs a patient, a prescriber and at least one item');
    }
    if (canon.externalId) {
      const existing = one('SELECT id FROM prescriptions WHERE scid = ?', canon.externalId);
      if (existing) throw conflict('This prescription has already been received', { prescriptionId: existing.id });
    }

    const meds = canon.items.map((it) => ({ it, med: one('SELECT * FROM medicines WHERE code = ?', it.medicineCode) }));
    const unknown = meds.filter((m) => !m.med).map((m) => m.it.medicineCode);
    if (unknown.length) throw new DomainError(`Unknown medicine code(s): ${unknown.join(', ')}`);
    for (const { it, med } of meds) {
      if (med.controlled_class === 'B' && Number(it.repeats) > 0) {
        throw new DomainError(`${med.name}: Class B controlled drugs cannot carry repeats — dispense in instalments instead`);
      }
      if (!(Number(it.quantity) > 0)) throw new DomainError(`${med.name}: quantity must be positive`);
    }
    const doc = parseDocument(document);
    if (requireDocument && !doc) {
      throw new DomainError('Attach a scan or photo of the original script so the pharmacist can check against it');
    }
    const payload = sourcePayload ?? JSON.stringify(canon);
    const payloadHash = sha256(payload);

    // Enrich patient from the identity service before opening the transaction.
    let nhiRecord = null;
    if (canon.patient.nhi && !one('SELECT id FROM patients WHERE nhi = ?', canon.patient.nhi)) {
      nhiRecord = await adapters.identity.lookupPatient(canon.patient.nhi);
    }

    return tx(db, () => {
      let pat = canon.patient.nhi ? one('SELECT * FROM patients WHERE nhi = ?', canon.patient.nhi) : null;
      if (!pat) {
        const p = { ...canon.patient, ...(nhiRecord ?? {}) };
        const r = run(
          'INSERT INTO patients (nhi, name, dob, address, phone, allergies) VALUES (?, ?, ?, ?, ?, ?)',
          p.nhi ?? null, p.name, p.dob ?? null, p.address ?? null, canon.patient.phone ?? null, JSON.stringify(p.allergies ?? []),
        );
        pat = patient(Number(r.lastInsertRowid));
      }

      let prescriberRow = canon.prescriber.cpn ? one('SELECT * FROM prescribers WHERE hpi_cpn = ?', canon.prescriber.cpn) : null;
      if (!prescriberRow) {
        const r = run(
          'INSERT INTO prescribers (hpi_cpn, name, facility_hpi, facility_name) VALUES (?, ?, ?, ?)',
          canon.prescriber.cpn ?? null, canon.prescriber.name, canon.prescriber.facilityHpi ?? null, canon.prescriber.facilityName ?? null,
        );
        prescriberRow = prescriber(Number(r.lastInsertRowid));
      }

      const rx = run(
        'INSERT INTO prescriptions (scid, source, patient_id, prescriber_id, prescribed_at, notes, source_payload, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        canon.externalId ?? null, canon.source, pat.id, prescriberRow.id, canon.prescribedAt ?? new Date().toISOString().slice(0, 10), canon.notes ?? null,
        payload, payloadHash,
      );
      const rxId = Number(rx.lastInsertRowid);
      if (doc) {
        run(
          'INSERT INTO prescription_documents (prescription_id, mime, filename, data, sha256, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
          rxId, doc.mime, doc.filename, doc.data, doc.hash, user.id,
        );
      }

      for (const [idx, { it, med }] of meds.entries()) {
        const item = run(
          'INSERT INTO prescription_items (prescription_id, item_ref, medicine_id, directions, quantity, repeats_authorised, period_days, dose_units, doses_per_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          rxId, String(it.itemRef ?? idx + 1), med.id, it.directions, Number(it.quantity), Number(it.repeats ?? 0), it.periodDays ?? null,
          it.doseUnits ?? null, it.dosesPerDay ?? null,
        );
        run(
          "INSERT INTO dispense_jobs (item_id, sequence, quantity, state) VALUES (?, 0, ?, 'queued')",
          Number(item.lastInsertRowid), Number(it.quantity),
        );
      }
      audit.record({ userId: user.id, action: 'prescription.received', entity: 'prescription', entityId: rxId, data: { source: canon.source, externalId: canon.externalId ?? null, sourceHash: payloadHash, documentHash: doc?.hash ?? null } });
      return getPrescription(rxId);
    });
  }

  async function intakeFromSource(sourceName, rawId, user) {
    const source = adapters.scriptSources[sourceName];
    if (!source) throw new DomainError(`Unknown script source "${sourceName}"`);
    const id = sourceName === 'nzeps' ? assertScid(rawId) : String(rawId);
    // Keep the script byte-for-byte as the source returned it; work on a parsed copy.
    const raw = JSON.stringify(await source.fetch(id));
    const canon = JSON.parse(raw);
    canon.externalId ??= id;
    canon.source ??= sourceName;
    return afterIntake(await ingest(canon, user, { sourcePayload: raw }));
  }

  async function intakeManual(canon, user) {
    const source = canon.source ?? 'paper';
    if (!['paper', 'signature_exempt', 'fax', 'phone', 'other'].includes(source)) {
      throw new DomainError(`Unsupported manual source "${source}"`);
    }
    // A paper copy of an e-script still carries an SCID; keep it so the broker can be updated.
    const externalId = canon.externalId ? assertScid(canon.externalId) : null;
    const { document, ...keyed } = canon;
    return afterIntake(await ingest({ ...keyed, source, externalId }, user, {
      document,
      // A verbal (phone) order has no document; everything written down must come with its original.
      requireDocument: ['paper', 'signature_exempt', 'fax'].includes(source),
    }));
  }

  /** Run post-commit pipeline hooks; a hook failure is logged, never undoes the committed work. */
  async function runHook(name, ...args) {
    if (!hooks[name]) return;
    try { await hooks[name](...args); } catch (err) {
      audit.record({ action: `hook.${name}.failed`, entity: 'system', data: { error: err.message } });
    }
  }
  async function afterIntake(rx) {
    await runHook('afterIntake', rx);
    return getPrescription(rx.id);
  }

  // ───────────────────────── repeats ─────────────────────────

  function requestRepeat(itemId, user) {
    if (!user) throw new DomainError('Sign in required', { status: 401 });
    return tx(db, () => {
      const item = one('SELECT * FROM prescription_items WHERE id = ?', Number(itemId));
      if (!item) throw notFound('Prescription item', itemId);
      if (item.status !== 'active') throw conflict(`Item is ${item.status}; no repeats left to dispense`);
      const open = one(
        `SELECT id FROM dispense_jobs WHERE item_id = ? AND state IN (${OPEN_JOB_STATES.map(() => '?').join(',')})`,
        item.id, ...OPEN_JOB_STATES,
      );
      if (open) throw conflict('This item already has a supply in progress', { jobId: open.id });
      if (item.dispensings_count >= item.repeats_authorised + 1) throw conflict('All authorised supplies have been dispensed');
      const seq = one('SELECT COALESCE(MAX(sequence), -1) + 1 AS n FROM dispense_jobs WHERE item_id = ?', item.id).n;
      const r = run("INSERT INTO dispense_jobs (item_id, sequence, quantity, state) VALUES (?, ?, ?, 'queued')", item.id, seq, item.quantity);
      const jobId = Number(r.lastInsertRowid);
      audit.record({ userId: user.id, action: 'job.repeat_requested', entity: 'job', entityId: jobId, data: { itemId: item.id, sequence: seq } });
      return getJob(jobId, user);
    });
  }

  // ───────────────────────── clinical screening ─────────────────────────

  function screeningContext(job) {
    const pat = patient(job.patient_id);
    const otherMeds = all(
      `SELECT DISTINCT m.ingredient, m.name, m.therapeutic_class,
              CASE WHEN j.state IN ('released','completed') THEN 'supplied in last 90 days' ELSE 'in the dispensing queue' END AS source
       FROM dispense_jobs j
       JOIN prescription_items i ON i.id = j.item_id
       JOIN prescriptions p ON p.id = i.prescription_id
       JOIN medicines m ON m.id = i.medicine_id
       WHERE p.patient_id = ? AND j.id <> ? AND i.id <> ?
         AND (j.state IN (${OPEN_JOB_STATES.map(() => '?').join(',')})
              OR (j.state IN ('released','completed') AND j.updated_at >= datetime('now','-90 days')))`,
      job.patient_id, job.id, job.item_id, ...OPEN_JOB_STATES,
    );
    for (const ext of JSON.parse(pat.external_meds || '[]')) {
      const e = typeof ext === 'string' ? { ingredient: ext } : ext;
      otherMeds.push({ ingredient: e.ingredient, name: e.name ?? e.ingredient, therapeutic_class: e.therapeutic_class ?? null, source: e.source ?? 'medication history' });
    }
    const prev = one(
      "SELECT updated_at FROM dispense_jobs WHERE item_id = ? AND sequence < ? AND state IN ('released','completed') ORDER BY sequence DESC LIMIT 1",
      job.item_id, job.sequence,
    );
    return {
      medicine: medicine(job.medicine_id),
      item: one('SELECT * FROM prescription_items WHERE id = ?', job.item_id),
      patient: pat,
      otherMeds,
      lastRelease: prev ? { at: prev.updated_at.replace(' ', 'T') + 'Z', periodDays: job.period_days } : null,
    };
  }

  /** Past supplies for this patient (for duration-of-therapy checks). */
  function supplyHistory(patientId, excludeJobId) {
    return all(
      `SELECT m.ingredient, j.updated_at AS supplied_at, j.quantity_supplied, i.dose_units, i.doses_per_day, i.period_days
       FROM dispense_jobs j JOIN prescription_items i ON i.id = j.item_id
       JOIN prescriptions p ON p.id = i.prescription_id JOIN medicines m ON m.id = i.medicine_id
       WHERE p.patient_id = ? AND j.id <> ? AND j.state IN ('released','completed') ORDER BY j.updated_at`,
      patientId, excludeJobId,
    ).map((r) => ({ ...r, supplied_at: r.supplied_at.replace(' ', 'T') + 'Z' }));
  }

  function ruleFindings(job) {
    const ctx = screeningContext(job);
    const meds = all('SELECT * FROM medicines');
    const findings = [...screen(ctx), ...lasaFindings(ctx.medicine, meds)].map((f) => ({ ...f, origin: 'rules' }));
    if (hooks.formulary) {
      try {
        const history = hooks.formulary.buildHistory ? hooks.formulary.buildHistory(supplyHistory(job.patient_id, job.id)) : [];
        const extra = hooks.formulary.check({ ...ctx, history });
        if (extra && typeof extra.then === 'function') throw new Error('formulary.check must be synchronous');
        // Formulary findings sit alongside rules; never replace them. Skip exact duplicates by id.
        const ids = new Set(findings.map((f) => f.id));
        for (const f of extra ?? []) if (!ids.has(f.id)) findings.push({ ...f, origin: 'formulary' });
      } catch (err) {
        findings.push({ id: 'nzf_error:check', code: 'NZF_ERROR', severity: 'moderate', specialist: 'pharma', origin: 'formulary', message: `Formulary check unavailable: ${err.message}. Rules-only screening applies; check the formulary manually.`, trace: { inputs: {}, rule: 'Formulary adapter error', source: 'formulary' } });
      }
    }
    return { ctx, findings };
  }

  /** Strip direct identifiers before anything leaves the system. */
  function deidentify(ctx, rules) {
    const age = ctx.patient.dob ? Math.floor((Date.now() - Date.parse(ctx.patient.dob)) / 31_557_600_000) : null;
    return {
      age_band: age == null ? 'unknown' : `${Math.floor(age / 10) * 10}-${Math.floor(age / 10) * 10 + 9}`,
      egfr: ctx.patient.egfr,
      weight_kg: ctx.patient.weight_kg,
      hepatic_impairment: !!ctx.patient.hepatic_impairment,
      allergies: JSON.parse(ctx.patient.allergies || '[]'),
      preferred_language: ctx.patient.preferred_language,
      new_item: {
        medicine: ctx.medicine.name, ingredient: ctx.medicine.ingredient, strength: ctx.medicine.strength, form: ctx.medicine.form,
        directions: ctx.item.directions, quantity: ctx.item.quantity, dose_units: ctx.item.dose_units, doses_per_day: ctx.item.doses_per_day,
        repeats: ctx.item.repeats_authorised,
      },
      medication_list: ctx.otherMeds.map((m) => ({ ingredient: m.ingredient, name: m.name, source: m.source })),
      rule_findings: rules.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    };
  }

  function normaliseAiFindings(list, reviewerName) {
    return (list ?? []).map((f, i) => ({
      id: `ai:${String(f.code || 'note').toLowerCase()}:${i}`,
      code: f.code || 'AI_NOTE',
      severity: ['high', 'moderate', 'info'].includes(f.severity) ? f.severity : 'moderate', // AI can never raise a hard stop
      specialist: ['pharma', 'pharmacology', 'regulatory', 'advocacy'].includes(f.specialist) ? f.specialist : 'pharma',
      message: f.message,
      origin: 'ai',
      trace: { inputs: 'De-identified case (see screening record)', rule: f.reasoning, source: (f.sources ?? []).join('; ') || 'AI reviewer', reviewer: reviewerName },
    }));
  }

  /** Full screening: deterministic rules + AI reviewer. Stores a pending screening awaiting pharmacist sign-off. */
  async function runScreening(jobId, user, { useAi = true } = {}) {
    if (!user) throw new DomainError('Sign in required', { status: 401 });
    const job = loadJob(jobId);
    if (!['queued', 'entered'].includes(job.state)) throw conflict(`Screening runs before the clinical check (job is ${job.state})`);
    // Network-backed formulary sources fill their cache here (async), so the
    // synchronous checks at sign-off read the same data.
    if (hooks.formulary?.prefetch) {
      const pre = screeningContext(job);
      try { await hooks.formulary.prefetch([pre.medicine, ...pre.otherMeds]); } catch { /* falls back to local data; noted in findings */ }
    }
    const { ctx, findings: rules } = ruleFindings(job);
    const reviewer = useAi ? adapters.reviewer : null;
    let ai = { findings: [], counselling: null };
    let reviewerNote = null;
    if (reviewer) {
      try {
        ai = await reviewer.review(deidentify(ctx, rules));
        reviewerNote = ai.note ?? null;
      } catch (err) {
        reviewerNote = `AI reviewer unavailable: ${err.message}. Rules-only screening applies.`;
      }
    }
    const findings = sortFindings([
      ...rules,
      ...normaliseAiFindings(ai.findings, reviewer?.name),
      ...(reviewerNote ? [{ id: 'ai:status', code: 'AI_STATUS', severity: 'info', specialist: 'pharma', origin: 'ai', message: reviewerNote, trace: { inputs: {}, rule: 'Reviewer status', source: reviewer?.name ?? 'none' } }] : []),
    ]);
    return tx(db, () => {
      run("UPDATE screenings SET status = 'superseded' WHERE job_id = ? AND status = 'pending'", job.id);
      const r = run(
        'INSERT INTO screenings (job_id, rules_version, reviewer, findings, counselling) VALUES (?, ?, ?, ?, ?)',
        job.id, RULES_VERSION, reviewer?.name ?? 'none', JSON.stringify(findings), ai.counselling ? JSON.stringify(ai.counselling) : null,
      );
      const id = Number(r.lastInsertRowid);
      audit.record({ userId: user.id, action: 'screening.run', entity: 'job', entityId: job.id, data: { screeningId: id, reviewer: reviewer?.name, counts: countBy(findings, 'severity') } });
      return getScreening(id);
    });
  }

  function getScreening(id) {
    const s = one('SELECT * FROM screenings WHERE id = ?', id);
    if (!s) return null;
    return { ...s, findings: JSON.parse(s.findings), counselling: s.counselling ? JSON.parse(s.counselling) : null, decisions: s.decisions ? JSON.parse(s.decisions) : null };
  }

  const latestScreening = (jobId) => {
    const r = one("SELECT id FROM screenings WHERE job_id = ? AND status <> 'superseded' ORDER BY id DESC LIMIT 1", jobId);
    return r ? getScreening(r.id) : null;
  };

  /** Rules are always re-run at sign-off so the safety floor reflects the current medication list. */
  function findingsForSignOff(job) {
    const rules = ruleFindings(job).findings;
    const stored = latestScreening(job.id);
    const ai = stored?.status === 'pending' ? stored.findings.filter((f) => f.origin === 'ai') : [];
    return { stored, findings: sortFindings([...rules, ...ai]) };
  }

  function overridesLog() {
    const rows = all(
      `SELECT s.*, u.name AS pharmacist, m.name AS medicine, pa.name AS patient_name
       FROM screenings s
       JOIN users u ON u.id = s.signed_off_by
       JOIN dispense_jobs j ON j.id = s.job_id
       JOIN prescription_items i ON i.id = j.item_id
       JOIN medicines m ON m.id = i.medicine_id
       JOIN prescriptions p ON p.id = i.prescription_id
       JOIN patients pa ON pa.id = p.patient_id
       WHERE s.status = 'signed_off' ORDER BY s.id DESC LIMIT 500`,
    );
    const out = [];
    for (const r of rows) {
      const findings = JSON.parse(r.findings);
      const decisions = JSON.parse(r.decisions || '{}');
      for (const f of findings) {
        const d = decisions[f.id];
        if (d && ['hard_stop', 'high'].includes(f.severity)) {
          out.push({ screeningId: r.id, jobId: r.job_id, at: r.signed_off_at, pharmacist: r.pharmacist, patient: r.patient_name, medicine: r.medicine, severity: f.severity, origin: f.origin, code: f.code, message: f.message, action: d.action, reason: d.reason ?? d.note ?? null, prescriberConfirmed: !!d.prescriberConfirmed });
        }
      }
    }
    return out;
  }

  // ───────────────────────── fulfilment helpers ─────────────────────────

  function attachFulfilment(job, { method = 'pickup', address, scheduledFor }) {
    if (!['pickup', 'delivery', 'courier', 'compliance_pack'].includes(method)) {
      throw new DomainError(`Unknown fulfilment method "${method}"`);
    }
    const pat = patient(job.patient_id);
    const addr = method === 'pickup' ? null : (address || pat.address);
    if (['delivery', 'courier'].includes(method) && !addr) throw new DomainError('Delivery address required');
    let f = one(
      "SELECT * FROM fulfilments WHERE patient_id = ? AND method = ? AND status = 'open' AND tracking_ref IS NULL ORDER BY id DESC LIMIT 1",
      job.patient_id, method,
    );
    if (!f) {
      const r = run(
        'INSERT INTO fulfilments (patient_id, method, address, scheduled_for, pickup_code) VALUES (?, ?, ?, ?, ?)',
        job.patient_id, method, addr, scheduledFor ?? null, newPickupCode(),
      );
      f = one('SELECT * FROM fulfilments WHERE id = ?', Number(r.lastInsertRowid));
    }
    return f.id;
  }

  // ───────────────────────── manual edits to the script ─────────────────────────

  const EDITABLE = {
    directions: { col: 'directions', parse: (v) => String(v ?? '').trim(), ok: (v) => v.length > 0, err: 'Directions cannot be empty' },
    quantity: { col: 'quantity', parse: Number, ok: (v) => Number.isInteger(v) && v > 0, err: 'Quantity must be a positive whole number' },
    repeats: { col: 'repeats_authorised', parse: Number, ok: (v) => Number.isInteger(v) && v >= 0 && v <= 12, err: 'Repeats must be a whole number from 0 to 12' },
    doseUnits: { col: 'dose_units', parse: (v) => (v === '' || v == null ? null : Number(v)), ok: (v) => v == null || (v > 0 && v <= 100), err: 'Units per dose must be a positive number' },
    dosesPerDay: { col: 'doses_per_day', parse: (v) => (v === '' || v == null ? null : Number(v)), ok: (v) => v == null || (v > 0 && v <= 24), err: 'Doses per day must be between 0 and 24' },
    periodDays: { col: 'period_days', parse: (v) => (v === '' || v == null ? null : Number(v)), ok: (v) => v == null || (Number.isInteger(v) && v > 0 && v <= 365), err: 'Supply period must be 1 to 365 days' },
  };

  /**
   * Apply manual edits to the dispensing record (never to the stored original).
   * Every change needs a reason, keeps its before/after, is audited, and shows as a
   * difference against the original at the clinical check. Must run inside a transaction.
   */
  function applyAmendments(job, input, user, auditAction) {
    if (!input) return {};
    const item = one('SELECT i.*, m.controlled_class, m.name AS medicine_name FROM prescription_items i JOIN medicines m ON m.id = i.medicine_id WHERE i.id = ?', job.item_id);
    const changes = {};
    for (const [key, def] of Object.entries(EDITABLE)) {
      if (input[key] === undefined) continue;
      const to = def.parse(input[key]);
      if (!def.ok(to) || Number.isNaN(to)) throw new DomainError(def.err);
      const from = item[def.col];
      if (String(from ?? '') !== String(to ?? '')) changes[key] = { from, to };
    }
    if (!Object.keys(changes).length) return {};
    if (!input.reason?.trim()) throw new DomainError('Give a reason for changing the script');
    if (changes.repeats && item.controlled_class === 'B' && changes.repeats.to > 0) {
      throw new DomainError(`${item.medicine_name}: Class B controlled drugs cannot carry repeats`);
    }
    if (changes.repeats && changes.repeats.to + 1 < item.dispensings_count + 1) {
      throw new DomainError('Repeats cannot be reduced below supplies already made');
    }
    const log = JSON.parse(item.amendments || '[]');
    log.push({ changes, reason: input.reason.trim(), by: user.id, byName: user.name, at: new Date().toISOString() });
    const cols = Object.entries(changes).map(([k]) => EDITABLE[k].col);
    run(
      `UPDATE prescription_items SET ${cols.map((c) => `${c} = ?`).join(', ')}, amendments = ? WHERE id = ?`,
      ...Object.values(changes).map((c) => c.to), JSON.stringify(log), item.id,
    );
    audit.record({ userId: user.id, action: auditAction, entity: 'job', entityId: job.id, data: { changes, reason: input.reason.trim() } });
    return changes;
  }

  /** Edit the script before the clinical check, then re-screen so flags reflect the edit. */
  async function amend(jobId, user, input = {}) {
    if (!user || !['technician', 'pharmacist', 'admin'].includes(user.role)) throw forbidden('Only dispensary staff can edit a script');
    const changes = tx(db, () => {
      const job = loadJob(jobId);
      if (!['queued', 'entered'].includes(job.state)) {
        throw conflict(`Scripts can only be edited before the clinical check (this one is ${job.state.replace('_', ' ')}). Put it on hold and ask a pharmacist.`);
      }
      const c = applyAmendments(job, input, user, 'item.amended');
      if (c.quantity) run("UPDATE dispense_jobs SET quantity = ?, updated_at = datetime('now') WHERE id = ?", c.quantity.to, job.id);
      return c;
    });
    if (!Object.keys(changes).length) throw new DomainError('Nothing changed');
    // Fresh screening on the edited script (the previous one is superseded).
    if (loadJob(jobId).state === 'entered') await runScreening(jobId, user);
    await runHook('afterTransition', Number(jobId), 'amend', user);
    return getJob(jobId, user);
  }

  // ───────────────────────── workflow transitions ─────────────────────────

  async function transition(jobId, action, user, body = {}) {
    const brokerUpdates = [];
    const result = tx(db, () => {
      const job = loadJob(jobId);
      const to = planTransition(job, action, user);
      const set = { state: to };

      switch (action) {
        case 'enter': {
          set.entered_by = user.id;
          // Data entry may amend the script (e.g. to match a subsidy pack). See applyAmendments.
          const changes = applyAmendments(job, body.amend, user, 'item.amended_at_entry');
          if (changes.quantity) set.quantity = changes.quantity.to;
          break;
        }

        case 'clinical_check': {
          const { stored, findings } = findingsForSignOff(job);
          const decisions = { ...(body.decisions ?? {}) };
          if (body.acknowledge === true) {
            // Shorthand: acknowledge every "high" finding with one note. Hard stops still need explicit overrides.
            for (const f of findings) if (f.severity === 'high' && !decisions[f.id]) decisions[f.id] = { action: 'acknowledge', note: body.note ?? null };
          }
          const problem = validateDecisions(findings, decisions);
          if (problem) throw conflict(problem, { warnings: findings, findings, screeningId: stored?.id ?? null });
          if (body.sourceVerified !== true) {
            throw conflict('Confirm you have checked the script against the original as received', { needsSourceCheck: true });
          }
          const original = originalFor(job.prescription_id, job.item_id);
          if (!original.intact || original.documents.some((d) => !d.intact)) {
            throw conflict('The stored original script failed its integrity check: do not dispense; investigate', { integrity: false });
          }

          let screeningId = stored?.status === 'pending' ? stored.id : null;
          if (screeningId) {
            run('UPDATE screenings SET findings = ? WHERE id = ?', JSON.stringify(findings), screeningId);
          } else {
            screeningId = Number(run(
              "INSERT INTO screenings (job_id, rules_version, reviewer, findings) VALUES (?, ?, 'none (rules only)', ?)",
              job.id, RULES_VERSION, JSON.stringify(findings),
            ).lastInsertRowid);
          }
          run(
            "UPDATE screenings SET status = 'signed_off', decisions = ?, signed_off_by = ?, signed_off_at = datetime('now') WHERE id = ?",
            JSON.stringify(decisions), user.id, screeningId,
          );
          for (const f of findings) {
            if (f.severity === 'hard_stop') {
              audit.record({ userId: user.id, action: 'screening.hard_stop_override', entity: 'job', entityId: job.id, data: { finding: f.code, message: f.message, ...decisions[f.id] } });
            }
          }
          set.clinical_checked_by = user.id;
          set.warnings_acknowledged = JSON.stringify({ screeningId, warnings: findings, decisions, note: body.note ?? null, by: user.id, sourceVerified: { by: user.id, at: new Date().toISOString(), differences: original.compare.filter((c) => !c.match).map((c) => c.field) } });
          audit.record({ userId: user.id, action: 'job.source_verified', entity: 'job', entityId: job.id, data: { sourceHash: original.hash, differences: original.compare.filter((c) => !c.match).map((c) => c.field) } });
          break;
        }

        case 'assemble': {
          const available = onHand(job.medicine_id);
          const supply = Math.min(available, job.quantity);
          if (supply === 0) throw conflict('No stock on hand — order stock or place the job on hold');
          moveStock(job.medicine_id, -supply, { reason: `Dispensed Rx ${job.id}-${job.sequence}`, jobId: job.id, userId: user.id, kind: 'dispensed' });
          set.quantity_supplied = supply;
          set.owing = job.quantity - supply;
          set.assembled_by = user.id;
          set.label_text = buildLabel({
            pharmacy: config.pharmacy,
            patient: patient(job.patient_id),
            medicine: medicine(job.medicine_id),
            prescriber: prescriber(job.prescriber_id),
            item: job,
            job: { ...job, quantity_supplied: supply, owing: job.quantity - supply },
          });
          break;
        }

        case 'final_check': {
          if (!config.allowSelfCheck && job.assembled_by === user.id) {
            throw forbidden('Final check must be done by a different person from the one who assembled it');
          }
          set.final_checked_by = user.id;
          set.label_text = job.label_text.replace('Checked: __', `Checked: ${user.initials}`);
          break;
        }

        case 'release': {
          set.fulfilment_id = attachFulfilment(job, body);
          const count = job.dispensings_count + 1;
          const remaining = job.repeats_authorised + 1 - count;
          run(
            'UPDATE prescription_items SET dispensings_count = ?, status = ? WHERE id = ?',
            count, remaining > 0 ? 'active' : 'completed', job.item_id,
          );
          const openItems = one(
            "SELECT COUNT(*) AS n FROM prescription_items WHERE prescription_id = ? AND status = 'active'",
            job.prescription_id,
          ).n;
          if (openItems === 0) run("UPDATE prescriptions SET status = 'completed' WHERE id = ?", job.prescription_id);

          const med = medicine(job.medicine_id);
          const pat = patient(job.patient_id);
          const doc = prescriber(job.prescriber_id);
          run(
            `INSERT INTO claims (job_id, patient_nhi, prescriber_cpn, medicine_code, quantity, subsidy_cents, patient_charge_cents)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            job.id, pat.nhi, doc.hpi_cpn, med.code, job.quantity_supplied,
            Math.round((med.subsidy_cents * job.quantity_supplied) / med.pack_size), med.patient_charge_cents,
          );
          if (job.scid) {
            brokerUpdates.push({ source: job.source, scid: job.scid, itemRef: job.item_ref, sequence: job.sequence, remainingRepeats: remaining });
          }
          break;
        }

        case 'hold':
          if (!body.reason) throw new DomainError('A reason is required to place a job on hold');
          set.held_from = job.state;
          set.hold_reason = body.reason;
          break;

        case 'resume':
          set.held_from = null;
          set.hold_reason = null;
          break;

        case 'cancel': {
          if (!body.reason) throw new DomainError('A reason is required to cancel');
          const heldStock = STOCK_HELD_STATES.includes(job.state) || STOCK_HELD_STATES.includes(job.held_from);
          if (heldStock && job.quantity_supplied > 0) {
            moveStock(job.medicine_id, job.quantity_supplied, { reason: `Returned to stock: cancelled Rx ${job.id}-${job.sequence}`, jobId: job.id, userId: user.id, kind: 'returned' });
          }
          set.hold_reason = body.reason;
          break;
        }
      }

      const cols = Object.keys(set);
      run(
        `UPDATE dispense_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...cols.map((c) => set[c]), job.id,
      );
      audit.record({ userId: user.id, action: `job.${action}`, entity: 'job', entityId: job.id, data: { from: job.state, to, ...pick(body, ['reason', 'note', 'method']) } });
      return job.id;
    });

    // Broker calls happen after commit so a slow/failed network call can't
    // leave the local record half-written. A failure is logged for retry.
    for (const u of brokerUpdates) {
      try {
        await adapters.scriptSources[u.source]?.markDispensed(u.scid, u);
      } catch (err) {
        audit.record({ userId: user.id, action: 'broker.update_failed', entity: 'job', entityId: result, data: { error: err.message, ...u } });
      }
    }
    await runHook('afterTransition', result, action, user);
    return getJob(result, user);
  }

  function supplyOwing(jobId, user) {
    if (!user || !['pharmacist', 'technician', 'admin'].includes(user.role)) throw forbidden('Not permitted');
    return tx(db, () => {
      const job = loadJob(jobId);
      if (!job.owing) throw conflict('Nothing owing on this job');
      if (!['assembled', 'checked', 'released', 'completed'].includes(job.state)) throw conflict(`Cannot supply owing in state "${job.state}"`);
      const supply = Math.min(onHand(job.medicine_id), job.owing);
      if (supply === 0) throw conflict('Still no stock on hand');
      moveStock(job.medicine_id, -supply, { reason: `Owing supplied Rx ${job.id}-${job.sequence}`, jobId: job.id, userId: user.id, kind: 'dispensed' });
      run(
        "UPDATE dispense_jobs SET quantity_supplied = quantity_supplied + ?, owing = owing - ?, updated_at = datetime('now') WHERE id = ?",
        supply, supply, job.id,
      );
      run('UPDATE claims SET quantity = quantity + ? WHERE job_id = ? AND status = \'pending\'', supply, job.id);
      audit.record({ userId: user.id, action: 'job.owing_supplied', entity: 'job', entityId: job.id, data: { supplied: supply, stillOwing: job.owing - supply } });
      return getJob(job.id, user);
    });
  }

  // ───────────────────────── fulfilment ─────────────────────────

  function getFulfilment(id) {
    const f = one(
      'SELECT f.*, p.name AS patient_name, p.nhi FROM fulfilments f JOIN patients p ON p.id = f.patient_id WHERE f.id = ?',
      Number(id),
    );
    if (!f) throw notFound('Fulfilment', id);
    f.jobs = all(
      `SELECT j.id, j.sequence, j.state, j.quantity_supplied, j.owing, m.name AS medicine, m.strength, m.controlled_class
       FROM dispense_jobs j JOIN prescription_items i ON i.id = j.item_id JOIN medicines m ON m.id = i.medicine_id
       WHERE j.fulfilment_id = ? ORDER BY j.id`,
      f.id,
    );
    f.ready = f.jobs.length > 0 && f.jobs.every((j) => ['released', 'completed'].includes(j.state));
    f.hasControlled = f.jobs.some((j) => j.controlled_class);
    return f;
  }

  function listFulfilments({ status } = {}) {
    const ids = status
      ? all('SELECT id FROM fulfilments WHERE status = ? ORDER BY id DESC', status)
      : all("SELECT id FROM fulfilments ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'out_for_delivery' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, id DESC LIMIT 200");
    return ids.map((r) => getFulfilment(r.id));
  }

  async function fulfilmentAction(id, action, user, body = {}) {
    if (!user) throw new DomainError('Sign in required', { status: 401 });
    const f = getFulfilment(id);
    let booking = null;

    if (action === 'dispatch') {
      if (!['delivery', 'courier'].includes(f.method)) throw conflict('Only delivery or courier fulfilments can be dispatched');
      if (f.status !== 'open') throw conflict(`Fulfilment is ${f.status}`);
      if (!f.ready) throw conflict('Not every item in this order has been released yet');
      booking = f.method === 'courier'
        ? await adapters.couriers[body.provider ?? 'default'].book(f)
        : { provider: 'in-house', trackingRef: `DRV-${f.id}` };
    }

    const out = tx(db, () => {
      const cur = getFulfilment(id); // re-read inside the transaction
      switch (action) {
        case 'dispatch':
          run("UPDATE fulfilments SET status = 'out_for_delivery', provider = ?, tracking_ref = ? WHERE id = ?", booking.provider, booking.trackingRef, cur.id);
          break;
        case 'complete': {
          const okFrom = ['pickup', 'compliance_pack'].includes(cur.method) ? ['open'] : ['out_for_delivery'];
          if (!okFrom.includes(cur.status)) throw conflict(`Cannot complete a ${cur.method} fulfilment that is ${cur.status}`);
          if (!cur.ready) throw conflict('Not every item in this order has been released yet');
          if (cur.hasControlled && !body.proof) throw new DomainError('Controlled drugs: record who collected/received the medicine (proof)');
          run("UPDATE fulfilments SET status = 'completed', proof = ?, completed_at = datetime('now') WHERE id = ?", body.proof ?? null, cur.id);
          for (const j of cur.jobs) {
            if (j.state === 'released') {
              planTransition({ state: 'released' }, 'complete', user);
              run("UPDATE dispense_jobs SET state = 'completed', updated_at = datetime('now') WHERE id = ?", j.id);
            }
          }
          break;
        }
        case 'fail':
          if (cur.status !== 'out_for_delivery') throw conflict('Only an out-for-delivery fulfilment can fail');
          if (!body.reason) throw new DomainError('A reason is required');
          run("UPDATE fulfilments SET status = 'failed', proof = ? WHERE id = ?", `FAILED: ${body.reason}`, cur.id);
          break;
        case 'retry':
          if (cur.status !== 'failed') throw conflict('Only a failed fulfilment can be retried');
          run("UPDATE fulfilments SET status = 'open', tracking_ref = NULL, provider = NULL WHERE id = ?", cur.id);
          break;
        default:
          throw new DomainError(`Unknown fulfilment action "${action}"`);
      }
      audit.record({ userId: user.id, action: `fulfilment.${action}`, entity: 'fulfilment', entityId: cur.id, data: { ...pick(body, ['reason', 'proof']), ...(booking ?? {}) } });
      return getFulfilment(cur.id);
    });
    await runHook('afterFulfilment', out.id, action, user);
    return getFulfilment(out.id);
  }

  // ───────────────────────── claims ─────────────────────────

  function listClaims({ status } = {}) {
    return status
      ? all('SELECT * FROM claims WHERE status = ? ORDER BY id DESC', status)
      : all('SELECT * FROM claims ORDER BY id DESC LIMIT 500');
  }

  async function submitClaims(user) {
    if (!user || !['pharmacist', 'admin'].includes(user.role)) throw forbidden('Only a pharmacist or admin can submit claims');
    const pending = listClaims({ status: 'pending' });
    if (!pending.length) return { batchRef: null, submitted: 0, accepted: 0, rejected: 0 };
    run(`UPDATE claims SET status = 'submitted' WHERE id IN (${pending.map(() => '?').join(',')})`, ...pending.map((c) => c.id));
    let res;
    try {
      res = await adapters.claims.submit(pending);
    } catch (err) {
      run(`UPDATE claims SET status = 'pending' WHERE id IN (${pending.map(() => '?').join(',')})`, ...pending.map((c) => c.id));
      throw new DomainError(`Claims gateway error: ${err.message}`, { status: 502 });
    }
    return tx(db, () => {
      for (const r of res.results) {
        run('UPDATE claims SET status = ?, batch_ref = ?, response = ? WHERE id = ?', r.accepted ? 'accepted' : 'rejected', res.batchRef, r.reason, r.claimId);
      }
      const accepted = res.results.filter((r) => r.accepted).length;
      audit.record({ userId: user.id, action: 'claims.submitted', entity: 'claim_batch', data: { batchRef: res.batchRef, count: pending.length, accepted } });
      return { batchRef: res.batchRef, submitted: pending.length, accepted, rejected: pending.length - accepted };
    });
  }

  function claimsCsv() {
    const rows = listClaims();
    const header = 'claim_id,job_id,nhi,prescriber_cpn,medicine_code,quantity,subsidy_cents,patient_charge_cents,status,batch_ref,created_at';
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [header, ...rows.map((c) => [c.id, c.job_id, c.patient_nhi, c.prescriber_cpn, c.medicine_code, c.quantity, c.subsidy_cents, c.patient_charge_cents, c.status, c.batch_ref, c.created_at].map(esc).join(','))].join('\n');
  }

  // ───────────────────────── original script ─────────────────────────

  /**
   * The script as received, an integrity check, and a field-by-field comparison
   * of the received item against what is being dispensed.
   */
  function originalFor(prescriptionId, itemId) {
    const rx = one('SELECT id, source, scid, source_payload, source_hash, created_at FROM prescriptions WHERE id = ?', prescriptionId);
    if (!rx) throw notFound('Prescription', prescriptionId);
    const received = one(
      "SELECT data FROM audit_log WHERE action = 'prescription.received' AND entity = 'prescription' AND entity_id = ? ORDER BY id LIMIT 1",
      rx.id,
    );
    const auditHash = received ? JSON.parse(received.data).sourceHash : null;
    const intact = !!rx.source_payload && sha256(rx.source_payload) === rx.source_hash && (!auditHash || auditHash === rx.source_hash);
    const documents = all('SELECT id, mime, filename, sha256, data, created_at FROM prescription_documents WHERE prescription_id = ? ORDER BY id', rx.id)
      .map((d) => ({ id: d.id, mime: d.mime, filename: d.filename, sha256: d.sha256, created_at: d.created_at, intact: sha256(d.data) === d.sha256 }));
    const kind = rx.source === 'nzeps' ? 'electronic' : documents.length ? 'document' : 'verbal';
    const payload = rx.source_payload ? JSON.parse(rx.source_payload) : null;

    let compare = [];
    let amendments = [];
    if (itemId) {
      const item = one('SELECT i.*, m.code, m.name, m.strength FROM prescription_items i JOIN medicines m ON m.id = i.medicine_id WHERE i.id = ?', itemId);
      amendments = JSON.parse(item.amendments || '[]');
      const src = payload?.items?.find((x, i) => String(x.itemRef ?? i + 1) === String(item.item_ref));
      if (src) {
        const dose = (u, d) => (u && d ? `${u} × ${d}/day` : '—');
        compare = [
          ['Medicine', src.medicineCode, item.code, `${item.name} ${item.strength}`],
          ['Directions', src.directions, item.directions],
          ['Quantity', String(src.quantity), String(item.quantity)],
          ['Repeats', String(src.repeats ?? 0), String(item.repeats_authorised)],
          ['Dose', dose(src.doseUnits, src.dosesPerDay), dose(item.dose_units, item.doses_per_day)],
          ['Supply period', src.periodDays ? `${src.periodDays} days` : '—', item.period_days ? `${item.period_days} days` : '—'],
        ].map(([field, rec, disp, label]) => ({ field, received: rec ?? '—', dispensing: label ?? disp ?? '—', match: String(rec ?? '').trim() === String(disp ?? '').trim() }));
      }
    }
    return {
      kind, source: rx.source, scid: rx.scid, receivedAt: rx.created_at, hash: rx.source_hash, intact,
      // For manual scripts the payload is what staff keyed; the document is the original.
      payloadRole: kind === 'electronic' ? 'as received from the e-prescription service' : 'as keyed at intake',
      payload, documents, compare, amendments,
    };
  }

  function getDocument(prescriptionId, docId) {
    const d = one('SELECT * FROM prescription_documents WHERE id = ? AND prescription_id = ?', Number(docId), Number(prescriptionId));
    if (!d) throw notFound('Document', docId);
    return d;
  }

  // ───────────────────────── reorder ─────────────────────────

  /**
   * Draft a wholesaler order: every line at or below its reorder point, topped
   * up to par level (or 30 days of recent usage, if higher), rounded up to
   * whole packs. A draft only; a person reviews and sends it.
   */
  function reorderDraft() {
    const meds = all('SELECT m.*, COALESCE(s.on_hand, 0) AS on_hand FROM medicines m LEFT JOIN stock s ON s.medicine_id = m.id ORDER BY m.name');
    const lines = [];
    for (const m of meds) {
      if (m.on_hand > m.reorder_point) continue;
      const used30 = -(one(
        "SELECT COALESCE(SUM(change), 0) AS n FROM stock_ledger WHERE medicine_id = ? AND change < 0 AND kind IN ('dispensed','sold') AND at >= datetime('now','-30 days')",
        m.id,
      ).n);
      const target = Math.max(m.par_level, used30);
      const need = Math.max(target - m.on_hand, 1);
      const packs = Math.ceil(need / m.pack_size);
      lines.push({ medicineId: m.id, code: m.code, name: `${m.name} ${m.strength} ${m.form}`, onHand: m.on_hand, reorderPoint: m.reorder_point, parLevel: m.par_level, used30, packSize: m.pack_size, packs, units: packs * m.pack_size, controlled: m.controlled_class });
    }
    return { generatedAt: new Date().toISOString(), lines };
  }

  // ───────────────────────── read models ─────────────────────────

  const JOB_VIEW = `
    SELECT j.*, i.medicine_id, i.item_ref, i.directions, i.dose_units, i.doses_per_day, i.repeats_authorised, i.dispensings_count, i.period_days, i.prescription_id,
           m.name AS medicine, m.strength, m.form, m.controlled_class, m.code AS medicine_code, m.unit_mg,
           p.scid, p.source, pa.id AS patient_id, pa.name AS patient_name, pa.nhi,
           pr.name AS prescriber_name
    FROM dispense_jobs j
    JOIN prescription_items i ON i.id = j.item_id
    JOIN prescriptions p ON p.id = i.prescription_id
    JOIN patients pa ON pa.id = p.patient_id
    JOIN prescribers pr ON pr.id = p.prescriber_id
    JOIN medicines m ON m.id = i.medicine_id`;

  function getJob(id, user) {
    const job = one(`${JOB_VIEW} WHERE j.id = ?`, Number(id));
    if (!job) throw notFound('Dispense job', id);
    job.actions = availableActions(job, user);
    job.on_hand = onHand(job.medicine_id);
    job.screening = latestScreening(job.id);
    const ctx = screeningContext(loadJob(id));
    job.medication_list = ctx.otherMeds;
    job.original = originalFor(job.prescription_id, job.item_id);
    job.patient = { dob: ctx.patient.dob, egfr: ctx.patient.egfr, allergies: JSON.parse(ctx.patient.allergies || '[]'), preferred_language: ctx.patient.preferred_language };
    if (['entered', 'queued'].includes(job.state)) {
      job.warnings = findingsForSignOff(loadJob(id)).findings;
    }
    if (job.warnings_acknowledged) job.warnings_acknowledged = JSON.parse(job.warnings_acknowledged);
    return job;
  }

  function queue({ state } = {}, user) {
    const rows = state
      ? all(`${JOB_VIEW} WHERE j.state = ? ORDER BY j.created_at, j.id`, state)
      : all(`${JOB_VIEW} WHERE j.state IN (${OPEN_JOB_STATES.map(() => '?').join(',')}) ORDER BY j.created_at, j.id`, ...OPEN_JOB_STATES);
    const SEV = ['hard_stop', 'high', 'moderate', 'info'];
    return rows.map((j) => {
      let top = null;
      if (['queued', 'entered'].includes(j.state)) {
        for (const f of findingsForSignOff(loadJob(j.id)).findings) if (!top || SEV.indexOf(f.severity) < SEV.indexOf(top)) top = f.severity;
      }
      return { ...j, top_severity: top, actions: availableActions(j, user) };
    });
  }

  function getPrescription(id) {
    const rx = one(
      `SELECT p.*, pa.name AS patient_name, pa.nhi, pr.name AS prescriber_name, pr.facility_name
       FROM prescriptions p JOIN patients pa ON pa.id = p.patient_id JOIN prescribers pr ON pr.id = p.prescriber_id WHERE p.id = ?`,
      Number(id),
    );
    if (!rx) throw notFound('Prescription', id);
    rx.items = all(
      `SELECT i.*, m.name AS medicine, m.strength, m.form, m.controlled_class FROM prescription_items i
       JOIN medicines m ON m.id = i.medicine_id WHERE i.prescription_id = ? ORDER BY i.id`,
      rx.id,
    ).map((i) => ({ ...i, jobs: all('SELECT id, sequence, state, quantity_supplied, owing FROM dispense_jobs WHERE item_id = ? ORDER BY sequence', i.id) }));
    return rx;
  }

  function listPrescriptions({ q, status } = {}) {
    const where = [];
    const p = [];
    if (status) { where.push('p.status = ?'); p.push(status); }
    if (q) { where.push('(pa.name LIKE ? OR pa.nhi LIKE ? OR p.scid LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return all(
      `SELECT p.id, p.scid, p.source, p.status, p.prescribed_at, pa.name AS patient_name, pa.nhi, pr.name AS prescriber_name,
              (SELECT COUNT(*) FROM prescription_items WHERE prescription_id = p.id) AS item_count
       FROM prescriptions p JOIN patients pa ON pa.id = p.patient_id JOIN prescribers pr ON pr.id = p.prescriber_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 200`,
      ...p,
    );
  }

  /** Home screen: the single most important decision waiting, plus today's numbers. */
  function home(user) {
    const SEV = { hard_stop: 0, high: 1, moderate: 2, info: 3 };
    const candidates = [];
    for (const j of all(`${JOB_VIEW} WHERE j.state = 'entered' ORDER BY j.created_at, j.id`)) {
      const findings = findingsForSignOff(loadJob(j.id)).findings;
      const top = findings.reduce((a, f) => (!a || SEV[f.severity] < SEV[a.severity] ? f : a), null);
      candidates.push({ job: j, step: 'clinical_check', top, rank: top ? SEV[top.severity] : 4 });
    }
    for (const j of all(`${JOB_VIEW} WHERE j.state = 'assembled' ORDER BY j.created_at, j.id`)) {
      candidates.push({ job: j, step: 'final_check', top: null, rank: 5 });
    }
    candidates.sort((a, b) => a.rank - b.rank || a.job.created_at.localeCompare(b.job.created_at));
    const next = candidates[0] ?? null;

    const oldest = one(`SELECT MIN(created_at) AS t FROM dispense_jobs WHERE state IN ('queued','entered','clinically_checked','assembled','checked')`).t;
    const days = all(
      `WITH RECURSIVE d(day) AS (SELECT date('now','-13 days') UNION ALL SELECT date(day,'+1 day') FROM d WHERE day < date('now'))
       SELECT d.day, (SELECT COUNT(*) FROM dispense_jobs j WHERE date(j.created_at) = d.day) AS n FROM d`,
    );
    const signedToday = all("SELECT findings, decisions FROM screenings WHERE status = 'signed_off' AND date(signed_off_at) = date('now')");
    let hardStops = 0, overrides = 0, acknowledged = 0;
    for (const s of signedToday) {
      const f = JSON.parse(s.findings);
      const d = JSON.parse(s.decisions || '{}');
      hardStops += f.filter((x) => x.severity === 'hard_stop').length;
      overrides += Object.values(d).filter((x) => x.action === 'override').length;
      acknowledged += Object.values(d).filter((x) => x.action === 'acknowledge').length;
    }
    return {
      pharmacy: config.pharmacy.name,
      next: next && { jobId: next.job.id, step: next.step, medicine: `${next.job.medicine} ${next.job.strength}`, form: next.job.form, patient: next.job.patient_name, nhi: next.job.nhi, source: next.job.source, controlled: next.job.controlled_class, waitingSince: next.job.created_at, finding: next.top && { severity: next.top.severity, message: next.top.message, origin: next.top.origin } },
      awaitingPharmacist: candidates.length,
      inProgress: one("SELECT COUNT(*) AS n FROM dispense_jobs WHERE state IN ('queued','entered','clinically_checked','assembled','checked')").n,
      readyForCollection: one("SELECT COUNT(*) AS n FROM fulfilments WHERE status = 'open' AND method = 'pickup'").n,
      outForDelivery: one("SELECT COUNT(*) AS n FROM fulfilments WHERE status = 'out_for_delivery'").n,
      oldestWaitingSince: oldest,
      today: {
        received: one("SELECT COUNT(*) AS n FROM dispense_jobs WHERE date(created_at) = date('now')").n,
        screened: one("SELECT COUNT(*) AS n FROM screenings WHERE status <> 'superseded' AND date(created_at) = date('now')").n,
        hardStops, overrides, acknowledged,
        released: one("SELECT COUNT(*) AS n FROM dispense_jobs WHERE state IN ('released','completed') AND date(updated_at) = date('now')").n,
      },
      days,
      collections: all(
        `SELECT f.id, f.method, f.status, f.pickup_code, f.tracking_ref, p.name AS patient_name,
                (SELECT COUNT(*) FROM dispense_jobs WHERE fulfilment_id = f.id) AS items
         FROM fulfilments f JOIN patients p ON p.id = f.patient_id WHERE f.status IN ('open','out_for_delivery') ORDER BY f.id DESC LIMIT 6`,
      ),
    };
  }

  function dashboard() {
    const byState = Object.fromEntries(all('SELECT state, COUNT(*) AS n FROM dispense_jobs GROUP BY state').map((r) => [r.state, r.n]));
    return {
      jobs: byState,
      owing: one('SELECT COUNT(*) AS n FROM dispense_jobs WHERE owing > 0').n,
      fulfilments: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM fulfilments GROUP BY status').map((r) => [r.status, r.n])),
      claims: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM claims GROUP BY status').map((r) => [r.status, r.n])),
      lowStock: all(
        `SELECT m.id, m.name, m.strength, COALESCE(s.on_hand, 0) AS on_hand FROM medicines m
         LEFT JOIN stock s ON s.medicine_id = m.id WHERE COALESCE(s.on_hand, 0) < m.pack_size ORDER BY on_hand`,
      ),
    };
  }

  return {
    audit,
    getUser,
    users: () => all("SELECT * FROM users WHERE NOT (name = 'Automation' AND initials = 'AU') ORDER BY role, name"),
    medicines: () => all('SELECT m.*, COALESCE(s.on_hand, 0) AS on_hand FROM medicines m LEFT JOIN stock s ON s.medicine_id = m.id ORDER BY m.name'),
    patients: (q = '') => all('SELECT * FROM patients WHERE name LIKE ? OR nhi LIKE ? ORDER BY name LIMIT 100', `%${q}%`, `%${q}%`),
    cdRegister: (medicineId) => all(
      `SELECT c.*, m.name AS medicine, m.strength, u.name AS user_name FROM cd_register c
       JOIN medicines m ON m.id = c.medicine_id LEFT JOIN users u ON u.id = c.user_id
       ${medicineId ? 'WHERE c.medicine_id = ?' : ''} ORDER BY c.id DESC`,
      ...(medicineId ? [Number(medicineId)] : []),
    ),
    adjustStock,
    runScreening,
    amend,
    overridesLog,
    stockLedger: (medicineId) => all(
      `SELECT l.*, m.name AS medicine, m.strength FROM stock_ledger l JOIN medicines m ON m.id = l.medicine_id
       ${medicineId ? 'WHERE l.medicine_id = ?' : ''} ORDER BY l.id DESC LIMIT 500`,
      ...(medicineId ? [Number(medicineId)] : []),
    ),
    reorderDraft,
    originalFor,
    getDocument,
    _internal: { moveStock, onHand, medicine, patient, fulfilmentAction, getFulfilment, audit, one, all, run },
    intakeFromSource,
    intakeManual,
    requestRepeat,
    transition,
    supplyOwing,
    getJob,
    queue,
    getPrescription,
    listPrescriptions,
    getFulfilment,
    listFulfilments,
    fulfilmentAction,
    listClaims,
    submitClaims,
    claimsCsv,
    dashboard,
    home,
    hooks,
    supplyHistory,
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newPickupCode() {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

function countBy(list, key) {
  return list.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] ?? 0) + 1), acc), {});
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
}
