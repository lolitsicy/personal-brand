// Guard: no internal identifiers in human-facing text. Opens every screen in a
// real browser and scans the visible text for code-style names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server.js';
import { makeScid } from '../src/domain/scid.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

const RAW = [
  /\b[a-z]+_[a-z_]+\b/,                         // snake_case: clinically_checked, out_for_delivery, data_entry
  /\bnzeps\b/,                                  // source id (the label is "NZePS")
  /mock-reviewer|claude:claude/,                // reviewer ids
  /\.rx\b/,                                     // made-up filenames
  /\b[a-z]+-[a-z]+-[a-z]+\b/,                   // kebab-case keys: e-script-standard
  /\b(queued|entered|signed_off|superseded)\b/, // raw state words used as values
];

test('visible UI text contains no internal identifiers', async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch { t.skip('Playwright/Chromium not available'); return; }
  const app = createApp({ pipeline: true });
  const p = app.platform;
  const u = Object.fromEntries(p.users().map((x) => [x.name.split(' ')[0], x]));
  for (const body of ['1A2B3C4D5E6F7G8H9', 'B7C8D9E0F1G2H3J4K', 'C1D2E3F4G5H6J7K8L']) await p.intakeFromSource('nzeps', makeScid(body), u.Lucy);
  // move one script all the way to a courier order so fulfilment/claims/audit have content
  const [first] = p.queue({}, u.Priya);
  const decisions = {};
  for (const f of p.getJob(first.id, u.Priya).warnings) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Prescriber confirmed', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge' };
  }
  await p.transition(first.id, 'clinical_check', u.Priya, { decisions, sourceVerified: true });
  await p.transition(first.id, 'assemble', u.Lucy);
  await p.transition(first.id, 'final_check', u.Tom);
  await p.transition(first.id, 'release', u.Lucy, { method: 'courier' });

  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  const offenders = [];
  const scan = async (where) => {
    await page.waitForTimeout(500);
    // Real English phrases that happen to look like identifiers.
    const ALLOWED = /over-the-counter|up-to-date|look-alike|sound-alike/gi;
    const text = (await page.evaluate(() => document.body.innerText)).replace(ALLOWED, '');
    for (const re of RAW) {
      const m = text.match(re);
      if (m) offenders.push(`${where}: "${m[0]}" in …${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…`);
    }
  };
  try {
    await page.goto(base);
    await page.evaluate((id) => localStorage.setItem('userId', String(id)), u.Priya.id);
    await page.reload();
    await scan('Today');
    for (const tab of ['queue', 'intake', 'prescriptions', 'counter', 'fulfilment', 'stock', 'claims', 'flows', 'safety', 'audit']) {
      await page.click(`[data-tab=${tab}]`);
      await scan(tab);
    }
    await page.click('[data-tab=queue]');
    await page.waitForTimeout(600);
    for (const id of await page.$$eval('.titem', (els) => els.map((e) => e.dataset.id))) {
      await page.locator(`.titem[data-id="${id}"]`).evaluate((el) => (el.closest('details').open = true));
      await page.locator(`.titem[data-id="${id}"]`).click();
      for (const tab of ['original', 'flow', 'reviewer']) {
        await page.locator(`[data-rail=${tab}]`).click();
        await scan(`script ${id} / ${tab}`);
      }
    }
    const worksheet = await (await fetch(`${base}/api/print/jobs/${first.id}/worksheet`, { headers: { 'X-User-Id': String(u.Priya.id) } })).text();
    await page.setContent(worksheet);
    await scan('worksheet');
  } finally {
    await browser.close();
    app.server.close();
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});
