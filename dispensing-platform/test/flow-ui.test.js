// Browser test for the pharmacy flow UI (public/flow.js) against the
// standalone harness public/flow-demo.html, which mocks the flow API in-page.
// Served by the real static server from createApp(). Skips when Playwright
// isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../src/server.js';

let chromium = null;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require('playwright'));
} catch { /* not installed */ }

test('flow designer and timeline (browser)', async (t) => {
  if (!chromium) return t.skip('playwright is not installed');

  const app = createApp();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    await new Promise((r) => app.server.close(r));
    return t.skip(`chromium could not launch: ${e.message}`);
  }

  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 2200 } }); // tall: the whole chain fits, so drags need no scrolling
  // Keep the test offline: stub the web fonts the page links to.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  const order = () => page.$$eval('.fd-chain .fd-step', (els) => els.map((e) => e.dataset.id));
  const step = (id) => page.locator(`.fd-step[data-id="${id}"]`);
  const settle = () => page.waitForFunction(() => !document.querySelector('.fd-status.checking'));

  try {
    await page.goto(`${base}/flow-demo.html`);
    await page.waitForFunction(() => window.__ready === true);
    await settle();

    await t.test('lists flows grouped by key with versions and an active marker', async () => {
      assert.equal(await page.locator('.fd-group').count(), 2);
      assert.equal(await page.locator('.fd-version').count(), 4);
      assert.equal(await page.locator('.fd-version .fd-active').count(), 2);
      assert.match(await page.locator('.fd-version.sel').innerText(), /v2/);
      assert.ok((await page.locator('.fd-group').first().innerText()).includes('NZePS'));
    });

    await t.test('renders the active flow as a chain of auto and human steps', async () => {
      const ids = await order();
      assert.equal(ids.length, 16);
      assert.equal(ids[0], 'receive');
      assert.equal(await page.locator('.fd-step.human').count(), 5);
      assert.ok(await step('clinical-check').evaluate((el) => el.classList.contains('human')));
      assert.ok(await step('screen').evaluate((el) => el.classList.contains('auto')));
      assert.match(await step('clinical-check').innerText(), /Pharmacist checkpoint/);
      assert.match(await step('assemble').innerText(), /Technician checkpoint/);
      assert.equal(await page.locator('.fd-conn').count(), 17);
      assert.match(await page.locator('.fd-status').innerText(), /Guardrails pass/);
      assert.ok(await page.locator('[data-act="save"]').isDisabled(), 'nothing to save yet');
    });

    await t.test('required steps are locked: cannot be removed or disabled', async () => {
      for (const id of ['clinical-check', 'final-check']) {
        assert.equal(await step(id).locator('.fd-lock').count(), 1);
        assert.equal(await step(id).locator('[data-act="remove"]').count(), 0);
        assert.ok(await step(id).locator('[data-act="toggle"]').isDisabled());
        assert.equal(await step(id).locator('[data-act="toggle"]').getAttribute('aria-checked'), 'true');
      }
      // non-required steps can be removed and toggled
      assert.equal(await step('notify-patient').locator('[data-act="remove"]').count(), 1);
      assert.ok(!(await step('notify-patient').locator('[data-act="toggle"]').isDisabled()));
    });

    await t.test('reorders with move buttons and with drag and drop', async () => {
      await step('receive').locator('[data-act="down"]').click();
      assert.deepEqual((await order()).slice(0, 2), ['match-patient', 'receive']);
      await step('receive').locator('[data-act="up"]').click();
      assert.deepEqual((await order()).slice(0, 2), ['receive', 'match-patient']);
      // focus stays on the moved card (on "down", since "up" is now disabled at the top)
      await page.waitForFunction(() => document.activeElement?.closest('.fd-step')?.dataset.id === 'receive' && document.activeElement?.dataset.act === 'down');

      // drag "Submit claim" (last) to the top of the chain
      await page.dragAndDrop('.fd-step[data-id="submit-claim"] .fd-grip-wrap', '.fd-step[data-id="receive"]', { targetPosition: { x: 40, y: 4 } });
      let ids = await order();
      assert.equal(ids[0], 'submit-claim');
      assert.equal(ids.length, 16);
      // and back to the end
      await page.dragAndDrop('.fd-step[data-id="submit-claim"] .fd-grip-wrap', '.fd-step[data-id="handover"]', { targetPosition: { x: 40, y: 50 } });
      ids = await order();
      assert.equal(ids.at(-1), 'submit-claim');
      assert.match(await page.locator('.fd-dirty').innerText(), /Unsaved/);
    });

    await t.test('palette inserts steps by click and by drag', async () => {
      await step('final-check').locator('.fd-step-label').click();
      await page.locator('.fd-pal[data-type="book_courier"]').click();
      let ids = await order();
      assert.equal(ids[ids.indexOf('final-check') + 1], 'book-courier');
      await page.dragAndDrop('.fd-pal[data-type="notify_patient"]', '.fd-step[data-id="handover"]', { targetPosition: { x: 40, y: 4 } });
      ids = await order();
      assert.equal(ids[ids.indexOf('handover') - 1], 'notify-patient-2');
      await step('notify-patient-2').locator('[data-act="remove"]').click();
      await step('book-courier').locator('[data-act="remove"]').click();
      assert.equal((await order()).length, 16);
    });

    await t.test('live validation shows errors, highlights steps and blocks save', async () => {
      // move clinical check above screening (twice up: past check-history and screen)
      await step('clinical-check').locator('[data-act="up"]').click();
      await step('clinical-check').locator('[data-act="up"]').click();
      await page.waitForSelector('.fd-errbox');
      await settle();
      assert.match(await page.locator('.fd-errbox').innerText(), /screen must come before clinical_check/);
      assert.ok(await step('clinical-check').evaluate((el) => el.classList.contains('has-error')));
      assert.ok(await step('screen').evaluate((el) => el.classList.contains('has-error')));
      assert.ok(await page.locator('[data-act="save"]').isDisabled());
      assert.match(await page.locator('.fd-status').innerText(), /1 problem/);
      // fix it
      await step('clinical-check').locator('[data-act="down"]').click();
      await step('clinical-check').locator('[data-act="down"]').click();
      await settle();
      assert.equal(await page.locator('.fd-errbox').count(), 0);
      assert.equal(await page.locator('.fd-step.has-error').count(), 0);
    });

    await t.test('a stored flow with clinical check disabled reports errors until re-enabled', async () => {
      await page.locator('[data-act="select"][data-flow="4"]').click();
      await settle();
      const box = await page.locator('.fd-errbox').innerText();
      assert.match(box, /clinical_check must be enabled/);
      assert.ok(await step('clinical-check').evaluate((el) => el.classList.contains('has-error') && el.classList.contains('off')));
      // a disabled required step may be switched back on (never off)
      const toggle = step('clinical-check').locator('[data-act="toggle"]');
      assert.ok(!(await toggle.isDisabled()));
      await toggle.click();
      await settle();
      assert.ok(await step('clinical-check').locator('[data-act="toggle"]').isDisabled());
      assert.doesNotMatch(await page.locator('.fd-errbox').innerText(), /clinical_check must be enabled/);
      // the remaining problem is data entry auto-confirming fax; fix via the config editor
      await step('data-entry').locator('[data-act="expand"]').click();
      await step('data-entry').locator('input[data-kind="sources"][value="fax"]').uncheck();
      await settle();
      assert.equal(await page.locator('.fd-errbox').count(), 0);
      assert.ok(!(await page.locator('[data-act="save"]').isDisabled()));
    });

    await t.test('save creates a new version, activate makes it active', async () => {
      await page.locator('[data-act="save"]').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.fd-version.sel')].some((b) => b.textContent.includes('v3')));
      assert.equal(await page.locator('.fd-version').count(), 5);
      const saveCall = await page.evaluate(() => window.__apiLog.filter((c) => c.method === 'POST' && c.path === '/api/flows').at(-1));
      assert.equal(saveCall.body.key, 'phone-fax');
      assert.equal(saveCall.body.definition.steps.find((s) => s.type === 'clinical_check').enabled, true);
      assert.deepEqual(saveCall.body.definition.steps.find((s) => s.type === 'data_entry').config.autoFor, []);
      await page.locator('[data-act="activate"]').click();
      await page.waitForFunction(() => document.querySelector('.fd-version.sel .fd-active'));
      assert.equal(await page.locator('.fd-group').nth(1).locator('.fd-active').count(), 1);
      assert.ok(await page.locator('[data-act="activate"]').isDisabled());
    });

    await t.test('new flow starts from a copy of the selected flow', async () => {
      await page.locator('[data-act="new"]').click();
      assert.equal(await page.locator('[data-field="name"]').inputValue(), 'Copy of Phone & fax orders');
      assert.equal((await order()).length, 13);
      await settle();
      await page.locator('[data-act="save"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.fd-group').length === 3);
      const saveCall = await page.evaluate(() => window.__apiLog.filter((c) => c.method === 'POST' && c.path === '/api/flows').at(-1));
      assert.equal(saveCall.body.key, undefined);
    });

    await t.test('timeline shows each step status, current step and retry', async () => {
      await page.locator('#tabs button[data-tab="timeline"]').click();
      const tl = page.locator('#timeline');
      for (const s of ['done', 'waiting', 'failed', 'skipped', 'pending', 'running']) {
        assert.ok(await tl.locator(`.ft-step[data-status="${s}"]`).count() > 0, `has a ${s} step`);
      }
      const current = tl.locator('.ft-step.current');
      assert.equal(await current.getAttribute('data-step'), 'clinical-check');
      assert.match(await current.innerText(), /Needs you/);
      assert.match(await tl.locator('.ft-step[data-step="check-stock"]').innerText(), /On hand\s+40[\s\S]*Short by 20/);
      assert.match(await tl.locator('.ft-step[data-step="verify-original"]').innerText(), /broker copy is the original/);
      assert.match(await tl.locator('.ft-step[data-step="check-history"]').innerText(), /timed out/);
      await tl.locator('[data-retry="check-history"]').click();
      await page.waitForSelector('#timeline .ft-step[data-step="check-history"][data-status="done"]');
      assert.equal(await tl.locator('[data-retry]').count(), 0);
      const h = page.locator('#timeline-h');
      assert.match(await h.innerText(), /NZC-88213407/);
      assert.equal(await h.locator('a.ft-link').getAttribute('href'), '/api/jobs/43/worksheet');
      assert.match(await page.locator('#timeline-empty').innerText(), /No pharmacy flow/);
    });

    await t.test('non-pharmacists get a read-only designer', async () => {
      await page.goto(`${base}/flow-demo.html?role=technician`);
      await page.waitForFunction(() => window.__ready === true);
      await page.waitForSelector('.fd-step');
      assert.ok(await page.locator('.fd-readonly').isVisible());
      assert.equal(await page.locator('[data-act="save"]').count(), 0);
      assert.equal(await page.locator('[data-act="remove"]').count(), 0);
      assert.equal(await page.locator('[data-act="up"]').count(), 0);
      assert.ok(await page.locator('.fd-pal').first().isDisabled());
      assert.equal(await page.locator('.fd-step[draggable="true"]').count(), 0);
      assert.equal((await order()).length, 16, 'still viewable');
      assert.match(await page.locator('#timeline').innerText(), /Waiting for pharmacist/);
    });

    await t.test('no console errors', () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    await new Promise((r) => app.server.close(r));
  }
});
