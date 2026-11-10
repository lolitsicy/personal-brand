// Manual edits to the script before the clinical check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { makeScid } from '../src/domain/scid.js';

// Tests below exercise the optional clinical checks (demo data) and the offline AI reviewer;
// both are off by default in the product (see test/scope.test.js).
process.env.CLINICAL_CHECKS ??= 'demo';
process.env.AI_REVIEWER ??= 'mock';

const METFORMIN_SCID = makeScid('1A2B3C4D5E6F7G8H9');
const OXY_SCID = makeScid('C1D2E3F4G5H6J7K8L');

function setup(opts = {}) {
  const app = createApp(opts);
  const p = app.platform;
  const u = Object.fromEntries(p.users().map((x) => [x.name.split(' ')[0], x]));
  return { app, p, priya: u.Priya, lucy: u.Lucy, ben: u.Ben };
}
const signOff = (p, id, user) => {
  const decisions = {};
  for (const f of p.getJob(id, user).warnings ?? []) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Prescriber confirmed', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge' };
  }
  return { decisions, sourceVerified: true };
};

test('edit an entered e-script: changes recorded, original untouched, shown as differences', async () => {
  const { p, lucy } = setup();
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[0].jobs[0].id;
  await p.transition(id, 'enter', lucy);
  const j = await p.amend(id, lucy, { directions: 'Take ONE tablet twice daily with meals', quantity: 56, repeats: 1, reason: 'Clarified with prescriber by phone' });
  assert.equal(j.directions, 'Take ONE tablet twice daily with meals');
  assert.equal(j.quantity, 56);
  assert.equal(j.repeats_authorised, 1);
  const diff = j.original.compare.filter((c) => !c.match).map((c) => c.field).sort();
  assert.deepEqual(diff, ['Directions', 'Quantity', 'Repeats']);
  assert.equal(j.original.payload.items[0].quantity, 60, 'stored original unchanged');
  assert.equal(j.original.intact, true);
  assert.equal(j.original.amendments.at(-1).reason, 'Clarified with prescriber by phone');
});

test('edits need a reason, valid values, and dispensary staff', async () => {
  const { p, lucy, ben } = setup();
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[0].jobs[0].id;
  await assert.rejects(p.amend(id, lucy, { quantity: 30 }), /reason/);
  await assert.rejects(p.amend(id, lucy, { quantity: -3, reason: 'x' }), /positive whole number/);
  await assert.rejects(p.amend(id, lucy, { directions: '   ', reason: 'x' }), /cannot be empty/);
  await assert.rejects(p.amend(id, ben, { quantity: 30, reason: 'x' }), /dispensary staff/);
  await assert.rejects(p.amend(id, lucy, { quantity: 60, reason: 'same value' }), /Nothing changed/);
});

test('Class B controlled drug cannot be given repeats by editing', async () => {
  const { p, lucy } = setup();
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  await assert.rejects(p.amend(rx.items[0].jobs[0].id, lucy, { repeats: 2, reason: 'x' }), /Class B/);
});

test('no edits after the clinical check', async () => {
  const { p, lucy, priya } = setup();
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[1].jobs[0].id;
  await p.transition(id, 'enter', lucy);
  await p.transition(id, 'clinical_check', priya, signOff(p, id, priya));
  await assert.rejects(p.amend(id, lucy, { quantity: 28, reason: 'x' }), /before the clinical check/);
});

test('editing re-screens: a dose edit above the ceiling becomes a hard stop', async () => {
  const { p, lucy, priya } = setup();
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  const par = rx.items[1].jobs[0].id; // paracetamol 2 x 4/day = 4000 mg (at ceiling)
  await p.transition(par, 'enter', lucy);
  assert.ok(!p.getJob(par, priya).warnings.some((f) => f.severity === 'hard_stop'));
  const j = await p.amend(par, lucy, { doseUnits: 3, reason: 'Transcription check' });
  assert.ok(j.warnings.some((f) => f.code === 'DOSE_CEILING' && f.severity === 'hard_stop'));
  assert.equal(j.screening.status, 'pending', 'fresh screening after the edit');
  assert.ok(j.original.compare.find((c) => c.field === 'Dose' && !c.match));
});

test('HTTP: amend route works and then submit moves to the next step', async () => {
  const { app, p, lucy, priya } = setup({ pipeline: true });
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[1].jobs[0].id;
  assert.equal(p.getJob(id, lucy).state, 'entered', 'pipeline auto-entered the e-script');
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  try {
    const post = (path, user, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': String(user.id) }, body: JSON.stringify(body) });
    const r = await post(`/api/jobs/${id}/amend`, lucy, { quantity: 28, reason: '28-tablet subsidy pack' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).quantity, 28);
    const r2 = await post(`/api/jobs/${id}/clinical-check`, priya, signOff(p, id, priya));
    assert.equal(r2.status, 200);
    assert.equal(app.flows.timeline(id).steps.find((s) => s.type === 'clinical_check').status, 'done');
    assert.deepEqual(p.getJob(id, priya).warnings_acknowledged.sourceVerified.differences, ['Quantity']);
  } finally {
    app.server.close();
  }
});
