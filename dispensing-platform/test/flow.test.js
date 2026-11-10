import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, DEFAULT_CONFIG } from '../src/server.js';
import { createMockAdapters } from '../src/adapters/index.js';
import { makeScid } from '../src/domain/scid.js';
import { schema, createFlowEngine, AUTOMATION_USER } from '../src/flow/engine.js';
import { validateFlow } from '../src/flow/validate.js';
import { catalogue } from '../src/flow/catalogue.js';
import { defaultFlows } from '../src/flow/defaults.js';
import { registerFlowRoutes } from '../src/flow/routes.js';
import { createFormulary, createLocalFormularySource } from '../src/formulary/index.js';

// Tests below exercise the optional clinical checks (demo data) and the offline AI reviewer;
// both are off by default in the product (see test/scope.test.js).
process.env.CLINICAL_CHECKS ??= 'demo';
process.env.AI_REVIEWER ??= 'mock';

const METFORMIN_SCID = makeScid('1A2B3C4D5E6F7G8H9'); // Aroha: metformin + atorvastatin
const AMOX_SCID = makeScid('B7C8D9E0F1G2H3J4K'); // James: amoxicillin (15, only 10 in stock; penicillin allergy)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let app, p, adapters, engine, priya, tom, lucy, ben;

function makeEngine(hooks = {}) {
  return createFlowEngine({ db: app.db, platform: p, adapters, hooks, config: DEFAULT_CONFIG });
}

beforeEach(() => {
  adapters = createMockAdapters();
  app = createApp({ adapters });
  p = app.platform;
  app.db.exec(schema);
  engine = makeEngine();
  engine.seedDefaults();
  const byName = Object.fromEntries(p.users().map((u) => [u.name.split(' ')[0], u]));
  ({ Priya: priya, Tom: tom, Lucy: lucy, Ben: ben } = byName);
});

const stepOf = (tl, type) => tl.steps.find((s) => s.type === type);
const firstJob = (rx) => rx.items[0].jobs[0].id;

function approveAll(jobId) {
  const decisions = {};
  for (const f of p.getJob(jobId, priya).warnings ?? []) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Discussed with prescriber', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge', note: 'Reviewed' };
  }
  return { decisions, sourceVerified: true };
}

function validDef(overrides = {}) {
  return { ...defaultFlows()[0].definition, ...overrides };
}
const withSteps = (fn) => { const d = validDef(); d.steps = fn(d.steps); return d; };
const move = (steps, type, beforeType) => {
  const s = steps.find((x) => x.type === type);
  const rest = steps.filter((x) => x !== s);
  rest.splice(rest.findIndex((x) => x.type === beforeType), 0, s);
  return rest;
};

async function writtenScript(extra = {}) {
  return p.intakeManual({
    source: 'paper', document: { filename: 'scan.png', dataBase64: PNG_B64 },
    patient: { nhi: 'ZZZ0016', name: 'Aroha Ngata' },
    prescriber: { cpn: '12ABCD', name: 'Dr Mere Tane' },
    items: [{ medicineCode: 'ATO40', directions: 'Take ONE tablet at night', quantity: 30, doseUnits: 1, dosesPerDay: 1 }],
    ...extra,
  }, lucy);
}

// ───────────── validation ─────────────

test('default flows are valid and the catalogue covers every step type they use', () => {
  const types = new Set(catalogue().map((c) => c.type));
  for (const { definition } of defaultFlows()) {
    assert.deepEqual(validateFlow(definition), { ok: true, errors: [] });
    for (const s of definition.steps) assert.ok(types.has(s.type), s.type);
  }
  const cat = catalogue();
  assert.ok(cat.every((c) => ['auto', 'human'].includes(c.kind) && c.label && c.description && Array.isArray(c.configSchema)));
  assert.deepEqual(cat.filter((c) => c.required).map((c) => c.type).sort(), ['clinical_check', 'final_check']);
  assert.equal(cat.find((c) => c.type === 'data_entry').configSchema[0].type, 'sources');
});

test('validation: clinical and final checks must be present and enabled', () => {
  for (const type of ['clinical_check', 'final_check']) {
    const removed = validateFlow(withSteps((s) => s.filter((x) => x.type !== type)));
    assert.equal(removed.ok, false);
    assert.ok(removed.errors.some((e) => /required in every flow and cannot be removed/.test(e)), removed.errors.join());
    const disabled = validateFlow(withSteps((s) => s.map((x) => (x.type === type ? { ...x, enabled: false } : x))));
    assert.ok(disabled.errors.some((e) => /cannot be disabled/.test(e)));
    const auto = validateFlow(withSteps((s) => s.map((x) => (x.type === type ? { ...x, kind: 'auto' } : x))));
    assert.ok(auto.errors.some((e) => /kind cannot be changed/.test(e)));
  }
});

test('validation: ordering rules', () => {
  const cases = [
    ['clinical_check', 'screen', /Clinical screening must come before Clinical check/],
    ['assemble', 'clinical_check', /Clinical check must come before Assemble/],
    ['assemble', 'print_worksheet', /Print worksheet must come before Assemble/],
    ['final_check', 'assemble', /Assemble must come before Final check/],
    ['handover', 'final_check', /Final check must come before Handover/],
    ['generate_label', 'final_check', /Final check must come before Delivery label/],
    ['book_courier', 'final_check', /Final check must come before Book courier/],
  ];
  for (const [type, before, re] of cases) {
    const r = validateFlow(withSteps((s) => move(s, type, before)));
    assert.equal(r.ok, false, `${type} before ${before}`);
    assert.ok(r.errors.some((e) => re.test(e)), `${re}: ${r.errors.join(' | ')}`);
  }
});

test('validation: unique kebab ids, known types, appliesTo, config types', () => {
  let r = validateFlow(withSteps((s) => [...s, { ...s[0] }]));
  assert.ok(r.errors.some((e) => /duplicate step id "receive"/.test(e)));
  r = validateFlow(withSteps((s) => s.map((x, i) => (i === 0 ? { ...x, id: 'Receive Step' } : x))));
  assert.ok(r.errors.some((e) => /kebab-case/.test(e)));
  r = validateFlow(withSteps((s) => [...s, { id: 'teleport', type: 'teleport', enabled: true, config: {} }]));
  assert.ok(r.errors.some((e) => /unknown step type "teleport"/.test(e)));
  r = validateFlow(withSteps((s) => [...s, { id: 'assemble-2', type: 'assemble', enabled: true, config: {} }].sort((a, b) => (a.type === 'handover') - (b.type === 'handover'))));
  assert.ok(r.errors.some((e) => /Assemble appears more than once/.test(e)));
  assert.ok(validateFlow(validDef({ appliesTo: [] })).errors.some((e) => /at least one prescription source/.test(e)));
  assert.ok(validateFlow(validDef({ appliesTo: ['email'] })).errors.some((e) => /Unknown source/.test(e)));
  assert.ok(validateFlow(validDef({ name: ' ' })).errors.some((e) => /needs a name/.test(e)));
  r = validateFlow(withSteps((s) => s.map((x) => (x.type === 'check_history' ? { ...x, config: { lookbackDays: 'ninety' } } : x))));
  assert.ok(r.errors.some((e) => /must be a number/.test(e)));
  r = validateFlow(withSteps((s) => s.map((x) => (x.type === 'notify_patient' ? { ...x, config: { channel: 'pigeon' } } : x))));
  assert.ok(r.errors.some((e) => /one of sms, email/.test(e)));
  assert.deepEqual(validateFlow(null), { ok: false, errors: ['Flow definition must be an object'] });
  r = validateFlow(withSteps((s) => s.map((x) => (x.type === 'check_history' ? { ...x, config: { lookbackDays: null } } : x))));
  assert.equal(r.ok, true, 'null means "use the default"');
});

test('validation: data entry can never be auto-confirmed for paper, fax, signature-exempt (or phone)', () => {
  for (const src of ['paper', 'fax', 'signature_exempt', 'phone']) {
    const r = validateFlow(withSteps((s) => s.map((x) => (x.type === 'data_entry' ? { ...x, config: { autoFor: ['nzeps', src] } } : x))));
    assert.equal(r.ok, false, src);
    assert.ok(r.errors.some((e) => e.includes(src) && /structured e-scripts/.test(e)), r.errors.join());
  }
  const ok = validateFlow(withSteps((s) => s.map((x) => (x.type === 'data_entry' ? { ...x, config: { autoFor: ['nzeps'] } } : x))));
  assert.equal(ok.ok, true);
});

// ───────────── versioning ─────────────

test('flows are versioned: create makes a new inactive version, activate swaps the active one', () => {
  const flows = engine.listFlows();
  assert.deepEqual(flows.map((f) => [f.key, f.version, f.active]), [['e-script-standard', 1, true], ['written-script', 1, true]]);
  assert.deepEqual(engine.seedDefaults(), []); // idempotent

  const def = withSteps((s) => s.filter((x) => x.type !== 'notify_patient'));
  const v2 = engine.createFlow(def, priya, 'e-script-standard');
  assert.equal(v2.version, 2);
  assert.equal(v2.active, false);
  assert.ok(v2.steps.every((s) => s.kind && typeof s.enabled === 'boolean'));
  assert.equal(engine.listFlows().find((f) => f.key === 'e-script-standard' && f.active).version, 1);
  engine.activate(v2.id, tom);
  const active = engine.listFlows().filter((f) => f.key === 'e-script-standard' && f.active);
  assert.deepEqual(active.map((f) => f.version), [2]);

  // key derived from the name when absent
  const custom = engine.createFlow({ ...def, name: 'Night Shift Flow!' }, priya);
  assert.equal(custom.key, 'night-shift-flow');
  assert.equal(custom.version, 1);

  assert.throws(() => engine.createFlow(def, lucy), (e) => e.status === 403);
  assert.throws(() => engine.activate(v2.id, lucy), (e) => e.status === 403);
  assert.throws(() => engine.createFlow({ ...def, appliesTo: [] }, priya), (e) => e.status === 400 && e.details.errors.length > 0);
});

test('a job keeps its pinned flow version after a new version is activated', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = firstJob(rx);
  const tl = await engine.advance(jobId);
  assert.equal(tl.flow.version, 1);
  const v2 = engine.createFlow(validDef(), priya, 'e-script-standard');
  engine.activate(v2.id, priya);
  assert.equal(engine.resolveFlowForJob(jobId).version, 2);
  assert.equal((await engine.advance(jobId)).flow.version, 1);
});

// ───────────── running ─────────────

test('e-script runs from intake to waiting at the clinical check, data entry auto-confirmed by Automation', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = firstJob(rx);
  const tl = await engine.advance(jobId);

  assert.equal(tl.flow.key, 'e-script-standard');
  assert.equal(tl.current, 'clinical-check');
  const status = Object.fromEntries(tl.steps.map((s) => [s.type, s.status]));
  assert.deepEqual(status, {
    receive: 'done', match_patient: 'done', verify_original: 'done', map_formulary: 'skipped', data_entry: 'done',
    check_stock: 'done', check_history: 'done', screen: 'done', clinical_check: 'waiting',
    print_worksheet: 'pending', assemble: 'pending', final_check: 'pending', generate_label: 'pending', book_courier: 'pending',
    handover: 'pending', notify_patient: 'pending', submit_claim: 'pending',
  });
  const de = stepOf(tl, 'data_entry');
  assert.equal(de.output.by, 'Automation');
  assert.equal(de.output.role, 'technician');
  assert.equal(de.output.autoConfirmed, true);
  assert.match(stepOf(tl, 'map_formulary').output.reason, /NZ Formulary not connected/);
  assert.deepEqual({ onHand: stepOf(tl, 'check_stock').output.onHand, shortBy: stepOf(tl, 'check_stock').output.shortBy }, { onHand: 500, shortBy: 0 });
  assert.equal(stepOf(tl, 'match_patient').output.nhi, 'ZZZ0016');
  assert.ok(stepOf(tl, 'screen').output.screeningId);
  assert.deepEqual(stepOf(tl, 'clinical_check').output.roles, ['pharmacist']);
  for (const s of tl.steps.filter((x) => ['done', 'skipped'].includes(x.status))) assert.ok(s.finished_at, s.type);

  const job = p.getJob(jobId, priya);
  assert.equal(job.state, 'entered');
  assert.equal(job.entered_by, engine.automationUser().id);
  assert.equal(job.screening.status, 'pending');

  // every auto step is audited
  const audited = p.audit.list({ entity: 'job', entityId: jobId }).filter((a) => a.action === 'flow.step').map((a) => a.data.type);
  for (const t of ['receive', 'match_patient', 'verify_original', 'map_formulary', 'check_stock', 'check_history', 'screen', 'data_entry']) assert.ok(audited.includes(t), t);
  assert.equal(p.audit.verify().ok, true);
});

test('safety floor: Automation is a technician and can never clinically or final check', async () => {
  const au = engine.automationUser();
  assert.deepEqual({ name: au.name, initials: au.initials, role: au.role }, { ...AUTOMATION_USER });
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = firstJob(rx);
  await engine.advance(jobId);
  await assert.rejects(p.transition(jobId, 'clinical_check', au, approveAll(jobId)), (e) => e.status === 403);
  // advancing repeatedly never moves past the human checkpoint
  for (let i = 0; i < 3; i++) assert.equal((await engine.advance(jobId)).current, 'clinical-check');
  assert.equal(p.getJob(jobId, priya).state, 'entered');

  // If someone promotes the Automation row, the engine refuses to act at all.
  app.db.prepare("UPDATE users SET role = 'pharmacist' WHERE id = ?").run(au.id);
  assert.throws(() => engine.automationUser(), /Safety floor/);
  const rx2 = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  const tl = await engine.advance(firstJob(rx2));
  assert.equal(stepOf(tl, 'data_entry').status, 'waiting');
  assert.match(stepOf(tl, 'data_entry').output.autoError, /Safety floor/);
  assert.equal(p.getJob(firstJob(rx2), priya).state, 'queued');
});

test('written script waits at data entry; human entry lets it run on to the clinical check', async () => {
  const rx = await writtenScript();
  const jobId = firstJob(rx);
  let tl = await engine.advance(jobId);
  assert.equal(tl.flow.key, 'written-script');
  assert.equal(tl.current, 'data-entry');
  assert.equal(stepOf(tl, 'data_entry').status, 'waiting');
  assert.equal(stepOf(tl, 'verify_original').output.documents, 1);
  assert.equal(stepOf(tl, 'check_stock').status, 'pending');
  assert.equal(p.getJob(jobId, priya).state, 'queued');

  await p.transition(jobId, 'enter', lucy);
  tl = await engine.onTransition(jobId, 'enter');
  assert.equal(tl.current, 'clinical-check');
  assert.equal(stepOf(tl, 'data_entry').output.by, 'Lucy Chen');
  assert.equal(stepOf(tl, 'data_entry').output.automated, false);
  assert.equal(stepOf(tl, 'screen').status, 'done');
});

test('advance is idempotent and safe to call concurrently', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = firstJob(rx);
  const [a, b, c] = await Promise.all([engine.advance(jobId), engine.advance(jobId), engine.advance(jobId)]);
  assert.deepEqual(b.steps.map((s) => s.status), a.steps.map((s) => s.status));
  assert.deepEqual(c.current, a.current);
  const before = app.db.prepare('SELECT COUNT(*) AS n FROM screenings WHERE job_id = ?').get(jobId).n;
  const auditBefore = p.audit.list({ entity: 'job', entityId: jobId }).length;
  const again = await engine.advance(jobId);
  assert.deepEqual(again.steps.map((s) => [s.stepId, s.status, s.finished_at]), a.steps.map((s) => [s.stepId, s.status, s.finished_at]));
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM screenings WHERE job_id = ?').get(jobId).n, before);
  assert.equal(before, 1);
  assert.equal(p.audit.list({ entity: 'job', entityId: jobId }).length, auditBefore);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM flow_step_runs WHERE job_id = ?').get(jobId).n, a.steps.length);
  assert.equal(engine.start(jobId).id, a.flow.id);
});

test('integrity break fails the pipeline at receive and stops it; retry fails again', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  app.db.prepare("UPDATE prescriptions SET source_payload = replace(source_payload, '\"quantity\":60', '\"quantity\":600') WHERE id = ?").run(rx.id);
  const jobId = firstJob(rx);
  const tl = await engine.advance(jobId);
  assert.equal(tl.current, 'receive');
  assert.equal(stepOf(tl, 'receive').status, 'failed');
  assert.match(stepOf(tl, 'receive').error, /Integrity check failed/);
  assert.ok(tl.steps.slice(1).every((s) => s.status === 'pending'));
  assert.equal(p.getJob(jobId, priya).state, 'queued'); // automation did not enter it
  assert.equal((await engine.advance(jobId)).current, 'receive');
  const retried = await engine.retry(jobId, 'receive', lucy);
  assert.equal(stepOf(retried, 'receive').status, 'failed');
  await assert.rejects(engine.retry(jobId, 'match-patient', lucy), (e) => e.status === 409);
  await assert.rejects(engine.retry(jobId, 'clinical-check', lucy), (e) => e.status === 409);
  const audit = p.audit.list({ entity: 'job', entityId: jobId }).find((a) => a.action === 'flow.step' && a.data.type === 'receive');
  assert.equal(audit.data.status, 'failed');
});

test('stock shortfall is flagged; allowOwing=false fails the step and retry succeeds after restocking', async () => {
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  let tl = await engine.advance(firstJob(rx));
  assert.deepEqual(
    { onHand: stepOf(tl, 'check_stock').output.onHand, shortBy: stepOf(tl, 'check_stock').output.shortBy, status: stepOf(tl, 'check_stock').status },
    { onHand: 10, shortBy: 5, status: 'done' },
  );

  const strict = engine.createFlow(withSteps((s) => s.map((x) => (x.type === 'check_stock' ? { ...x, config: { allowOwing: false } } : x))), priya, 'e-script-standard');
  engine.activate(strict.id, priya);
  const rx2 = await p.intakeManual({
    source: 'phone', patient: { nhi: 'ZZZ0024', name: 'James Wilson' }, prescriber: { cpn: '34EFGH', name: 'Dr Sam Patel' },
    items: [{ medicineCode: 'AMX500', directions: 'Take ONE capsule three times daily', quantity: 15 }],
  }, tom);
  assert.equal((await engine.advance(firstJob(rx2))).flow.key, 'written-script'); // phone -> written flow

  // nzeps job under the strict flow
  const rx3 = await p.intakeManual({
    source: 'paper', document: { dataBase64: PNG_B64 }, patient: { nhi: 'ZZZ0024', name: 'James Wilson' }, prescriber: { cpn: '34EFGH', name: 'Dr Sam Patel' },
    items: [{ medicineCode: 'AMX500', directions: 'x', quantity: 15 }],
  }, tom);
  const strictWritten = engine.createFlow({ ...strict, name: 'Written script', appliesTo: ['paper'], steps: strict.steps.map((x) => (x.type === 'data_entry' ? { ...x, config: { autoFor: [] } } : x)) }, priya, 'a-strict-written');
  engine.activate(strictWritten.id, priya);
  const job3 = firstJob(rx3);
  await p.transition(job3, 'enter', lucy);
  tl = await engine.advance(job3);
  assert.equal(tl.flow.key, 'a-strict-written'); // first match by key order
  assert.equal(stepOf(tl, 'check_stock').status, 'failed');
  assert.equal(tl.current, 'check-stock');
  assert.equal(stepOf(tl, 'screen').status, 'pending');
  const amox = p.medicines().find((m) => m.code === 'AMX500');
  p.adjustStock(amox.id, 100, 'Wholesaler delivery', lucy);
  tl = await engine.retry(job3, 'check-stock', lucy);
  assert.equal(stepOf(tl, 'check_stock').status, 'done');
  assert.equal(tl.current, 'clinical-check');
});

test('screen with useAi=false runs rules only; hooks for formulary and print are used when present', async () => {
  const hooks = {
    formulary: { lookup: async (med) => ({ nzfUrl: `https://nzf.example/${med.code}`, source: 'NZF (test)' }) },
    print: { worksheetUrl: (jobId) => `/print/worksheet/${jobId}` },
  };
  engine = makeEngine(hooks);
  const def = withSteps((s) => s.map((x) => (x.type === 'screen' ? { ...x, config: { useAi: false } } : x)));
  engine.activate(engine.createFlow(def, priya, 'e-script-standard').id, priya);
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = firstJob(rx);
  let tl = await engine.advance(jobId);
  assert.equal(stepOf(tl, 'map_formulary').output.nzfUrl, 'https://nzf.example/MET500');
  assert.equal(stepOf(tl, 'screen').output.reviewer, 'none');
  assert.ok(adapters.reviewer, 'reviewer restored after the call');

  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
  tl = await engine.onTransition(jobId, 'clinical_check');
  assert.equal(stepOf(tl, 'print_worksheet').output.url, `/print/worksheet/${jobId}`);
  assert.equal(tl.current, 'assemble');
});

test('after final check, label/courier wait for release; on courier release they complete, then notify + claim', async () => {
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy); // single item
  const jobId = firstJob(rx);
  await engine.advance(jobId);
  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
  await engine.onTransition(jobId);
  await p.transition(jobId, 'assemble', lucy);
  await engine.onTransition(jobId);
  await p.transition(jobId, 'final_check', priya);
  let tl = await engine.onTransition(jobId);
  assert.equal(tl.current, 'handover');
  assert.equal(stepOf(tl, 'generate_label').status, 'waiting');
  assert.equal(stepOf(tl, 'book_courier').status, 'waiting');
  assert.equal(stepOf(tl, 'final_check').output.by, 'Priya Shah');

  const rel = await p.transition(jobId, 'release', lucy, { method: 'courier' });
  tl = await engine.onTransition(jobId, 'release');
  assert.equal(tl.current, null);
  assert.equal(stepOf(tl, 'handover').output.method, 'courier');
  assert.match(stepOf(tl, 'generate_label').output.label, /Rimu Rd/);
  assert.match(stepOf(tl, 'book_courier').output.trackingRef, /^MC\d+NZ$/);
  assert.equal(p.getFulfilment(rel.fulfilment_id).status, 'out_for_delivery');
  assert.match(stepOf(tl, 'notify_patient').output.message, /courier/);
  assert.equal(stepOf(tl, 'notify_patient').output.to, '***199');
  assert.ok(!/Amoxicillin/i.test(stepOf(tl, 'notify_patient').output.message));
  assert.equal(stepOf(tl, 'submit_claim').output.status, 'pending');
  assert.ok(tl.steps.every((s) => ['done', 'skipped'].includes(s.status)));
});

test('onPrescription advances every item; a courier order books once, after its last item is released', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const tls = await engine.onPrescription(rx);
  assert.deepEqual(tls.map((t) => t.current), ['clinical-check', 'clinical-check']);
  const [a, b] = rx.items.map((i) => i.jobs[0].id);
  for (const id of [a, b]) {
    await p.transition(id, 'clinical_check', priya, approveAll(id));
    await p.transition(id, 'assemble', lucy);
    await p.transition(id, 'final_check', priya);
  }
  const relA = await p.transition(a, 'release', lucy, { method: 'courier' });
  let tlA = await engine.onTransition(a);
  assert.equal(stepOf(tlA, 'book_courier').status, 'waiting');
  assert.match(stepOf(tlA, 'book_courier').output.reason, /other item\(s\) on this script/);
  assert.equal(tlA.current, 'book-courier'); // only a non-blocking wait is left

  const relB = await p.transition(b, 'release', lucy, { method: 'courier' });
  assert.equal(relB.fulfilment_id, relA.fulfilment_id);
  const tlB = await engine.onTransition(b);
  assert.equal(stepOf(tlB, 'book_courier').status, 'done');
  await engine.onFulfilment(relA.fulfilment_id);
  tlA = engine.timeline(a);
  assert.equal(stepOf(tlA, 'book_courier').output.alreadyBooked, true);
  assert.equal(stepOf(tlA, 'book_courier').output.trackingRef, stepOf(tlB, 'book_courier').output.trackingRef);
  const bookings = p.audit.list({ entity: 'fulfilment', entityId: relA.fulfilment_id }).filter((x) => x.action === 'fulfilment.dispatch');
  assert.equal(bookings.length, 1);
});

test('pickup release skips delivery label and courier', async () => {
  const rx = await writtenScript();
  const jobId = firstJob(rx);
  await p.transition(jobId, 'enter', lucy);
  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
  await p.transition(jobId, 'assemble', lucy);
  await p.transition(jobId, 'final_check', priya);
  await p.transition(jobId, 'release', lucy, { method: 'pickup' });
  // engine only told now: human steps are observed, screen is skipped (already past clinical check)
  const tl = await engine.advance(jobId);
  assert.equal(stepOf(tl, 'screen').status, 'skipped');
  assert.equal(stepOf(tl, 'generate_label').status, 'skipped');
  assert.equal(stepOf(tl, 'book_courier').status, 'skipped');
  assert.match(stepOf(tl, 'notify_patient').output.message, /ready to collect\. Pickup code: [A-Z0-9]{6}/);
  assert.equal(tl.current, null);
});

test('on hold pauses the flow; cancelling skips the rest', async () => {
  const rx = await writtenScript();
  const jobId = firstJob(rx);
  await engine.advance(jobId);
  await p.transition(jobId, 'hold', lucy, { reason: 'Waiting for prescriber' });
  await p.transition(jobId, 'resume', lucy);
  await p.transition(jobId, 'cancel', priya, { reason: 'Prescriber cancelled' });
  const tl = await engine.advance(jobId);
  assert.equal(stepOf(tl, 'data_entry').status, 'skipped');
  assert.ok(tl.steps.every((s) => ['done', 'skipped'].includes(s.status)));
});

test('map_formulary works with the real (synchronous) formulary module', async () => {
  engine = makeEngine({ formulary: createFormulary({ source: createLocalFormularySource() }) });
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const step = stepOf(await engine.advance(firstJob(rx)), 'map_formulary');
  assert.equal(step.status, 'done');
  assert.equal(step.output.matched, true);
  assert.equal(step.output.ingredient, 'metformin');
  assert.equal(step.output.source.licensed, false);
  assert.match(step.output.warnings[0], /not licensed/);
});

test('a hook that throws fails only its step, with the error recorded', async () => {
  engine = makeEngine({ formulary: { lookup: () => { throw new Error('formulary down'); } } });
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const tl = await engine.advance(firstJob(rx));
  assert.equal(stepOf(tl, 'map_formulary').status, 'failed');
  assert.equal(stepOf(tl, 'map_formulary').error, 'formulary down');
  assert.equal(tl.current, 'map-formulary');
  assert.equal(stepOf(tl, 'data_entry').status, 'pending');
});

// ───────────── API ─────────────

function captureRoutes() {
  const routes = {};
  registerFlowRoutes((method, pattern, handler) => { routes[`${method} ${pattern}`] = handler; }, { engine, platform: p });
  return routes;
}

test('routes: shapes and permissions', async () => {
  const r = captureRoutes();
  assert.deepEqual(Object.keys(r).sort(), [
    'GET /api/flows', 'GET /api/flows/catalogue', 'GET /api/jobs/:id/flow',
    'POST /api/flows', 'POST /api/flows/:id/activate', 'POST /api/flows/validate', 'POST /api/jobs/:id/flow/retry/:stepId',
  ]);
  const list = r['GET /api/flows']({});
  for (const f of list) assert.deepEqual(['id', 'key', 'version', 'name', 'active', 'appliesTo', 'steps', 'created_at'].filter((k) => !(k in f)), []);
  const cat = r['GET /api/flows/catalogue']({});
  assert.ok(cat.every((c) => ['type', 'kind', 'label', 'description', 'required', 'configSchema'].every((k) => k in c)));
  assert.ok(cat.flatMap((c) => c.configSchema).every((f) => ['key', 'label', 'type', 'default'].every((k) => k in f) && ['number', 'boolean', 'string', 'sources'].includes(f.type)));

  assert.deepEqual(r['POST /api/flows/validate']({ body: { definition: validDef() } }), { ok: true, errors: [] });
  assert.equal(r['POST /api/flows/validate']({ body: {} }).ok, false);

  for (const user of [lucy, ben, null]) {
    assert.throws(() => r['POST /api/flows']({ body: { definition: validDef() }, user }), (e) => e.status === 403);
    assert.throws(() => r['POST /api/flows/:id/activate']({ params: { id: '1' }, user }), (e) => e.status === 403);
  }
  assert.throws(() => r['POST /api/flows']({ body: { definition: validDef({ steps: [] }) }, user: priya }), (e) => e.status === 400 && e.details.errors.length > 0);
  const created = r['POST /api/flows']({ body: { definition: validDef({ name: 'Copy' }) }, user: priya });
  assert.equal(created.key, 'copy');
  const admin = { id: priya.id, role: 'admin', name: 'Admin' };
  assert.equal(r['POST /api/flows/:id/activate']({ params: { id: String(created.id) }, user: admin }).active, true);
  assert.throws(() => r['POST /api/flows/:id/activate']({ params: { id: '999' }, user: priya }), (e) => e.status === 404);

  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = firstJob(rx);
  assert.deepEqual(r['GET /api/jobs/:id/flow']({ params: { id: String(jobId) } }), { flow: null, steps: [], current: null });
  await engine.advance(jobId);
  const tl = r['GET /api/jobs/:id/flow']({ params: { id: String(jobId) } });
  assert.deepEqual(Object.keys(tl).sort(), ['current', 'flow', 'steps']);
  assert.deepEqual(Object.keys(tl.flow).sort(), ['id', 'key', 'name', 'version']);
  assert.deepEqual(Object.keys(tl.steps[0]).sort(), ['error', 'finished_at', 'kind', 'label', 'output', 'started_at', 'status', 'stepId', 'type']);
  assert.throws(() => r['GET /api/jobs/:id/flow']({ params: { id: '9999' } }), (e) => e.status === 404);

  await assert.rejects(async () => r['POST /api/jobs/:id/flow/retry/:stepId']({ params: { id: String(jobId), stepId: 'receive' }, user: ben }), (e) => e.status === 403);
  await assert.rejects(async () => r['POST /api/jobs/:id/flow/retry/:stepId']({ params: { id: String(jobId), stepId: 'receive' }, user: lucy }), (e) => e.status === 409);
  await assert.rejects(async () => r['POST /api/jobs/:id/flow/retry/:stepId']({ params: { id: String(jobId), stepId: 'nope' }, user: lucy }), (e) => e.status === 404);
});

test('routes work through the real HTTP handler when registered on a router', async () => {
  // Mirror src/server.js's router to confirm patterns don't collide with existing job routes.
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, pattern });
  };
  route('GET', '/api/jobs/:id', () => 'job');
  route('POST', '/api/jobs/:id/:action', () => 'action');
  registerFlowRoutes(route, { engine, platform: p });
  const match = (m, path) => routes.find((r) => r.method === m && r.re.test(path))?.pattern;
  assert.equal(match('GET', '/api/jobs/3/flow'), '/api/jobs/:id/flow');
  assert.equal(match('POST', '/api/jobs/3/flow/retry/check-stock'), '/api/jobs/:id/flow/retry/:stepId');
  assert.equal(match('GET', '/api/flows/catalogue'), '/api/flows/catalogue');
  assert.equal(match('POST', '/api/flows/7/activate'), '/api/flows/:id/activate');
});
