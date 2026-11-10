// Pharmacy flow engine: runs a job through its pinned flow definition.
//
// Model
//   * A job pins one flow version (flow_jobs) the first time its flow starts,
//     and gets one flow_step_runs row per step.
//   * advance(jobId) walks the steps in order. Auto steps run; human steps are
//     never performed by the engine — they are marked done by observing the
//     job's workflow state (e.g. data_entry is done once the job is past
//     'queued'). The walk stops at the first human step whose action hasn't
//     happened ('waiting'), at a failed auto step, or at the end.
//   * Auto steps that depend on something later in the workflow (delivery
//     label, courier, notification, claim all depend on release) return
//     'waiting' without blocking the walk, and complete on a later advance.
//   * advance is idempotent and serialised per job, so it is safe to call after
//     every intake, transition and fulfilment action.
//
// Safety floor: the only acting user the engine ever uses is the Automation
// user, a technician. Technicians can never clinically check or final check
// (src/domain/workflow.js), and the engine refuses to act if that row's role
// has been changed.

import { BY_TYPE, HUMAN_ACTIONS, configWithDefaults, catalogue } from './catalogue.js';
import { validateFlow } from './validate.js';
import { defaultFlows } from './defaults.js';

export const schema = `
CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (key, version)
);

CREATE TABLE IF NOT EXISTS flow_jobs (
  job_id INTEGER PRIMARY KEY REFERENCES dispense_jobs(id),
  flow_id INTEGER NOT NULL REFERENCES flows(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS flow_step_runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES dispense_jobs(id),
  flow_id INTEGER NOT NULL REFERENCES flows(id),
  step_id TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','human')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','waiting','failed','skipped')),
  output TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (job_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_flows_key ON flows(key, active);
CREATE INDEX IF NOT EXISTS idx_flow_runs_job ON flow_step_runs(job_id);
`;

export const AUTOMATION_USER = Object.freeze({ name: 'Automation', initials: 'AU', role: 'technician' });

const STATE_RANK = { queued: 0, entered: 1, clinically_checked: 2, assembled: 3, checked: 4, released: 5, completed: 6 };
const HUMAN_DONE_RANK = { data_entry: 1, clinical_check: 2, assemble: 3, final_check: 4, handover: 5 };
const HUMAN_BY_COLUMN = { data_entry: 'entered_by', clinical_check: 'clinical_checked_by', assemble: 'assembled_by', final_check: 'final_checked_by' };
const OPEN_STATES = ['queued', 'entered', 'clinically_checked', 'assembled', 'checked', 'on_hold'];
const PRE_ASSEMBLY = ['queued', 'entered', 'clinically_checked'];
const TERMINAL = ['done', 'skipped'];

const err = (message, status, details) => Object.assign(new Error(message), { status, details });
const now = () => new Date().toISOString();
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
const parse = (s) => (s == null ? null : JSON.parse(s));

export function createFlowEngine({ db, platform, adapters = {}, hooks = {}, config = {} }) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const locks = new Map(); // jobId -> promise of the advance in progress
  const appConfig = config; // step impls take their own `config` (the step config)

  // ───────────── automation user (the safety floor) ─────────────

  function automationUser() {
    let u = one('SELECT * FROM users WHERE name = ? AND initials = ? ORDER BY id LIMIT 1', AUTOMATION_USER.name, AUTOMATION_USER.initials);
    if (!u) {
      const r = run('INSERT INTO users (name, initials, role) VALUES (?, ?, ?)', AUTOMATION_USER.name, AUTOMATION_USER.initials, AUTOMATION_USER.role);
      u = one('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
    }
    if (u.role !== 'technician') {
      throw err(`Safety floor: the Automation user must have the technician role (found "${u.role}"); automation is disabled until this is fixed`, 409);
    }
    return u;
  }

  // ───────────── flows (versioned definitions) ─────────────

  const flowRow = (r) => {
    if (!r) return null;
    const def = JSON.parse(r.definition);
    return {
      id: r.id, key: r.key, version: r.version, name: r.name, active: !!r.active,
      description: def.description ?? null, appliesTo: def.appliesTo, steps: def.steps,
      created_by: r.created_by, created_at: r.created_at,
    };
  };

  function getFlow(id) {
    const f = flowRow(one('SELECT * FROM flows WHERE id = ?', Number(id)));
    if (!f) throw err(`Flow ${id} not found`, 404);
    return f;
  }

  function listFlows() {
    return all('SELECT * FROM flows ORDER BY key, version DESC').map(flowRow);
  }

  const canManage = (user) => !!user && ['pharmacist', 'admin'].includes(user.role);

  /** Normalise a valid definition: enabled defaults to true, kind comes from the catalogue, config is an object. */
  function normalise(definition) {
    return {
      name: definition.name.trim(),
      ...(definition.description ? { description: definition.description } : {}),
      appliesTo: [...definition.appliesTo],
      steps: definition.steps.map((s) => ({ id: s.id, type: s.type, kind: BY_TYPE[s.type].kind, enabled: s.enabled !== false, config: { ...(s.config ?? {}) } })),
    };
  }

  function insertVersion(key, definition, userId, active) {
    const version = (one('SELECT MAX(version) AS v FROM flows WHERE key = ?', key)?.v ?? 0) + 1;
    const r = run(
      'INSERT INTO flows (key, version, name, definition, active, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      key, version, definition.name, JSON.stringify(definition), active ? 1 : 0, userId ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  /** New version of a flow (inactive until activated). Key is derived from the name if not given. */
  function createFlow(definition, user, key) {
    if (!canManage(user)) throw err('Only a pharmacist or admin can create flows', 403);
    const v = validateFlow(definition);
    if (!v.ok) throw err(`Flow is not valid: ${v.errors.join('; ')}`, 400, { errors: v.errors });
    const k = key != null && String(key).trim() ? slug(key) : slug(definition.name);
    const def = normalise(definition);
    const id = insertVersion(k, def, user.id, false);
    const f = getFlow(id);
    platform.audit.record({ userId: user.id, action: 'flow.created', entity: 'flow', entityId: id, data: { key: f.key, version: f.version, name: f.name } });
    return f;
  }

  function activate(id, user) {
    if (!canManage(user)) throw err('Only a pharmacist or admin can activate flows', 403);
    const f = getFlow(id);
    db.exec('SAVEPOINT flow_activate');
    try {
      run('UPDATE flows SET active = 0 WHERE key = ?', f.key);
      run('UPDATE flows SET active = 1 WHERE id = ?', f.id);
      db.exec('RELEASE flow_activate');
    } catch (e) {
      db.exec('ROLLBACK TO flow_activate');
      db.exec('RELEASE flow_activate');
      throw e;
    }
    platform.audit.record({ userId: user.id, action: 'flow.activated', entity: 'flow', entityId: f.id, data: { key: f.key, version: f.version } });
    return getFlow(f.id);
  }

  /** Install the default flows (v1, active) for any default key that has never existed. Idempotent. */
  function seedDefaults() {
    automationUser();
    const created = [];
    for (const { key, definition } of defaultFlows()) {
      if (one('SELECT id FROM flows WHERE key = ? LIMIT 1', key)) continue;
      const v = validateFlow(definition);
      if (!v.ok) throw new Error(`Default flow "${definition.name}" is invalid: ${v.errors.join('; ')}`);
      created.push(insertVersion(key, normalise(definition), null, true));
    }
    return created.map(getFlow);
  }

  // ───────────── jobs ─────────────

  function loadJob(jobId) {
    const j = one(
      `SELECT j.*, i.prescription_id, i.medicine_id, i.item_ref, i.dose_units, i.doses_per_day, i.period_days, i.directions,
              p.source, p.scid, p.patient_id, pa.nhi, pa.name AS patient_name, pa.phone, pa.email, pa.address,
              m.code AS medicine_code, m.name AS medicine_name, m.ingredient, m.strength, m.form
       FROM dispense_jobs j
       JOIN prescription_items i ON i.id = j.item_id
       JOIN prescriptions p ON p.id = i.prescription_id
       JOIN patients pa ON pa.id = p.patient_id
       JOIN medicines m ON m.id = i.medicine_id
       WHERE j.id = ?`,
      Number(jobId),
    );
    if (!j) throw err(`Dispense job ${jobId} not found`, 404);
    return j;
  }

  /** The active flow for this job's prescription source (first match by key), or null. */
  function resolveFlowForJob(jobId) {
    const job = loadJob(jobId);
    const match = all('SELECT * FROM flows WHERE active = 1 ORDER BY key').map(flowRow).find((f) => f.appliesTo.includes(job.source));
    return match ?? null;
  }

  const pinned = (jobId) => {
    const r = one('SELECT flow_id FROM flow_jobs WHERE job_id = ?', Number(jobId));
    return r ? getFlow(r.flow_id) : null;
  };

  /** Pin the job to a flow version and create its step runs. Idempotent; returns the pinned flow or null if none applies. */
  function start(jobId) {
    const existing = pinned(jobId);
    if (existing) return existing;
    const flow = resolveFlowForJob(jobId);
    if (!flow) return null;
    const id = Number(jobId);
    db.exec('SAVEPOINT flow_start');
    try {
      run('INSERT INTO flow_jobs (job_id, flow_id) VALUES (?, ?)', id, flow.id);
      for (const s of flow.steps) {
        run('INSERT INTO flow_step_runs (job_id, flow_id, step_id, type, kind) VALUES (?, ?, ?, ?, ?)', id, flow.id, s.id, s.type, BY_TYPE[s.type].kind);
      }
      db.exec('RELEASE flow_start');
    } catch (e) {
      db.exec('ROLLBACK TO flow_start');
      db.exec('RELEASE flow_start');
      throw e;
    }
    platform.audit.record({ userId: null, action: 'flow.started', entity: 'job', entityId: id, data: { flowId: flow.id, key: flow.key, version: flow.version } });
    return flow;
  }

  const getRun = (jobId, stepId) => one('SELECT * FROM flow_step_runs WHERE job_id = ? AND step_id = ?', Number(jobId), stepId);

  function writeRun(r, status, { output = null, error = null, started = false } = {}) {
    const terminal = ['done', 'skipped', 'failed'].includes(status);
    run(
      `UPDATE flow_step_runs SET status = ?, output = ?, error = ?,
         started_at = CASE WHEN ? THEN ? ELSE COALESCE(started_at, ?) END,
         finished_at = ?, attempts = attempts + ?
       WHERE id = ?`,
      status, output == null ? null : JSON.stringify(output), error,
      started ? 1 : 0, now(), now(),
      terminal ? now() : null, started ? 1 : 0, r.id,
    );
  }

  function auditStep(job, flowId, step, status, output, error, userId) {
    platform.audit.record({
      userId: userId ?? null, action: 'flow.step', entity: 'job', entityId: job.id,
      data: { flowId, stepId: step.id, type: step.type, status, ...(error ? { error } : {}), ...(output?.warnings?.length ? { warnings: output.warnings } : {}) },
    });
  }

  // ───────────── advance ─────────────

  function advance(jobId) {
    const id = Number(jobId);
    const prev = locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => advanceNow(id));
    locks.set(id, next);
    return next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  }

  async function advanceNow(jobId) {
    let job = loadJob(jobId);
    const flow = pinned(jobId) ?? start(jobId);
    if (!flow) return timeline(jobId);

    if (job.state === 'cancelled') {
      for (const s of flow.steps) {
        const r = getRun(jobId, s.id);
        if (r && !TERMINAL.includes(r.status) && r.status !== 'failed') writeRun(r, 'skipped', { output: { reason: 'Job cancelled' } });
      }
      return timeline(jobId);
    }

    for (const step of flow.steps) {
      job = loadJob(jobId);
      if (job.state === 'on_hold' || job.state === 'cancelled') break; // nothing runs while on hold
      const r = getRun(jobId, step.id);
      if (!r || TERMINAL.includes(r.status)) continue;
      if (r.status === 'failed') break; // blocked until retried
      const meta = BY_TYPE[step.type];

      if (!step.enabled) {
        const output = { reason: meta.kind === 'human' ? 'Not tracked by this flow (the dispensing workflow still requires this action)' : 'Disabled in this flow' };
        writeRun(r, 'skipped', { output });
        if (meta.kind === 'auto') auditStep(job, flow.id, step, 'skipped', output);
        continue;
      }

      if (meta.kind === 'human') {
        const res = await humanStep(job, step, r, flow);
        if (res !== 'done') break; // waiting for a person
        continue;
      }

      const status = await autoStep(job, step, r, flow);
      if (status === 'failed') break;
      // 'waiting' auto steps (e.g. waiting on release) don't block the walk.
    }
    return timeline(jobId);
  }

  function userSummary(uid) {
    const u = uid ? one('SELECT id, name, initials, role FROM users WHERE id = ?', uid) : null;
    return u ? { userId: u.id, by: u.name, initials: u.initials, role: u.role, automated: u.name === AUTOMATION_USER.name && u.initials === AUTOMATION_USER.initials } : null;
  }

  async function humanStep(job, step, r, flow) {
    const rank = STATE_RANK[job.state] ?? -1;
    const doneOutput = () => {
      const col = HUMAN_BY_COLUMN[step.type];
      if (col) return { ...(userSummary(job[col]) ?? {}), ...(step.type === 'assemble' ? { quantitySupplied: job.quantity_supplied, owing: job.owing } : {}) };
      const f = job.fulfilment_id ? one('SELECT id, method, status FROM fulfilments WHERE id = ?', job.fulfilment_id) : null;
      return { fulfilmentId: f?.id ?? null, method: f?.method ?? null };
    };
    if (rank >= HUMAN_DONE_RANK[step.type]) {
      writeRun(r, 'done', { output: doneOutput() });
      return 'done';
    }

    // data_entry may be auto-confirmed for structured e-scripts.
    const cfg = configWithDefaults(step.type, step.config);
    if (step.type === 'data_entry' && job.state === 'queued' && (cfg.autoFor ?? []).includes(job.source)) {
      let autoError = null;
      try {
        const au = automationUser();
        writeRun(r, 'running', { started: true });
        await platform.transition(job.id, 'enter', au, {});
        const after = loadJob(job.id);
        const output = { ...(userSummary(after.entered_by) ?? {}), autoConfirmed: true, source: job.source };
        writeRun(r, 'done', { output });
        auditStep(job, flow.id, step, 'done', output, null, au.id);
        return 'done';
      } catch (e) {
        autoError = e.message;
        auditStep(job, flow.id, step, 'waiting', null, `Auto-confirm failed, waiting for a person: ${e.message}`);
      }
      writeRun(r, 'waiting', { output: waitingOutput(step, { autoError }) });
      return 'waiting';
    }

    if (r.status !== 'waiting') writeRun(r, 'waiting', { output: waitingOutput(step), started: true });
    return 'waiting';
  }

  function waitingOutput(step, extra = {}) {
    const action = HUMAN_ACTIONS[step.type];
    return { awaiting: action, roles: step.type === 'clinical_check' || step.type === 'final_check' ? ['pharmacist'] : ['technician', 'pharmacist'], ...extra };
  }

  async function autoStep(job, step, r, flow) {
    const impl = STEP_IMPLS[step.type];
    const cfg = configWithDefaults(step.type, step.config);
    writeRun(r, 'running', { started: true });
    let res;
    try {
      res = await impl({ job, step, config: cfg, flow });
    } catch (e) {
      res = { status: 'failed', error: e.message, output: null };
    }
    const { status, output = null, error = null } = res;
    writeRun(r, status, { output, error });
    // Audit every outcome, except a repeat of the same 'waiting' (advance runs after every action).
    const repeatWait = status === 'waiting' && r.status === 'waiting' && r.output === (output == null ? null : JSON.stringify(output));
    if (!repeatWait) {
      let uid = null;
      try { uid = automationUser().id; } catch { /* audited with no user */ }
      auditStep(job, flow.id, step, status, output, error, uid);
    }
    return status;
  }

  // ───────────── auto step implementations ─────────────

  const done = (output) => ({ status: 'done', output });
  const skipped = (reason, extra = {}) => ({ status: 'skipped', output: { reason, ...extra } });
  const failed = (error, output = null) => ({ status: 'failed', error, output });
  const waiting = (reason, extra = {}) => ({ status: 'waiting', output: { reason, ...extra } });
  const isReleased = (job) => (STATE_RANK[job.state] ?? -1) >= STATE_RANK.released;
  const fulfilmentOf = (job) => (job.fulfilment_id ? platform.getFulfilment(job.fulfilment_id) : null);
  const AWAIT_RELEASE = 'Waiting for handover: the fulfilment method is chosen at release';

  const STEP_IMPLS = {
    receive({ job }) {
      const o = platform.originalFor(job.prescription_id);
      const output = { source: o.source, kind: o.kind, scid: o.scid, receivedAt: o.receivedAt, hash: o.hash, intact: o.intact, documents: o.documents.length };
      if (!o.payload) return failed('No stored copy of the script as received', output);
      if (!o.intact) return failed('Integrity check failed: the stored script no longer matches its hash at receipt — do not dispense; investigate', output);
      return done(output);
    },

    match_patient({ job }) {
      const warnings = [];
      if (!job.nhi) warnings.push('No NHI on the patient record: confirm identity and add the NHI before claiming');
      return done({ patientId: job.patient_id, nhi: job.nhi ?? null, matched: !!job.nhi, warnings });
    },

    verify_original({ job }) {
      const o = platform.originalFor(job.prescription_id, job.item_id);
      const differences = o.compare.filter((c) => !c.match).map((c) => c.field);
      const docsIntact = o.documents.every((d) => d.intact);
      const output = { kind: o.kind, intact: o.intact, documents: o.documents.length, documentsIntact: docsIntact, differences, amendments: o.amendments.length, warnings: differences.length ? [`Differs from the original: ${differences.join(', ')}`] : [] };
      if (!o.intact) return failed('Integrity check failed: the stored script no longer matches its hash at receipt — do not dispense; investigate', output);
      if (!docsIntact) return failed('A scanned original failed its integrity check — do not dispense; investigate', output);
      if (['paper', 'signature_exempt', 'fax'].includes(o.source) && o.documents.length === 0) {
        return failed('No scan of the original is attached for a written script', output);
      }
      return done(output);
    },

    async map_formulary({ job }) {
      if (typeof hooks.formulary?.lookup !== 'function') return skipped('NZ Formulary not connected yet, so interaction and dosing checks are off');
      const med = { id: job.medicine_id, code: job.medicine_code, name: job.medicine_name, ingredient: job.ingredient, strength: job.strength, form: job.form };
      const hit = await hooks.formulary.lookup(med);
      if (!hit) return done({ matched: false, medicine: med.code, warnings: [`${med.name} ${med.strength} was not found in the formulary`] });
      const src = hit.source;
      return done({
        matched: true, medicine: med.code, ingredient: hit.ingredient ?? med.ingredient, nzfUrl: hit.nzfUrl ?? hit.url ?? null,
        source: src && typeof src === 'object' ? { name: src.name ?? null, version: src.version ?? null, licensed: !!src.licensed } : src ?? null,
        ...(hit.fallbackFrom?.length ? { fallbackFrom: hit.fallbackFrom } : {}),
        warnings: src && typeof src === 'object' && src.licensed === false ? [`Formulary data is from ${src.name ?? 'an unlicensed source'} (not licensed clinical content)`] : [],
      });
    },

    check_stock({ job, config }) {
      const onHand = platform._internal.onHand(job.medicine_id);
      // Soft reservations: other pre-assembly jobs for this medicine whose check_stock reserved.
      const committed = one(
        `SELECT COALESCE(SUM(j.quantity), 0) AS n FROM flow_step_runs r
         JOIN dispense_jobs j ON j.id = r.job_id
         JOIN prescription_items i ON i.id = j.item_id
         WHERE r.type = 'check_stock' AND r.status = 'done' AND json_extract(r.output, '$.reserved') = 1
           AND i.medicine_id = ? AND j.id <> ? AND j.state IN (${PRE_ASSEMBLY.map(() => '?').join(',')})`,
        job.medicine_id, job.id, ...PRE_ASSEMBLY,
      ).n;
      const available = Math.max(0, onHand - committed);
      const shortBy = Math.max(0, job.quantity - available);
      const output = { onHand, required: job.quantity, committedElsewhere: committed, available, shortBy, shortfall: shortBy > 0, reserved: !!config.reserve, allowOwing: !!config.allowOwing, warnings: [] };
      if (shortBy > 0) {
        output.warnings.push(available === 0 ? 'No stock available: order stock or place the job on hold' : `Short by ${shortBy}: ${available} can be supplied now with ${shortBy} owing`);
        if (!config.allowOwing) return failed(`Insufficient stock (short by ${shortBy}) and this flow does not allow owings — order stock, then retry this step`, output);
      }
      return done(output);
    },

    check_history({ job, config }) {
      const days = Math.max(1, Math.round(config.lookbackDays));
      const rows = all(
        `SELECT j.id AS jobId, j.item_id, j.sequence, j.state, j.quantity, j.quantity_supplied, j.updated_at, m.name, m.strength
         FROM dispense_jobs j
         JOIN prescription_items i ON i.id = j.item_id
         JOIN prescriptions p ON p.id = i.prescription_id
         JOIN medicines m ON m.id = i.medicine_id
         WHERE p.patient_id = ? AND m.ingredient = ? AND j.id <> ?
           AND ((j.state IN ('released','completed') AND j.updated_at >= datetime('now', ?))
                OR j.state IN (${OPEN_STATES.map(() => '?').join(',')}))
         ORDER BY j.updated_at DESC`,
        job.patient_id, job.ingredient, job.id, `-${days} days`, ...OPEN_STATES,
      );
      const priorSupplies = rows.filter((x) => ['released', 'completed'].includes(x.state)).map(({ item_id, ...x }) => ({ ...x, sameItem: item_id === job.item_id }));
      const openDuplicates = rows.filter((x) => OPEN_STATES.includes(x.state) && x.item_id !== job.item_id).map(({ item_id, ...x }) => x);
      const perDay = (job.dose_units ?? 0) * (job.doses_per_day ?? 0);
      const daysSupply = perDay > 0 ? Math.round(job.quantity / perDay) : job.period_days ?? null;
      const durationTooLong = daysSupply != null && daysSupply > config.maxSupplyDays;
      const warnings = [];
      if (openDuplicates.length) warnings.push(`Another ${job.ingredient} supply is already in progress for this patient`);
      const otherItems = priorSupplies.filter((x) => !x.sameItem);
      if (otherItems.length) warnings.push(`${job.ingredient} supplied on another script in the last ${days} days`);
      if (durationTooLong) warnings.push(`Supply covers about ${daysSupply} days (more than ${config.maxSupplyDays})`);
      return done({ ingredient: job.ingredient, lookbackDays: days, priorSupplies, openDuplicates, daysSupply, maxSupplyDays: config.maxSupplyDays, durationTooLong, warnings });
    },

    async screen({ job, config }) {
      if (!['queued', 'entered'].includes(job.state)) return skipped(`Job is already ${job.state}; rules are re-run at the clinical check sign-off`);
      const au = automationUser();
      let s;
      if (config.useAi === false && adapters && 'reviewer' in adapters) {
        // platform.runScreening has no rules-only switch. It reads adapters.reviewer synchronously
        // before its first await, so hide the reviewer just for the synchronous part of the call.
        const saved = adapters.reviewer;
        let p;
        try {
          adapters.reviewer = null;
          p = platform.runScreening(job.id, au, { useAi: false });
        } finally {
          adapters.reviewer = saved;
        }
        s = await p;
      } else {
        s = await platform.runScreening(job.id, au, { useAi: config.useAi !== false });
      }
      const counts = {};
      for (const f of s.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      const top = s.findings[0] ?? null;
      return done({
        screeningId: s.id, reviewer: s.reviewer, rulesVersion: s.rules_version, aiRequested: config.useAi !== false, counts,
        top: top && { code: top.code, severity: top.severity, message: top.message, origin: top.origin },
        warnings: (counts.hard_stop ? [`${counts.hard_stop} hard stop(s) need a pharmacist override`] : []),
      });
    },

    async print_worksheet({ job }) {
      if (typeof hooks.print?.worksheetUrl !== 'function') return skipped('Printing is not set up');
      const url = await hooks.print.worksheetUrl(job.id);
      if (!url) return failed('Print module returned no worksheet');
      return done({ url });
    },

    generate_label({ job }) {
      if (!isReleased(job)) return waiting(AWAIT_RELEASE, { awaiting: 'release' });
      const f = fulfilmentOf(job);
      if (!f || !['delivery', 'courier'].includes(f.method)) return skipped(`Not needed for ${f?.method ?? 'this'} fulfilment (the dispensing label was produced at assembly)`, { method: f?.method ?? null });
      const label = [job.patient_name, f.address ?? job.address ?? '(no address)', `Order F${f.id}${f.tracking_ref ? ` · ${f.tracking_ref}` : ''}`, f.hasControlled ? 'SIGNATURE REQUIRED' : null].filter(Boolean).join('\n');
      return done({ fulfilmentId: f.id, method: f.method, label, signatureRequired: !!f.hasControlled });
    },

    async book_courier({ job, config }) {
      if (!isReleased(job)) return waiting(AWAIT_RELEASE, { awaiting: 'release' });
      let f = fulfilmentOf(job);
      if (!f || f.method !== 'courier') return skipped(`Not needed for ${f?.method ?? 'this'} fulfilment`, { method: f?.method ?? null });
      if (f.tracking_ref) return done({ fulfilmentId: f.id, provider: f.provider, trackingRef: f.tracking_ref, alreadyBooked: true });
      if (f.status !== 'open') return waiting(`Fulfilment is ${f.status}`, { fulfilmentId: f.id });
      if (!f.ready) return waiting('Waiting for every item in the order to be released', { fulfilmentId: f.id });
      // The platform only counts jobs already attached to the fulfilment, so also wait for other
      // in-progress items on the same script, which would otherwise go in a separate parcel.
      // (On-hold items don't block; staff can dispatch by hand at any time.)
      const siblings = one(
        `SELECT COUNT(*) AS n FROM dispense_jobs j JOIN prescription_items i ON i.id = j.item_id
         WHERE i.prescription_id = ? AND j.id <> ? AND j.state IN ('queued','entered','clinically_checked','assembled','checked')`,
        job.prescription_id, job.id,
      ).n;
      if (siblings) return waiting(`Waiting for ${siblings} other item(s) on this script to be released so they travel together (dispatch by hand to send now)`, { fulfilmentId: f.id, otherItems: siblings });
      const provider = config.provider || 'default';
      if (!adapters.couriers?.[provider]) return failed(`No courier adapter named "${provider}"`);
      f = await platform.fulfilmentAction(f.id, 'dispatch', automationUser(), { provider });
      return done({ fulfilmentId: f.id, provider: f.provider, trackingRef: f.tracking_ref, status: f.status });
    },

    notify_patient({ job, config }) {
      if (!isReleased(job)) return waiting(AWAIT_RELEASE, { awaiting: 'release' });
      const f = fulfilmentOf(job);
      const to = config.channel === 'email' ? job.email : job.phone;
      const pharmacy = appConfig.pharmacy?.name ?? 'the pharmacy';
      const first = String(job.patient_name ?? '').split(' ')[0] || 'there';
      const message = !f || ['pickup', 'compliance_pack'].includes(f.method)
        ? `Kia ora ${first}, your prescription from ${pharmacy} is ready to collect.${f?.pickup_code ? ` Pickup code: ${f.pickup_code}.` : ''}`
        : `Kia ora ${first}, your prescription from ${pharmacy} is being ${f.method === 'courier' ? 'sent by courier' : 'delivered'}.${f.tracking_ref ? ` Tracking: ${f.tracking_ref}.` : ''}`;
      if (!to) return skipped(`No ${config.channel === 'email' ? 'email address' : 'mobile number'} on file`, { channel: config.channel, warnings: ['Patient could not be notified'] });
      return done({ channel: config.channel, to: mask(to, config.channel), message, delivery: 'mock (not sent)' });
    },

    submit_claim({ job }) {
      if (!isReleased(job)) return waiting('Claims are created at release', { awaiting: 'release' });
      const c = one('SELECT id, status, quantity, subsidy_cents, batch_ref FROM claims WHERE job_id = ?', job.id);
      if (!c) return failed('No claim was created at release');
      return done({ claimId: c.id, status: c.status, quantity: c.quantity, subsidyCents: c.subsidy_cents, batchRef: c.batch_ref, note: 'Submitted with the next claims batch' });
    },
  };
  // ───────────── read model / retry ─────────────

  function timeline(jobId) {
    loadJob(jobId);
    const flow = pinned(jobId);
    if (!flow) return { flow: null, steps: [], current: null };
    const runs = Object.fromEntries(all('SELECT * FROM flow_step_runs WHERE job_id = ?', Number(jobId)).map((r) => [r.step_id, r]));
    const steps = flow.steps.map((s) => {
      const r = runs[s.id] ?? {};
      return {
        stepId: s.id, type: s.type, kind: BY_TYPE[s.type].kind, label: BY_TYPE[s.type].label,
        status: r.status ?? 'pending', output: parse(r.output), error: r.error ?? null,
        started_at: r.started_at ?? null, finished_at: r.finished_at ?? null,
      };
    });
    const blocking = steps.find((s) => ['failed', 'running', 'pending'].includes(s.status) || (s.status === 'waiting' && s.kind === 'human'));
    const current = (blocking ?? steps.find((s) => s.status === 'waiting'))?.stepId ?? null;
    return { flow: { id: flow.id, key: flow.key, version: flow.version, name: flow.name }, steps, current };
  }

  /** Reset a failed auto step and advance. */
  async function retry(jobId, stepId, user) {
    const flow = pinned(jobId);
    if (!flow) throw err('This job is not running a flow', 404);
    const step = flow.steps.find((s) => s.id === stepId);
    if (!step) throw err(`Step "${stepId}" is not in this job's flow`, 404);
    if (BY_TYPE[step.type].kind !== 'auto') throw err('Only automatic steps can be retried; human steps complete when the action is done', 409);
    const r = getRun(jobId, stepId);
    if (r.status !== 'failed') throw err(`Only a failed step can be retried (this one is ${r.status})`, 409);
    run("UPDATE flow_step_runs SET status = 'pending', error = NULL, finished_at = NULL WHERE id = ?", r.id);
    platform.audit.record({ userId: user?.id ?? null, action: 'flow.step_retry', entity: 'job', entityId: Number(jobId), data: { flowId: flow.id, stepId } });
    return advance(jobId);
  }

  // ───────────── integration conveniences ─────────────

  /** After a workflow transition (any action). */
  const onTransition = (jobId /* , action */) => advance(jobId);

  /** After intake: start + advance every job of the prescription. */
  async function onPrescription(rx) {
    const out = [];
    for (const item of rx?.items ?? []) for (const j of item.jobs ?? []) out.push(await advance(j.id));
    return out;
  }

  /** After a fulfilment action (dispatch/complete/...): advance every job in it. */
  async function onFulfilment(fulfilmentId) {
    const jobs = all('SELECT j.id FROM dispense_jobs j JOIN flow_jobs fj ON fj.job_id = j.id WHERE j.fulfilment_id = ?', Number(fulfilmentId));
    for (const j of jobs) await advance(j.id);
  }

  return {
    catalogue, validate: validateFlow, seedDefaults, listFlows, getFlow, createFlow, activate,
    resolveFlowForJob, start, advance, onTransition, onPrescription, onFulfilment, timeline, retry,
    automationUser,
  };
}

function mask(to, channel) {
  const s = String(to);
  if (channel === 'email') {
    const [u, d] = s.split('@');
    return d ? `${u.slice(0, 1)}***@${d}` : '***';
  }
  const digits = s.replace(/\D/g, '');
  return digits.length > 3 ? `***${digits.slice(-3)}` : '***';
}
