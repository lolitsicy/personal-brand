import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, DEFAULT_CONFIG } from '../src/server.js';
import { makeScid } from '../src/domain/scid.js';
import { PATTERNS, encodeCode128, code128Svg, validateCode128, QUIET_ZONE } from '../src/print/code128.js';
import { createPrint } from '../src/print/index.js';
import { renderWorksheet, WORKSHEET_SECTIONS } from '../src/print/worksheet.js';
import { renderShippingLabel } from '../src/print/shipping-label.js';
import { registerPrintRoutes, PRINT_CSP } from '../src/print/routes.js';

// Tests below exercise the optional clinical checks (demo data) and the offline AI reviewer;
// both are off by default in the product (see test/scope.test.js).
process.env.CLINICAL_CHECKS ??= 'demo';
process.env.AI_REVIEWER ??= 'mock';

const METFORMIN_SCID = makeScid('1A2B3C4D5E6F7G8H9'); // Aroha: metformin + atorvastatin, 2 repeats
const OXY_SCID = makeScid('C1D2E3F4G5H6J7K8L'); // Grace: oxycodone (Class B) + paracetamol
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let app, p, print, priya, tom, lucy;

beforeEach(() => {
  app = createApp();
  p = app.platform;
  print = createPrint({ platform: p, config: DEFAULT_CONFIG });
  const byName = Object.fromEntries(p.users().map((u) => [u.name.split(' ')[0], u]));
  ({ Priya: priya, Tom: tom, Lucy: lucy } = byName);
});

function approveAll(jobId) {
  const decisions = {};
  for (const f of p.getJob(jobId, priya).warnings ?? []) {
    if (f.severity === 'hard_stop') decisions[f.id] = { action: 'override', reason: 'Discussed with prescriber', prescriberConfirmed: true };
    else if (f.severity === 'high') decisions[f.id] = { action: 'acknowledge', note: 'Reviewed' };
  }
  return { decisions, sourceVerified: true };
}

async function runToChecked(jobId, enterBody = {}) {
  await p.transition(jobId, 'enter', lucy, enterBody);
  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
  await p.transition(jobId, 'assemble', lucy);
  return p.transition(jobId, 'final_check', priya);
}

/** Decode a rendered Code 128 SVG back to module widths, using only the rect geometry. */
function svgBars(svg) {
  const module = Number(/<rect x="(\d+(?:\.\d+)?)"/.exec(svg.replace(/<rect width=[^>]+>/, ''))[1]) / QUIET_ZONE;
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]) / module, w: Number(m[2]) / module }));
  let bits = '';
  let pos = QUIET_ZONE;
  for (const r of rects) {
    bits += '0'.repeat(Math.round(r.x - pos)) + '1'.repeat(Math.round(r.w));
    pos = r.x + r.w;
  }
  return bits;
}

// ───────────────────────────── Code 128 ─────────────────────────────

test('code128: pattern table is internally consistent (11 modules, even bar parity, unique)', () => {
  assert.equal(PATTERNS.length, 107);
  const sum = (s) => [...s].reduce((a, c) => a + Number(c), 0);
  for (const [v, pat] of PATTERNS.entries()) {
    const bars = [...pat].filter((_, i) => i % 2 === 0).reduce((a, c) => a + Number(c), 0);
    assert.equal(sum(pat), v === 106 ? 13 : 11, `symbol ${v} width`);
    assert.equal(bars % 2, 0, `symbol ${v} bar modules must be even`);
  }
  assert.equal(new Set(PATTERNS).size, 107);
});

test('code128: known reference encodings (symbol values + mod-103 checksum)', () => {
  // "MC1001NZ" in subset B: M=45 C=35 1=17 0=16 0=16 1=17 N=46 Z=58
  // checksum = (104 + 45·1 + 35·2 + 17·3 + 16·4 + 16·5 + 17·6 + 46·7 + 58·8) mod 103 = 1302 mod 103 = 66
  const mc = encodeCode128('MC1001NZ');
  assert.deepEqual(mc.values, [104, 45, 35, 17, 16, 16, 17, 46, 58, 66, 106]);
  assert.equal(mc.checksum, 66);
  // Trailing run of 8 digits switches to subset C (Code C = 99), pairs 12 34 56 78:
  // (104 + 50 + 56·2 + 13·3 + 99·4 + 12·5 + 34·6 + 56·7 + 78·8) mod 103 = 1981 mod 103 = 24
  assert.deepEqual(encodeCode128('RX-12345678').values, [104, 50, 56, 13, 99, 12, 34, 56, 78, 24, 106]);
  // All digits, even: Start C. (105 + 12 + 34·2 + 56·3) mod 103 = 353 mod 103 = 44
  assert.deepEqual(encodeCode128('123456').values, [105, 12, 34, 56, 44, 106]);
  // Odd digit string: first digit in B, rest in C. (104 + 17 + 99·2 + 23·3 + 45·4) mod 103 = 53
  assert.deepEqual(encodeCode128('12345').values, [104, 17, 99, 23, 45, 53, 106]);
  // Short mid-string digit runs stay in B; subset C can be turned off.
  assert.ok(!encodeCode128('RX-12-0').values.includes(99));
  assert.ok(!encodeCode128('123456', { optimise: false }).values.includes(105));
});

test('code128: module pattern starts with Start B, ends with Stop + termination bar', () => {
  const { modules, values } = encodeCode128('MC1001NZ');
  assert.equal(modules.slice(0, 11), '11010010000'); // Start B
  assert.equal(modules.slice(-13), '1100011101011'); // Stop incl. termination bar
  assert.equal(modules.length, (values.length - 1) * 11 + 13);
});

test('code128: SVG bars decode back to the encoded modules, with quiet zones and readable text', () => {
  const svg = code128Svg('MC1001NZ', { module: 2, height: 50 });
  const { modules } = encodeCode128('MC1001NZ');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.equal(svgBars(svg), modules.replace(/0+$/, ''));
  const width = Number(/viewBox="0 0 ([\d.]+) /.exec(svg)[1]);
  assert.equal(width, (modules.length + 2 * QUIET_ZONE) * 2);
  assert.match(svg, /<text[^>]*>MC1001NZ<\/text>/);
});

test('code128: rejects empty and non-printable-ASCII input; escapes text', () => {
  assert.throws(() => validateCode128(''), /non-empty/);
  assert.throws(() => encodeCode128('tab\there'), /printable ASCII/);
  assert.throws(() => encodeCode128('café'), /printable ASCII/);
  assert.throws(() => encodeCode128(42), /string/);
  const svg = code128Svg('<a&b>');
  assert.ok(!svg.includes('<a&b>'));
  assert.match(svg, /&lt;a&amp;b&gt;/);
});

// ───────────────────────────── worksheet ─────────────────────────────

test('worksheet: complete standalone A4 document with all sections in the fixed order', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  await runToChecked(jobId);
  const html = print.worksheetHtml(jobId, priya);

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Dispensing worksheet/);
  assert.match(html, /<h1>Dispensing worksheet<\/h1>/);
  assert.match(html, /@page \{ size: A4/);
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!/(src|href)="https?:/i.test(html) && !/@import|url\(/i.test(html), 'no external resources');

  const positions = WORKSHEET_SECTIONS.map((s) => html.indexOf(`data-section="${s}"`));
  assert.ok(positions.every((i) => i > 0), `all sections present: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections in order');

  assert.match(html, new RegExp(`Rx ${jobId}-0`));
  assert.match(html, /Demo Community Pharmacy/);
  assert.match(html, /Aroha Ngata/);
  assert.match(html, /ZZZ0016/);
  assert.match(html, new RegExp(METFORMIN_SCID));
  assert.match(html, /Dr Mere Tane/);
  assert.match(html, /Item as received from NZePS/);
  assert.match(html, /Metformin/);
  assert.match(html, /Repeats<\/dt><dd><strong>2<\/strong> remaining/);
  assert.match(html, /class="label-preview">[^<]*METFORMIN/);
  assert.match(html, /Prototype — not for clinical use/);
  // sign-off grid prefilled with names from the job
  assert.match(html, /data-step="enter"[\s\S]*?Lucy Chen \(LC\)/);
  assert.match(html, /data-step="clinical_check"[\s\S]*?Priya Shah \(PS\)/);
  assert.match(html, /data-step="final_check"[\s\S]*?Priya Shah \(PS\)/);
  for (const step of ['Data entry', 'Clinical check', 'Assembly', 'Final check', 'Handover', 'Batch', 'Expiry', 'Stock / product']) assert.ok(html.includes(step), step);

  // scannable barcode of RX-<jobId>-<sequence>
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)[0];
  assert.match(svg, new RegExp(`data-code128="RX-${jobId}-0"`));
  assert.equal(svgBars(svg), encodeCode128(`RX-${jobId}-0`).modules.replace(/0+$/, ''));

  // printing is audited
  const printed = p.audit.list({ entity: 'job', entityId: jobId }).find((e) => e.action === 'job.worksheet_printed');
  assert.equal(printed.user_id, priya.id);
  assert.equal(printed.data.worksheet, `RX-${jobId}-0`);
});

test('worksheet: before sign-off, findings show unchecked boxes; after, decisions are shown', async () => {
  const rx = await p.intakeFromSource('nzeps', makeScid('B7C8D9E0F1G2H3J4K'), lucy); // amoxicillin + penicillin allergy -> hard stop
  const jobId = rx.items[0].jobs[0].id;
  await p.transition(jobId, 'enter', lucy);
  const before = print.worksheetHtml(jobId, priya);
  assert.match(before, /Not yet signed off/);
  assert.match(before, /HARD STOP/);
  assert.match(before, /<span class="box" aria-hidden="true"><\/span> Override/);
  assert.match(before, /Allergies<\/dt><dd class="alert"><strong>⚠/);

  await p.transition(jobId, 'clinical_check', priya, approveAll(jobId));
  const after = print.worksheetHtml(jobId, priya);
  assert.match(after, /Signed off<\/strong> by Priya Shah/);
  assert.match(after, /Overridden<\/strong><br>Reason: Discussed with prescriber/);
  assert.match(after, /Prescriber confirmed/);
  assert.match(after, /<td>Rule<\/td>/);
});

test('worksheet: amended quantity is marked ≠ with the reason; matching fields ✓', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  await p.transition(jobId, 'enter', lucy, { amend: { quantity: 56, reason: 'Rounded to 4 x 14 blister packs' } });
  const html = print.worksheetHtml(jobId, priya);
  assert.match(html, /<tr class="diff"><td>Quantity<\/td><td>60<\/td><td>56<\/td><td class="c mark">≠<\/td><\/tr>/);
  assert.match(html, /<td>Directions<\/td>[^]*?<td class="c mark">✓<\/td>/);
  assert.match(html, /Amendments at data entry/);
  assert.match(html, /Rounded to 4 x 14 blister packs/);
});

test('worksheet: escapes hostile data from a manually keyed paper script', async () => {
  const rx = await p.intakeManual({
    source: 'paper',
    document: { filename: '<img src=x onerror=alert(2)>.png', dataBase64: PNG_B64 },
    patient: { nhi: 'ZZZ0040', name: '<script>alert(1)</script> Smith', allergies: ['"><b>penicillin'] },
    prescriber: { cpn: '99XXXX', name: 'Dr <i>Evil</i>' },
    items: [{ medicineCode: 'PAR500', directions: 'Take 2 <b>tablets</b> & rest', quantity: 20 }],
  }, lucy);
  const html = print.worksheetHtml(rx.items[0].jobs[0].id, priya);
  assert.ok(!html.includes('<script>alert(1)'), 'script tag escaped');
  assert.ok(!html.includes('<img src=x'), 'filename escaped');
  assert.ok(!html.includes('<i>Evil</i>') && !html.includes('<b>tablets</b>') && !html.includes('"><b>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Smith/);
  assert.match(html, /Take 2 &lt;b&gt;tablets&lt;\/b&gt; &amp; rest/);
  assert.match(html, /Compare against attached scan/);
  assert.ok(!/<script/i.test(html));
});

test('worksheet: controlled drug gets a prominent CD box; renderer works without users map', async () => {
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  const jobId = rx.items[0].jobs[0].id;
  const html = renderWorksheet({ job: p.getJob(jobId, priya), pharmacy: DEFAULT_CONFIG.pharmacy, printedBy: 'Bench printer' });
  assert.match(html, /class="cd-box" data-cd="B"/);
  assert.match(html, /CONTROLLED DRUG — CLASS B/);
  assert.match(html, /CD CLASS B/);
  assert.match(html, /by Bench printer/);
  assert.match(html, /Label is generated at assembly/);
});

// ───────────────────────────── labels ─────────────────────────────

test('courier label: no medicine names, item count, tracking barcode, signature required for CD', async () => {
  const rx = await p.intakeFromSource('nzeps', OXY_SCID, lucy);
  const [oxy, par] = rx.items.map((i) => i.jobs[0].id);
  await runToChecked(oxy);
  await runToChecked(par);
  const r = await p.transition(oxy, 'release', lucy, { method: 'courier' });
  await p.transition(par, 'release', lucy, { method: 'courier' });

  const unbooked = print.labelHtml(r.fulfilment_id, lucy);
  assert.match(unbooked, /Tracking reference pending/);

  const f = await p.fulfilmentAction(r.fulfilment_id, 'dispatch', lucy, {});
  const html = print.labelHtml(f.id, lucy);
  assert.match(html, /<title>Shipping label<\/title>/);
  assert.match(html, /@page \{ size: 100mm 150mm/);
  assert.match(html, /Pharmacy parcel, 2 items/);
  assert.match(html, /Grace Lee/);
  assert.match(html, /88 Queen St/);
  assert.ok(!/oxycodone|paracetamol/i.test(html), 'no medicine names on a courier label');
  assert.ok(!html.includes('ZZZ0032'), 'no NHI on the outside of a parcel');
  assert.match(html, /data-flag="signature">Signature required/);
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)[0];
  assert.match(svg, new RegExp(`data-code128="${f.tracking_ref}"`));
  assert.equal(svgBars(svg), encodeCode128(f.tracking_ref).modules.replace(/0+$/, ''));
  assert.ok(!/<script/i.test(html));
  assert.ok(p.audit.list({ entity: 'fulfilment', entityId: f.id }).some((e) => e.action === 'fulfilment.shipping_label_printed'));
});

test('bag label: pickup lists items with pickup code; no signature flag without a controlled drug', async () => {
  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  let rel;
  for (const it of rx.items) {
    await runToChecked(it.jobs[0].id);
    rel = await p.transition(it.jobs[0].id, 'release', lucy, { method: 'pickup' });
  }
  const f = p.getFulfilment(rel.fulfilment_id);
  const html = print.labelHtml(f.id, tom);
  assert.match(html, /<title>Collection bag label<\/title>/);
  assert.match(html, /Metformin/);
  assert.match(html, /Atorvastatin/);
  assert.match(html, /2 items/);
  assert.ok(html.includes(f.pickup_code));
  assert.match(html, new RegExp(`data-code128="${f.pickup_code}"`));
  assert.ok(!html.includes('data-flag="signature"'));
});

test('labels: keep-cool flag from fridge warnings; signature from controlled_class; escaping', () => {
  const html = renderShippingLabel({
    pharmacy: DEFAULT_CONFIG.pharmacy,
    fulfilment: {
      id: 9, method: 'delivery', address: '1 <b>Bad</b> St', patient_name: 'A & B', tracking_ref: 'DRV-9',
      jobs: [{ id: 1, sequence: 0, medicine: 'Insulin', strength: '100 u/mL', controlled_class: 'C', label_text: '• Store in a refrigerator (2–8 °C)' }],
    },
  });
  assert.match(html, /data-flag="keep-cool"/);
  assert.match(html, /data-flag="signature"/);
  assert.match(html, /1 &lt;b&gt;Bad&lt;\/b&gt; St/);
  assert.match(html, /A &amp; B/);
  assert.ok(!/insulin/i.test(html));
});

// ───────────────────────────── routes / urls ─────────────────────────────

test('routes: registered under /api/print with HTML + CSP; urls match', async () => {
  const routes = {};
  registerPrintRoutes((method, pattern, handler) => { routes[`${method} ${pattern}`] = handler; }, { print });
  assert.deepEqual(Object.keys(routes).sort(), ['GET /api/print/fulfilments/:id/label', 'GET /api/print/jobs/:id/worksheet']);
  assert.equal(print.worksheetUrl(7), '/api/print/jobs/7/worksheet');
  assert.equal(print.labelUrl(3), '/api/print/fulfilments/3/label');

  const rx = await p.intakeFromSource('nzeps', METFORMIN_SCID, lucy);
  const out = routes['GET /api/print/jobs/:id/worksheet']({ params: { id: String(rx.items[0].jobs[0].id) }, user: lucy });
  assert.equal(out.type, 'text/html; charset=utf-8');
  assert.equal(out.headers['Content-Security-Policy'], PRINT_CSP);
  assert.equal(PRINT_CSP, "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.match(out.__raw, /Dispensing worksheet/);
  assert.throws(() => routes['GET /api/print/jobs/:id/worksheet']({ params: { id: '9999' }, user: lucy }), (e) => e.status === 404);
});
