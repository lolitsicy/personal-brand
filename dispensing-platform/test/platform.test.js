import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createMockAdapters } from '../src/adapters/index.js';
import { makeScid } from '../src/domain/scid.js';

const METFORMIN_SCID = makeScid('1A2B3C4D5E6F7G8H9'); // Aroha: metformin + atorvastatin, 2 repeats
const AMOX_SCID = makeScid('B7C8D9E0F1G2H3J4K'); // James (amoxicillin allergy)
const OXY_SCID = makeScid('C1D2E3F4G5H6J7K8L'); // Grace: oxycodone (Class B) + paracetamol

let app, p, adapters, priya, tom, lucy, ben;

beforeEach(() => {
  adapters = createMockAdapters();
  app = createApp({ adapters });
  p = app.platform;
  const byName = Object.fromEntries(p.users().map((u) => [u.name.split(' ')[0], u]));
  ({ Priya: priya, Tom: tom, Lucy: lucy, Ben: ben } = byName);
});

async function runToChecked(jobId, { acknowledge = false } = {}) {
  await p.transition(jobId, 'enter', lucy);
  await p.transition(jobId, 'clinical_check', priya, { acknowledge });
  await p.transition(jobId, 'assemble', lucy);
  return p.transition(jobId, 'final_check', priya);
}

const jobsOf = (rx) => rx.items.map((i) => i.jobs.at(-1).id);

test('e-script intake creates a prescription with one queued job per item', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  assert.equal(rx.source, 'nzeps');
  assert.equal(rx.items.length, 2);
  assert.deepEqual(rx.items.map((i) => i.jobs[0].state), ['queued', 'queued']);
});

test('the same SCID cannot be received twice', async () => {
  await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  await assert.rejects(p.intakeFromSource('nzeps', METFORMIN_SCID, lucy), /already been received/);
});

test('unknown SCID returns the broker BUS002 error; malformed SCID is rejected before calling the broker', async () => {
  await assert.rejects(p.intakeFromSource('nzeps', makeScid('ZZZZZZZZZZZZZZZZZ'), lucy), /BUS002/);
  await assert.rejects(p.intakeFromSource('nzeps', 'NOT-A-REAL-SCID', lucy), /18 characters/);
});

test('full happy path: dispense, release, claim created, broker updated, pickup completed', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await runToChecked(jobId);
  const released = await p.transition(jobId, 'release', lucy, { method: 'pickup' });
  assert.equal(released.state, 'released');
  assert.match(released.label_text, /Checked: PS/);
  assert.equal(p.listClaims({ status: 'pending' }).length, 1);
  assert.match(adapters.scriptSources.nzeps.list()[0].items[0], /Repeats Remaining/);

  const f = p.getFulfilment(released.fulfilment_id);
  assert.equal(f.ready, true);
  const done = await p.fulfilmentAction(f.id, 'complete', lucy, {});
  assert.equal(done.status, 'completed');
  assert.equal(p.getJob(jobId, lucy).state, 'completed');
});

test('roles are enforced: a technician cannot clinically check or final check', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await p.transition(jobId, 'enter', lucy);
  await assert.rejects(p.transition(jobId, 'clinical_check', lucy), /cannot clinical check/);
});

test('the person who assembled cannot also do the final check', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await p.transition(jobId, 'enter', priya);
  await p.transition(jobId, 'clinical_check', priya);
  await p.transition(jobId, 'assemble', priya);
  await assert.rejects(p.transition(jobId, 'final_check', priya), /different person/);
  const ok = await p.transition(jobId, 'final_check', tom);
  assert.equal(ok.state, 'checked');
});

test('allergy warning blocks the clinical check until acknowledged', async () => {
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await p.transition(jobId, 'enter', lucy);
  await assert.rejects(p.transition(jobId, 'clinical_check', priya), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.details.warnings[0].code, 'ALLERGY');
    return true;
  });
  const ok = await p.transition(jobId, 'clinical_check', priya, { acknowledge: true, note: 'Spoke to prescriber; rash only, proceed' });
  assert.equal(ok.state, 'clinically_checked');
});

test('repeats: limited to authorised count, broker ends at Dispensed', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const itemId = rx.items[0].id;
  let jobId = rx.items[0].jobs[0].id;
  for (let supply = 0; supply < 3; supply++) {
    await runToChecked(jobId, { acknowledge: true }); // repeats are early in a test -> EARLY_REPEAT warning
    await p.transition(jobId, 'release', lucy, { method: 'pickup' });
    if (supply < 2) {
      await assert.rejects(Promise.resolve().then(() => p.requestRepeat(itemId, lucy)).then(() => p.requestRepeat(itemId, lucy)), /already has a supply in progress/);
      jobId = p.getPrescription(rx.id).items[0].jobs.at(-1).id;
    }
  }
  await assert.rejects(Promise.resolve().then(() => p.requestRepeat(itemId, lucy)), /completed; no repeats left/);
  assert.match(adapters.scriptSources.nzeps.list()[0].items[0], /\(Dispensed\)/);
});

test('early repeat triggers a warning', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await runToChecked(jobId);
  await p.transition(jobId, 'release', lucy, {});
  const repeat = p.requestRepeat(rx.items[0].id, lucy);
  await p.transition(repeat.id, 'enter', lucy);
  await assert.rejects(p.transition(repeat.id, 'clinical_check', priya), (err) =>
    err.details.warnings.some((w) => w.code === 'EARLY_REPEAT'));
});

test('controlled drug: register tracks every movement and pickup needs proof of collection', async () => {
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  const oxyJob = rx.items[0].jobs[0].id;
  const parJob = rx.items[1].jobs[0].id;
  const oxy = p.medicines().find((m) => m.code === 'OXY5');
  const opening = oxy.on_hand;

  const checked = await runToChecked(oxyJob);
  assert.equal(checked.quantity_supplied, 20);
  const reg = p.cdRegister(oxy.id);
  assert.equal(reg[0].change, -20);
  assert.equal(reg[0].balance, opening - 20);

  await p.transition(oxyJob, 'release', lucy, { method: 'pickup' });
  await runToChecked(parJob);
  const rel = await p.transition(parJob, 'release', lucy, { method: 'pickup' });
  await assert.rejects(p.fulfilmentAction(rel.fulfilment_id, 'complete', lucy, {}), /proof/);
  const done = await p.fulfilmentAction(rel.fulfilment_id, 'complete', lucy, { proof: 'Collected by patient, photo ID sighted' });
  assert.equal(done.status, 'completed');
});

test('Class B script with repeats is rejected at intake', async () => {
  await assert.rejects(
    p.intakeManual({
      source: 'paper',
      patient: { nhi: 'ZZZ0032', name: 'Grace Lee' },
      prescriber: { cpn: '56JKLM', name: 'Dr Hana Kim' },
      items: [{ medicineCode: 'OXY5', directions: 'as directed', quantity: 20, repeats: 2 }],
    }, lucy),
    /cannot carry repeats/,
  );
});

test('short stock creates an owing that can be supplied later', async () => {
  const amox = p.medicines().find((m) => m.code === 'AMX500'); // 10 in stock, script is for 15
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  const checked = await runToChecked(jobId, { acknowledge: true });
  assert.equal(checked.quantity_supplied, 10);
  assert.equal(checked.owing, 5);
  await assert.rejects(Promise.resolve().then(() => p.supplyOwing(jobId, lucy)), /no stock/);
  p.adjustStock(amox.id, 20, 'Wholesaler delivery', lucy);
  const after = p.supplyOwing(jobId, lucy);
  assert.equal(after.owing, 0);
  assert.equal(after.quantity_supplied, 15);
});

test('cancelling an assembled job returns stock (and CD register) ', async () => {
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  const oxyId = p.medicines().find((m) => m.code === 'OXY5').id;
  const before = p.medicines().find((m) => m.id === oxyId).on_hand;
  await p.transition(jobId, 'enter', lucy);
  await p.transition(jobId, 'clinical_check', priya);
  await p.transition(jobId, 'assemble', lucy);
  await p.transition(jobId, 'hold', lucy, { reason: 'Patient query' });
  await p.transition(jobId, 'cancel', priya, { reason: 'Prescriber cancelled' });
  assert.equal(p.medicines().find((m) => m.id === oxyId).on_hand, before);
  assert.equal(p.cdRegister(oxyId)[0].change, 20);
});

test('courier fulfilment: dispatch books courier, then completes', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [a, b] = jobsOf(rx);
  await runToChecked(a);
  const r1 = await p.transition(a, 'release', lucy, { method: 'courier' });
  await assert.rejects(p.fulfilmentAction(r1.fulfilment_id, 'complete', ben, {}), /out_for_delivery|open/);
  await runToChecked(b);
  const r2 = await p.transition(b, 'release', lucy, { method: 'courier' });
  assert.equal(r1.fulfilment_id, r2.fulfilment_id, 'both items go in the same parcel');
  const sent = await p.fulfilmentAction(r1.fulfilment_id, 'dispatch', lucy, {});
  assert.equal(sent.status, 'out_for_delivery');
  assert.match(sent.tracking_ref, /^MC\d+NZ$/);
  const done = await p.fulfilmentAction(r1.fulfilment_id, 'complete', ben, { proof: 'Left with neighbour at #6' });
  assert.equal(done.status, 'completed');
});

test('claims batch submission marks claims accepted', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  for (const id of jobsOf(rx)) {
    await runToChecked(id);
    await p.transition(id, 'release', lucy, {});
  }
  await assert.rejects(p.submitClaims(lucy), /pharmacist/);
  const res = await p.submitClaims(priya);
  assert.equal(res.submitted, 2);
  assert.equal(res.accepted, 2);
  assert.match(p.claimsCsv(), /MET500/);
});

test('audit log is hash-chained and detects tampering', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  await runToChecked(rx.items[0].jobs[0].id);
  assert.equal(p.audit.verify().ok, true);
  app.db.prepare("UPDATE audit_log SET data = '{}' WHERE id = 2").run();
  const v = p.audit.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('HTTP API: intake and queue over the wire', async () => {
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  try {
    const res = await fetch(`${base}/api/intake/nzeps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(lucy.id) },
      body: JSON.stringify({ scid: METFORMIN_SCID }),
    });
    assert.equal(res.status, 200);
    const queue = await (await fetch(`${base}/api/queue`, { headers: { 'X-User-Id': String(lucy.id) } })).json();
    assert.equal(queue.length, 2);
    assert.ok(queue[0].actions.includes('enter'));
    const noUser = await fetch(`${base}/api/jobs/${queue[0].id}/enter`, { method: 'POST' });
    assert.equal(noUser.status, 401);
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
  } finally {
    app.server.close();
  }
});
