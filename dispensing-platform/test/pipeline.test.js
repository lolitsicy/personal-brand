// End-to-end: script arrives -> automated steps -> human checkpoints -> label/courier -> sign-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { makeScid } from '../src/domain/scid.js';

// Tests below exercise the optional clinical checks (demo data) and the offline AI reviewer;
// both are off by default in the product (see test/scope.test.js).
process.env.CLINICAL_CHECKS ??= 'demo';
process.env.AI_REVIEWER ??= 'mock';

const METFORMIN_SCID = makeScid('1A2B3C4D5E6F7G8H9'); // Aroha: metformin + atorvastatin
const OXY_SCID = makeScid('C1D2E3F4G5H6J7K8L'); // Grace: oxycodone (CD B) + paracetamol

function setup() {
  const app = createApp({ pipeline: true });
  const p = app.platform;
  const u = Object.fromEntries(p.users().map((x) => [x.name.split(' ')[0], x]));
  return { app, p, priya: u.Priya, tom: u.Tom, lucy: u.Lucy };
}
const statusOf = (tl, type) => tl.steps.find((s) => s.type === type)?.status;

function decisionsFor(p, jobId, user) {
  const decisions = {};
  for (const f of p.getJob(jobId, user).warnings ?? []) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Prescriber confirmed', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge', note: 'Reviewed' };
  }
  return { decisions, sourceVerified: true };
}

test('e-script runs automatically up to the pharmacist clinical check', async () => {
  const { app, p, lucy, priya } = setup();
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  assert.equal(p.getJob(jobId, priya).state, 'entered', 'structured e-script data entry auto-confirmed');
  const tl = app.flows.timeline(jobId);
  assert.equal(tl.flow.name, 'E-script standard');
  for (const t of ['receive', 'match_patient', 'verify_original', 'map_formulary', 'data_entry', 'check_stock', 'check_history', 'screen']) {
    assert.equal(statusOf(tl, t), 'done', `${t} should be done`);
  }
  assert.equal(statusOf(tl, 'clinical_check'), 'waiting');
  assert.equal(tl.steps.find((s) => s.stepId === tl.current).type, 'clinical_check');
  // Formulary findings are part of the screening the pharmacist sees
  const codes = p.getJob(jobId, priya).warnings.map((f) => f.code);
  assert.ok(codes.includes('NZF_RENAL'), 'formulary renal check (eGFR 38) present');
});

test('full journey: sign-off, worksheet, assembly, final check, courier booked and label ready on release', async () => {
  const { app, p, lucy, priya, tom } = setup();
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [a, b] = rx.items.map((i) => i.jobs[0].id);
  for (const id of [a, b]) {
    await p.transition(id, 'clinical_check', priya, decisionsFor(p, id, priya));
    assert.equal(statusOf(app.flows.timeline(id), 'print_worksheet'), 'done');
    assert.match(app.flows.timeline(id).steps.find((s) => s.type === 'print_worksheet').output.url, /\/api\/print\/jobs\/\d+\/worksheet/);
    assert.equal(statusOf(app.flows.timeline(id), 'assemble'), 'waiting');
    await p.transition(id, 'assemble', lucy);
    await p.transition(id, 'final_check', tom);
    assert.equal(statusOf(app.flows.timeline(id), 'handover'), 'waiting');
  }
  await p.transition(a, 'release', lucy, { method: 'courier' });
  await p.transition(b, 'release', lucy, { method: 'courier' });
  const tl = app.flows.timeline(b);
  assert.equal(statusOf(tl, 'book_courier'), 'done');
  const f = p.getFulfilment(p.getJob(b, lucy).fulfilment_id);
  assert.equal(f.status, 'out_for_delivery');
  assert.ok(f.tracking_ref, 'courier booked automatically');
  assert.equal(f.jobs.length, 2, 'both items in one parcel');
  assert.equal(statusOf(tl, 'generate_label'), 'done');
  assert.equal(statusOf(tl, 'submit_claim'), 'done');
  const label = app.print.labelHtml(f.id);
  assert.match(label, new RegExp(f.tracking_ref));
  assert.doesNotMatch(label, /Metformin|Atorvastatin/i, 'no medicine names on a courier label');
});

test('automation never performs a pharmacist checkpoint', async () => {
  const { app, p, lucy } = setup();
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  const id = rx.items[0].jobs[0].id;
  await app.flows.advance(id);
  await app.flows.advance(id);
  assert.equal(p.getJob(id, lucy).state, 'entered');
  assert.equal(p.getJob(id, lucy).clinical_checked_by, null);
});

test('written script waits for a person at data entry', async () => {
  const { app, p, lucy } = setup();
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const rx = await p.intakeManual({
    source: 'paper', document: { filename: 'scan.png', dataBase64: PNG_B64 },
    patient: { nhi: 'ZZZ0040', name: 'Wiremu Parata' }, prescriber: { name: 'Dr Anna Brooks' },
    items: [{ medicineCode: 'ATO40', directions: 'ONE at night', quantity: 30, doseUnits: 1, dosesPerDay: 1 }],
  }, lucy);
  const id = rx.items[0].jobs[0].id;
  const tl = app.flows.timeline(id);
  assert.equal(tl.flow.name, 'Written script');
  assert.equal(statusOf(tl, 'data_entry'), 'waiting');
  assert.equal(p.getJob(id, lucy).state, 'queued');
  await p.transition(id, 'enter', lucy);
  assert.equal(statusOf(app.flows.timeline(id), 'screen'), 'done');
  assert.equal(statusOf(app.flows.timeline(id), 'clinical_check'), 'waiting');
});

test('Automation user is hidden from the staff picker', () => {
  const { p } = setup();
  assert.ok(!p.users().some((u) => u.name === 'Automation'));
});
