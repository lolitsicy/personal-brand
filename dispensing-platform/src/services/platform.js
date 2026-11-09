import { tx } from '../db.js';
import { assertScid } from '../domain/scid.js';
import { planTransition, availableActions } from '../domain/workflow.js';
import { clinicalWarnings } from '../domain/clinical.js';
import { buildLabel } from '../domain/label.js';
import { DomainError, notFound, forbidden, conflict } from '../domain/errors.js';
import { createAudit } from './audit.js';

const OPEN_JOB_STATES = ['queued', 'entered', 'clinically_checked', 'assembled', 'checked', 'on_hold'];
const STOCK_HELD_STATES = ['assembled', 'checked'];

export function createPlatform({ db, adapters, config }) {
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

  function moveStock(medicineId, delta, { reason, jobId = null, userId = null }) {
    const current = onHand(medicineId);
    const next = current + delta;
    if (next < 0) throw conflict(`Insufficient stock (on hand ${current}, need ${-delta})`);
    run(
      `INSERT INTO stock (medicine_id, on_hand) VALUES (?, ?)
       ON CONFLICT(medicine_id) DO UPDATE SET on_hand = excluded.on_hand`,
      medicineId,
      next,
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
      const balance = moveStock(med.id, delta, { reason: reason || 'Stock adjustment', userId: user.id });
      audit.record({ userId: user.id, action: 'stock.adjust', entity: 'medicine', entityId: med.id, data: { delta, reason, balance } });
      return { medicineId: med.id, onHand: balance };
    });
  }

  // ───────────────────────── intake ─────────────────────────

  /** Universal intake: any script source is normalised to a CanonicalPrescription first. */
  async function ingest(canon, user) {
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

      let doc = canon.prescriber.cpn ? one('SELECT * FROM prescribers WHERE hpi_cpn = ?', canon.prescriber.cpn) : null;
      if (!doc) {
        const r = run(
          'INSERT INTO prescribers (hpi_cpn, name, facility_hpi, facility_name) VALUES (?, ?, ?, ?)',
          canon.prescriber.cpn ?? null, canon.prescriber.name, canon.prescriber.facilityHpi ?? null, canon.prescriber.facilityName ?? null,
        );
        doc = prescriber(Number(r.lastInsertRowid));
      }

      const rx = run(
        'INSERT INTO prescriptions (scid, source, patient_id, prescriber_id, prescribed_at, notes) VALUES (?, ?, ?, ?, ?, ?)',
        canon.externalId ?? null, canon.source, pat.id, doc.id, canon.prescribedAt ?? new Date().toISOString().slice(0, 10), canon.notes ?? null,
      );
      const rxId = Number(rx.lastInsertRowid);

      for (const [idx, { it, med }] of meds.entries()) {
        const item = run(
          'INSERT INTO prescription_items (prescription_id, item_ref, medicine_id, directions, quantity, repeats_authorised, period_days) VALUES (?, ?, ?, ?, ?, ?, ?)',
          rxId, String(it.itemRef ?? idx + 1), med.id, it.directions, Number(it.quantity), Number(it.repeats ?? 0), it.periodDays ?? null,
        );
        run(
          "INSERT INTO dispense_jobs (item_id, sequence, quantity, state) VALUES (?, 0, ?, 'queued')",
          Number(item.lastInsertRowid), Number(it.quantity),
        );
      }
      audit.record({ userId: user.id, action: 'prescription.received', entity: 'prescription', entityId: rxId, data: { source: canon.source, externalId: canon.externalId ?? null } });
      return getPrescription(rxId);
    });
  }

  async function intakeFromSource(sourceName, rawId, user) {
    const source = adapters.scriptSources[sourceName];
    if (!source) throw new DomainError(`Unknown script source "${sourceName}"`);
    const id = sourceName === 'nzeps' ? assertScid(rawId) : String(rawId);
    const canon = await source.fetch(id);
    canon.externalId ??= id;
    canon.source ??= sourceName;
    return ingest(canon, user);
  }

  async function intakeManual(canon, user) {
    const source = canon.source ?? 'paper';
    if (!['paper', 'signature_exempt', 'fax', 'phone', 'other'].includes(source)) {
      throw new DomainError(`Unsupported manual source "${source}"`);
    }
    // A paper copy of an e-script still carries an SCID; keep it so the broker can be updated.
    const externalId = canon.externalId ? assertScid(canon.externalId) : null;
    return ingest({ ...canon, source, externalId }, user);
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

  // ───────────────────────── clinical ─────────────────────────

  function warningsFor(job) {
    const others = all(
      `SELECT m.ingredient FROM dispense_jobs j
       JOIN prescription_items i ON i.id = j.item_id
       JOIN prescriptions p ON p.id = i.prescription_id
       JOIN medicines m ON m.id = i.medicine_id
       WHERE p.patient_id = ? AND j.id <> ? AND i.id <> ?
         AND (j.state IN (${OPEN_JOB_STATES.map(() => '?').join(',')})
              OR (j.state IN ('released','completed') AND j.updated_at >= datetime('now','-90 days')))`,
      job.patient_id, job.id, job.item_id, ...OPEN_JOB_STATES,
    ).map((r) => r.ingredient);
    const prev = one(
      "SELECT updated_at FROM dispense_jobs WHERE item_id = ? AND sequence < ? AND state IN ('released','completed') ORDER BY sequence DESC LIMIT 1",
      job.item_id, job.sequence,
    );
    return clinicalWarnings({
      medicine: medicine(job.medicine_id),
      patient: patient(job.patient_id),
      otherIngredients: others,
      lastRelease: prev ? { at: prev.updated_at.replace(' ', 'T') + 'Z', periodDays: job.period_days } : null,
    });
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
        'INSERT INTO fulfilments (patient_id, method, address, scheduled_for) VALUES (?, ?, ?, ?)',
        job.patient_id, method, addr, scheduledFor ?? null,
      );
      f = one('SELECT * FROM fulfilments WHERE id = ?', Number(r.lastInsertRowid));
    }
    return f.id;
  }

  // ───────────────────────── workflow transitions ─────────────────────────

  async function transition(jobId, action, user, body = {}) {
    const brokerUpdates = [];
    const result = tx(db, () => {
      const job = loadJob(jobId);
      const to = planTransition(job, action, user);
      const set = { state: to };

      switch (action) {
        case 'enter':
          set.entered_by = user.id;
          break;

        case 'clinical_check': {
          const warnings = warningsFor(job);
          const high = warnings.filter((w) => w.severity === 'high');
          if (high.length && body.acknowledge !== true) {
            throw conflict('Clinical warnings must be reviewed and acknowledged', { warnings });
          }
          set.clinical_checked_by = user.id;
          set.warnings_acknowledged = JSON.stringify({ warnings, note: body.note ?? null, by: user.id });
          break;
        }

        case 'assemble': {
          const available = onHand(job.medicine_id);
          const supply = Math.min(available, job.quantity);
          if (supply === 0) throw conflict('No stock on hand — order stock or place the job on hold');
          moveStock(job.medicine_id, -supply, { reason: `Dispensed Rx ${job.id}-${job.sequence}`, jobId: job.id, userId: user.id });
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
            moveStock(job.medicine_id, job.quantity_supplied, { reason: `Returned to stock: cancelled Rx ${job.id}-${job.sequence}`, jobId: job.id, userId: user.id });
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
      moveStock(job.medicine_id, -supply, { reason: `Owing supplied Rx ${job.id}-${job.sequence}`, jobId: job.id, userId: user.id });
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

    return tx(db, () => {
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

  // ───────────────────────── read models ─────────────────────────

  const JOB_VIEW = `
    SELECT j.*, i.medicine_id, i.directions, i.repeats_authorised, i.dispensings_count, i.period_days, i.prescription_id,
           m.name AS medicine, m.strength, m.form, m.controlled_class, m.code AS medicine_code,
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
    if (['entered', 'queued'].includes(job.state)) job.warnings = warningsFor(loadJob(id));
    if (job.warnings_acknowledged) job.warnings_acknowledged = JSON.parse(job.warnings_acknowledged);
    return job;
  }

  function queue({ state } = {}, user) {
    const rows = state
      ? all(`${JOB_VIEW} WHERE j.state = ? ORDER BY j.created_at, j.id`, state)
      : all(`${JOB_VIEW} WHERE j.state IN (${OPEN_JOB_STATES.map(() => '?').join(',')}) ORDER BY j.created_at, j.id`, ...OPEN_JOB_STATES);
    return rows.map((j) => ({ ...j, actions: availableActions(j, user) }));
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
    users: () => all('SELECT * FROM users ORDER BY role, name'),
    medicines: () => all('SELECT m.*, COALESCE(s.on_hand, 0) AS on_hand FROM medicines m LEFT JOIN stock s ON s.medicine_id = m.id ORDER BY m.name'),
    patients: (q = '') => all('SELECT * FROM patients WHERE name LIKE ? OR nhi LIKE ? ORDER BY name LIMIT 100', `%${q}%`, `%${q}%`),
    cdRegister: (medicineId) => all(
      `SELECT c.*, m.name AS medicine, m.strength, u.name AS user_name FROM cd_register c
       JOIN medicines m ON m.id = c.medicine_id LEFT JOIN users u ON u.id = c.user_id
       ${medicineId ? 'WHERE c.medicine_id = ?' : ''} ORDER BY c.id DESC`,
      ...(medicineId ? [Number(medicineId)] : []),
    ),
    adjustStock,
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
  };
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));
}
