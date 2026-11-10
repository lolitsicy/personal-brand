// Version 1 scope: by default the platform runs the pharmacist checks, the
// original-vs-dispensing comparison, allergy, same-medicine duplicates, early
// repeats and controlled-drug markers. Formulary-based clinical checks wait for
// a licensed NZ Formulary; the AI reviewer is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resolveClinicalChecks } from '../src/server.js';
import { createReviewer } from '../src/adapters/index.js';
import { makeScid } from '../src/domain/scid.js';

delete process.env.CLINICAL_CHECKS;
delete process.env.AI_REVIEWER;

test('defaults: clinical checks off unless NZF is configured; AI reviewer off', () => {
  assert.equal(resolveClinicalChecks({}), 'off');
  assert.equal(resolveClinicalChecks({ NZF_BASE_URL: 'https://example', NZF_API_KEY: 'k' }), 'licensed');
  assert.equal(resolveClinicalChecks({ CLINICAL_CHECKS: 'demo' }), 'demo');
  assert.equal(createReviewer(undefined), null);
});

test('version 1 screening: allergy and duplicates run; interactions, dose and renal do not', async () => {
  const app = createApp();
  const p = app.platform;
  const u = Object.fromEntries(p.users().map((x) => [x.name.split(' ')[0], x]));
  // James: penicillin allergy -> still a hard stop
  const amox = await p.intakeFromSource('nzeps', makeScid('B7C8D9E0F1G2H3J4K'), u.Lucy);
  const amoxCodes = p.getJob(amox.items[0].jobs[0].id, u.Priya).warnings.map((f) => f.code);
  assert.ok(amoxCodes.includes('ALLERGY'));
  // Aroha: renal (eGFR 38) and clarithromycin interaction would fire with clinical checks on
  const rx = await p.intakeFromSource('nzeps', makeScid('1A2B3C4D5E6F7G8H9'), u.Lucy);
  const all = rx.items.flatMap((i) => p.getJob(i.jobs[0].id, u.Priya).warnings.map((f) => f.code));
  for (const off of ['INTERACTION', 'RENAL_ADJUST', 'LASA', 'DOSE_CEILING', 'NZF_RENAL', 'NZF_INTERACTION']) assert.ok(!all.includes(off), `${off} should be off`);
  // screening runs without an AI reviewer and produces no AI findings
  const s = await p.runScreening(rx.items[1].jobs[0].id, u.Lucy);
  assert.ok(!s.findings.some((f) => f.origin === 'ai'));
  assert.equal(s.counselling, null);
});

test('config endpoint reports what is switched on', async () => {
  const app = createApp();
  await new Promise((r) => app.server.listen(0, r));
  try {
    const cfg = await (await fetch(`http://localhost:${app.server.address().port}/api/config`)).json();
    assert.equal(cfg.clinicalChecks, 'off');
    assert.equal(cfg.aiReviewer, false);
  } finally {
    app.server.close();
  }
});
