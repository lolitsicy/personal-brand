import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createMockAdapters } from '../src/adapters/index.js';
import { makeScid } from '../src/domain/scid.js';

const METFORMIN_SCID = makeScid('1A2B3C4D5E6F7G8H9'); // Aroha: metformin + atorvastatin, 2 repeats
const AMOX_SCID = makeScid('B7C8D9E0F1G2H3J4K'); // James (amoxicillin allergy)
const OXY_SCID = makeScid('C1D2E3F4G5H6J7K8L'); // Grace: oxycodone (Class B) + paracetamol

let app, p, adapters, priya, tom, lucy, ben;

// Smallest valid PNG (1x1), standing in for a scanned paper script.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const scan = () => ({ filename: 'script-scan.png', dataBase64: PNG_B64 });

beforeEach(() => {
  adapters = createMockAdapters();
  app = createApp({ adapters });
  p = app.platform;
  const byName = Object.fromEntries(p.users().map((u) => [u.name.split(' ')[0], u]));
  ({ Priya: priya, Tom: tom, Lucy: lucy, Ben: ben } = byName);
});

/** Pharmacist decisions that clear every finding (overrides hard stops with prescriber confirmation). */
function approveAll(jobId) {
  const decisions = {};
  for (const f of p.getJob(jobId, priya).warnings ?? []) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Discussed with prescriber; benefit outweighs risk', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge', note: 'Reviewed' };
  }
  return { decisions, sourceVerified: true };
}

async function runToChecked(jobId) {
  await p.transition(jobId, 'enter', lucy);
  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
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
  await assert.rejects(p.transition(jobId, 'clinical_check', lucy), /can't do the clinical check/);
});

test('the person who assembled cannot also do the final check', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await p.transition(jobId, 'enter', priya);
  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
  await p.transition(jobId, 'assemble', priya);
  await assert.rejects(p.transition(jobId, 'final_check', priya), /different person/);
  const ok = await p.transition(jobId, 'final_check', tom);
  assert.equal(ok.state, 'checked');
});

test('class allergy (penicillin -> amoxicillin) is a hard stop: acknowledging is not enough, override needs reason + prescriber contact', async () => {
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await p.transition(jobId, 'enter', lucy);
  await assert.rejects(p.transition(jobId, 'clinical_check', priya), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.details.findings[0].code, 'ALLERGY');
    assert.equal(err.details.findings[0].severity, 'hard_stop');
    return true;
  });
  await assert.rejects(p.transition(jobId, 'clinical_check', priya, { acknowledge: true, note: 'fine' }), /Hard stop/);
  const id = p.getJob(jobId, priya).warnings[0].id;
  await assert.rejects(p.transition(jobId, 'clinical_check', priya, { decisions: { [id]: { action: 'override', reason: 'x' } } }), /prescriber/);
  const ok = await p.transition(jobId, 'clinical_check', priya, { sourceVerified: true, decisions: { [id]: { action: 'override', reason: 'Prescriber confirmed: childhood rash only, tolerated cefalexin', prescriberConfirmed: true } } });
  assert.equal(ok.state, 'clinically_checked');
  const log = p.overridesLog();
  assert.equal(log[0].code, 'ALLERGY');
  assert.equal(log[0].action, 'override');
  assert.equal(log[0].prescriberConfirmed, true);
});

test('repeats: limited to authorised count, broker ends at Dispensed', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const itemId = rx.items[0].id;
  let jobId = rx.items[0].jobs[0].id;
  for (let supply = 0; supply < 3; supply++) {
    await runToChecked(jobId); // repeats are early in a test -> EARLY_REPEAT warning, approved by approveAll
    await p.transition(jobId, 'release', lucy, { method: 'pickup' });
    if (supply < 2) {
      await assert.rejects(Promise.resolve().then(() => p.requestRepeat(itemId, lucy)).then(() => p.requestRepeat(itemId, lucy)), /already has a supply in progress/);
      jobId = p.getPrescription(rx.id).items[0].jobs.at(-1).id;
    }
  }
  await assert.rejects(Promise.resolve().then(() => p.requestRepeat(itemId, lucy)), /No repeats left to dispense/);
  assert.match(adapters.scriptSources.nzeps.list()[0].items[0], /\(Dispensed\)/);
});

test('early repeat triggers a warning', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [jobId] = jobsOf(rx);
  await runToChecked(jobId);
  await p.transition(jobId, 'release', lucy, {});
  const repeat = p.requestRepeat(rx.items[0].id, lucy);
  await p.transition(repeat.id, 'enter', lucy);
  const early = p.getJob(repeat.id, priya).warnings.find((w) => w.code === 'EARLY_REPEAT');
  assert.equal(early.severity, 'high');
  assert.ok(early.trace.inputs.daysSince === 0);
  await assert.rejects(p.transition(repeat.id, 'clinical_check', priya), /EARLY|days after the last supply|must be reviewed/);
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
      source: 'paper', document: scan(),
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
  const checked = await runToChecked(jobId);
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
  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
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

// ───────────── screening + counter + stock ─────────────

test('whole-list screening: renal, interaction with medication history, LASA and language — each with a reasoning trace', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const [metJob, atoJob] = jobsOf(rx);
  const met = p.getJob(metJob, priya).warnings;
  const renal = met.find((f) => f.code === 'RENAL_ADJUST');
  assert.equal(renal.severity, 'high');
  assert.deepEqual(renal.trace.inputs, { egfr: 38, threshold: 45 });
  assert.ok(met.some((f) => f.code === 'LASA' && /Metronidazole/.test(f.message)));
  assert.ok(met.some((f) => f.code === 'LANGUAGE' && f.specialist === 'advocacy'));

  const ato = p.getJob(atoJob, priya).warnings;
  const ix = ato.find((f) => f.code === 'INTERACTION');
  assert.equal(ix.specialist, 'pharmacology');
  assert.match(ix.message, /clarithromycin/i);
  assert.match(ix.trace.inputs.other.source, /another pharmacy/);
});

test('dose ceiling is a hard stop computed from structured dose', async () => {
  const rx = await p.intakeManual({
    source: 'paper', document: scan(),
    patient: { nhi: 'ZZZ0032', name: 'Grace Lee', dob: '1972-06-21' },
    prescriber: { cpn: '56JKLM', name: 'Dr Hana Kim' },
    items: [{ medicineCode: 'PAR500', directions: 'Take THREE tablets four times daily', quantity: 100, doseUnits: 3, dosesPerDay: 4 }],
  }, lucy);
  const f = p.getJob(rx.items[0].jobs[0].id, priya).warnings.find((x) => x.code === 'DOSE_CEILING');
  assert.equal(f.severity, 'hard_stop');
  assert.equal(f.trace.inputs.dailyMg, 6000);
});

test('AI reviewer: receives de-identified case, adds findings, can never clear or downgrade rule findings', async () => {
  let seen;
  adapters.reviewer = {
    name: 'test-reviewer',
    async review(c) {
      seen = c;
      return {
        findings: [
          { specialist: 'pharma', severity: 'hard_stop', code: 'AI_TRY_HARD_STOP', message: 'AI tries to raise a hard stop', reasoning: 'r', sources: [] },
          { specialist: 'pharmacology', severity: 'high', code: 'CYP', message: 'AI: additional CYP concern', reasoning: 'mechanism', sources: ['product data sheet'] },
        ],
        counselling: { language: 'mi', text: 'Kōrero tohutohu' },
      };
    },
  };
  app = createApp({ adapters });
  p = app.platform;
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  const s = await p.runScreening(jobId, lucy);

  // de-identified: no name / NHI / address / dob
  const blob = JSON.stringify(seen);
  for (const pii of ['James', 'Wilson', 'ZZZ0024', 'Rimu', '1990-11-02']) assert.ok(!blob.includes(pii), `leaked ${pii}`);
  assert.equal(seen.age_band, '30-39');

  const ai = s.findings.filter((f) => f.origin === 'ai');
  assert.equal(ai.find((f) => f.code === 'AI_TRY_HARD_STOP').severity, 'moderate', 'AI cannot raise hard stops');
  assert.equal(ai.find((f) => f.code === 'CYP').trace.source, 'product data sheet');
  assert.equal(s.counselling.language, 'mi');
  assert.equal(s.findings[0].code, 'ALLERGY'); // rule finding still first and still a hard stop

  await p.transition(jobId, 'enter', lucy);
  // acknowledging AI "high" without overriding the rule hard stop still fails
  await assert.rejects(p.transition(jobId, 'clinical_check', priya, { acknowledge: true }), /Hard stop/);
  const ok = await p.transition(jobId, 'clinical_check', priya, approveAllWithAi(jobId));
  assert.equal(ok.state, 'clinically_checked');
  assert.equal(p.getJob(jobId, priya).screening.status, 'signed_off');
});

function approveAllWithAi(jobId) {
  const job = p.getJob(jobId, priya);
  const decisions = {};
  for (const f of job.warnings) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Prescriber confirmed', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge' };
  }
  return { decisions, sourceVerified: true };
}

test('AI reviewer failure falls back to rules-only screening', async () => {
  adapters.reviewer = { name: 'broken', async review() { throw new Error('network down'); } };
  app = createApp({ adapters });
  p = app.platform;
  const rx = await p.intakeFromSource('nzeps', AMOX_SCID, lucy);
  const s = await p.runScreening(rx.items[0].jobs[0].id, lucy);
  assert.ok(s.findings.some((f) => f.code === 'ALLERGY'));
  assert.ok(s.findings.some((f) => f.code === 'AI_STATUS' && /network down/.test(f.message)));
});

async function releasedPickup() {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const ids = jobsOf(rx);
  let last;
  for (const id of ids) {
    await runToChecked(id);
    last = await p.transition(id, 'release', lucy, { method: 'pickup' });
  }
  return { ids, fulfilment: p.getFulfilment(last.fulfilment_id) };
}

test('counter: pickup code + OTC in one basket, card payment completes the pickup and decrements OTC stock', async () => {
  const c = app.counter;
  const { fulfilment, ids } = await releasedPickup();
  assert.match(fulfilment.pickup_code, /^[A-Z2-9]{6}$/);
  const ibu = c.otcProducts().find((m) => m.code === 'IBU-OTC24');

  let sale = c.openSale(lucy);
  sale = c.addByPickupCode(sale.id, lucy, fulfilment.pickup_code.toLowerCase());
  assert.equal(sale.lines.length, 2);
  assert.throws(() => c.addByPickupCode(sale.id, lucy, fulfilment.pickup_code), /already in a basket/);
  sale = c.addLine(sale.id, lucy, { kind: 'otc', medicineId: ibu.id, quantity: 2 });
  assert.equal(sale.total_cents, 500 + 500 + 899 * 2);
  assert.equal(sale.gst_cents, Math.round((sale.total_cents * 3) / 23));

  const paid = await c.pay(sale.id, lucy, { method: 'card' });
  assert.equal(paid.status, 'paid');
  assert.match(paid.payment_ref, /^pi_mock_/);
  assert.equal(p.getFulfilment(fulfilment.id).status, 'completed');
  for (const id of ids) assert.equal(p.getJob(id, lucy).state, 'completed');
  assert.equal(c.otcProducts().find((m) => m.id === ibu.id).on_hand, ibu.on_hand - 2);
});

test('counter: refunds restock OTC but never prescription medicines; pharmacist only', async () => {
  const c = app.counter;
  const { fulfilment } = await releasedPickup();
  const lor = c.otcProducts().find((m) => m.code === 'LOR-OTC30');
  let sale = c.openSale(lucy);
  c.addByPickupCode(sale.id, lucy, fulfilment.pickup_code);
  sale = c.addLine(sale.id, lucy, { kind: 'otc', medicineId: lor.id, quantity: 1 });
  await c.pay(sale.id, lucy, { method: 'cash' });
  await assert.rejects(c.refund(sale.id, lucy, { reason: 'x' }), /pharmacist/);
  const met = p.medicines().find((m) => m.code === 'MET500').on_hand;
  const r = await c.refund(sale.id, priya, { reason: 'Customer changed mind' });
  assert.equal(r.status, 'refunded');
  assert.equal(c.otcProducts().find((m) => m.id === lor.id).on_hand, lor.on_hand);
  assert.equal(p.medicines().find((m) => m.code === 'MET500').on_hand, met, 'Rx stock not restocked');
  const eod = c.endOfDay();
  assert.equal(eod.netCents, 0);
  assert.match(c.accountingCsv(), /REFUND/);
  assert.ok(!c.accountingCsv().includes('Aroha'), 'no patient names in the accounting export');
});

test('counter: controlled drug in basket requires proof of collection', async () => {
  const c = app.counter;
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  for (const id of jobsOf(rx)) { await runToChecked(id); await p.transition(id, 'release', lucy, { method: 'pickup' }); }
  const f = p.listFulfilments().find((x) => x.method === 'pickup' && x.status === 'open');
  const sale = c.openSale(lucy);
  c.addByPickupCode(sale.id, lucy, f.pickup_code);
  await assert.rejects(c.pay(sale.id, lucy, { method: 'card' }), /Controlled drug/);
  const paid = await c.pay(sale.id, lucy, { method: 'card', proof: 'Patient, driver licence sighted' });
  assert.equal(paid.status, 'paid');
});

test('stock ledger records every movement; reorder draft rounds to packs', async () => {
  const amox = p.medicines().find((m) => m.code === 'AMX500'); // 10 on hand, reorder point 20, par 60
  const draft = p.reorderDraft();
  const line = draft.lines.find((l) => l.code === 'AMX500');
  assert.equal(line.packs, 3); // need 50 -> 3 packs of 20
  assert.equal(line.units, 60);
  p.adjustStock(amox.id, 60, 'Wholesaler invoice 123', lucy);
  assert.equal(p.stockLedger(amox.id)[0].kind, 'received');
  assert.ok(!p.reorderDraft().lines.some((l) => l.code === 'AMX500'));
});

test('HTTP: screening route is reachable (not swallowed by the generic job action route)', async () => {
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  try {
    const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
    const id = rx.items[1].jobs[0].id;
    const res = await fetch(`${base}/api/jobs/${id}/screen`, { method: 'POST', headers: { 'X-User-Id': String(lucy.id) } });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.status, 'pending');
    assert.ok(s.counselling);
  } finally {
    app.server.close();
  }
});

// ───────────── original script: what was received is what is reviewed ─────────────

test('e-script is stored exactly as received, fingerprinted, and matches what is dispensed', async () => {
  const raw = JSON.stringify(await adapters.scriptSources.nzeps.fetch(METFORMIN_SCID));
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const o = p.originalFor(rx.id, rx.items[0].id);
  assert.equal(o.kind, 'electronic');
  assert.equal(JSON.stringify(o.payload), raw, 'byte-for-byte the broker response');
  assert.equal(o.intact, true);
  assert.ok(o.compare.length >= 4);
  assert.ok(o.compare.every((c) => c.match));
});

test('clinical check requires confirming the original was checked', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[1].jobs[0].id;
  await p.transition(id, 'enter', lucy);
  const { decisions } = approveAll(id);
  await assert.rejects(p.transition(id, 'clinical_check', priya, { decisions }), /original/);
  const ok = await p.transition(id, 'clinical_check', priya, { decisions, sourceVerified: true });
  assert.equal(ok.warnings_acknowledged.sourceVerified.by, priya.id);
});

test('amending at data entry needs a reason and shows as a difference against the original', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[0].jobs[0].id;
  await assert.rejects(p.transition(id, 'enter', lucy, { amend: { quantity: 56 } }), /reason/);
  const j = await p.transition(id, 'enter', lucy, { amend: { quantity: 56, reason: 'Rounded to 4 x 14 blister packs' } });
  assert.equal(j.quantity, 56);
  const diff = j.original.compare.filter((c) => !c.match);
  assert.deepEqual(diff.map((c) => c.field), ['Quantity']);
  assert.equal(diff[0].received, '60');
  assert.equal(j.original.amendments[0].reason, 'Rounded to 4 x 14 blister packs');
  await p.transition(id, 'clinical_check', priya, approveAll(id));
  assert.deepEqual(p.getJob(id, priya).warnings_acknowledged.sourceVerified.differences, ['Quantity']);
});

test('tampering with the stored original blocks the clinical check', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const id = rx.items[1].jobs[0].id;
  await p.transition(id, 'enter', lucy);
  app.db.prepare("UPDATE prescriptions SET source_payload = replace(source_payload, '\"quantity\":30', '\"quantity\":300') WHERE id = ?").run(rx.id);
  assert.equal(p.originalFor(rx.id).intact, false);
  await assert.rejects(p.transition(id, 'clinical_check', priya, approveAll(id)), /integrity/);
});

test('paper scripts need the scan attached; it is stored, fingerprinted and served back unchanged', async () => {
  const base = { source: 'paper', patient: { nhi: 'ZZZ0040', name: 'Wiremu Parata' }, prescriber: { name: 'Dr Anna Brooks' }, items: [{ medicineCode: 'ATO40', directions: 'ONE at night', quantity: 30 }] };
  await assert.rejects(p.intakeManual(base, lucy), /scan or photo/);
  await assert.rejects(p.intakeManual({ ...base, document: { dataBase64: Buffer.from('<svg/>').toString('base64') } }, lucy), /PNG, JPEG or PDF/);
  const rx = await p.intakeManual({ ...base, document: scan() }, lucy);
  const o = p.originalFor(rx.id, rx.items[0].id);
  assert.equal(o.kind, 'document');
  assert.equal(o.documents[0].mime, 'image/png');
  assert.equal(o.documents[0].intact, true);
  assert.equal(Buffer.from(p.getDocument(rx.id, o.documents[0].id).data).toString('base64'), PNG_B64);
  // verbal phone orders are allowed without a document
  const phone = await p.intakeManual({ ...base, source: 'phone' }, lucy);
  assert.equal(p.originalFor(phone.id).kind, 'verbal');
});
