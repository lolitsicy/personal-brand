import { label, reviewerLabel } from '../domain/labels.js';
// Printable dispensing worksheet (A4). One sheet travels with the basket from
// data entry to handover: what was received, what is being dispensed, what the
// screening found and who signed off each step. Self-contained HTML: no JS, no
// external resources; every value is HTML-escaped.

import { code128Svg } from './code128.js';
import { esc, val, fmtDateTime, fmtDate, ageOn, documentShell } from './html.js';

export const WORKSHEET_SECTIONS = ['header', 'patient', 'prescriber', 'original', 'dispensing', 'screening', 'counselling', 'label', 'signoff'];

const SEVERITY_LABEL = { hard_stop: 'HARD STOP', high: 'HIGH', moderate: 'MODERATE', info: 'INFO' };
const ORIGIN_LABEL = { rules: 'Rule', formulary: 'Formulary', ai: 'AI' };
const KIND_LABEL = { electronic: 'Electronic prescription (NZePS)', document: 'Written / scanned original', verbal: 'Verbal order (no document)' };
const SOURCE_LABEL = { nzeps: 'NZePS e-script', paper: 'Paper', signature_exempt: 'Signature exempt', fax: 'Fax', phone: 'Phone', other: 'Other' };
const ACTION_LABEL = { acknowledge: 'Acknowledged', override: 'Overridden', resolve: 'Resolved', reject: 'Rejected', contact_prescriber: 'Prescriber contacted' };

export const worksheetId = (job) => `${job.id}-${job.sequence ?? 0}`;
export const worksheetBarcodeValue = (job) => `RX-${job.id}-${job.sequence ?? 0}`;

function userLookup(users) {
  if (!users) return () => null;
  if (users instanceof Map) return (id) => users.get(Number(id)) ?? users.get(String(id)) ?? null;
  if (Array.isArray(users)) {
    const m = new Map(users.map((u) => [Number(u.id), u]));
    return (id) => m.get(Number(id)) ?? null;
  }
  return (id) => users[id] ?? null;
}

const kv = (rows) => `<dl class="kv">${rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;

const section = (id, n, title, body, extraClass = '') =>
  `<section class="sec ${extraClass}" data-section="${id}" id="sec-${id}"><h2><span class="n">${n}</span>${esc(title)}</h2>${body}</section>`;

const box = (checked) => `<span class="box${checked ? ' on' : ''}" aria-hidden="true">${checked ? '✓' : ''}</span>`;

function allergyText(list) {
  if (!Array.isArray(list) || list.length === 0) return 'None recorded';
  return list.map((a) => (typeof a === 'string' ? a : [a.substance ?? a.name ?? a.class ?? '', a.reaction ? `(${a.reaction})` : ''].join(' ').trim())).join('; ');
}

function receivedItem(original, job) {
  const items = original?.payload?.items;
  if (!Array.isArray(items)) return null;
  return items.find((x, i) => String(x.itemRef ?? i + 1) === String(job.item_ref)) ?? null;
}

// ───────────────────────────── sections ─────────────────────────────

function header({ job, pharmacy, printedBy, printedAt }) {
  const barcode = code128Svg(worksheetBarcodeValue(job), { module: 1.6, height: 46, fontSize: 11, label: `Worksheet barcode ${worksheetBarcodeValue(job)}` });
  const cd = job.controlled_class ? `<div class="cd-badge">CD CLASS ${esc(job.controlled_class)}</div>` : '';
  return `<header class="sheet-head" data-section="header">
  <div class="head-left">
    <div class="pharmacy">${val(pharmacy?.name)}</div>
    <div class="pharmacy-sub">${val(pharmacy?.address)}${pharmacy?.phone ? ` · Ph ${esc(pharmacy.phone)}` : ''}</div>
    <h1>Dispensing worksheet</h1>
    ${kv([
      ['Worksheet', `<strong class="mono big">Rx ${esc(worksheetId(job))}</strong>${job.sequence > 0 ? ` <span class="tag">Repeat ${esc(job.sequence)}</span>` : ' <span class="tag">Original supply</span>'}`],
      ['Source', `${val(SOURCE_LABEL[job.source] ?? job.source)}${job.scid ? ` · SCID <span class="mono">${esc(job.scid)}</span>` : ''}`],
      ['Status', val(label('state', job.state))],
      ['Printed', `${esc(fmtDateTime(printedAt))} by ${val(printedBy?.name ?? printedBy)}`],
    ])}
  </div>
  <div class="head-right">${cd}<div class="barcode">${barcode}</div><div class="scan-hint">Scan at the bench</div></div>
</header>`;
}

function patientSection({ job, printedAt }) {
  const pt = job.patient ?? {};
  const age = pt.dob ? ageOn(pt.dob, printedAt) : null;
  const allergies = allergyText(pt.allergies);
  const hasAllergy = Array.isArray(pt.allergies) && pt.allergies.length > 0;
  return section('patient', 1, 'Patient', kv([
    ['Name', `<strong class="big">${val(job.patient_name)}</strong>`],
    ['NHI', `<span class="mono">${val(job.nhi)}</span>`],
    ['DOB / age', pt.dob ? `${esc(fmtDate(pt.dob))}${age != null ? ` (${esc(age)} y)` : ''}` : '—'],
    ['Allergies', hasAllergy ? `<strong>⚠ ${esc(allergies)}</strong>` : esc(allergies), hasAllergy ? 'alert' : ''],
    ['eGFR', pt.egfr != null && pt.egfr !== '' ? `${esc(pt.egfr)} mL/min/1.73m²` : 'Not recorded'],
  ]), 'half');
}

function prescriberSection({ job }) {
  const pr = job.original?.payload?.prescriber ?? {};
  return section('prescriber', 2, 'Prescriber', kv([
    ['Name', `<strong>${val(job.prescriber_name ?? pr.name)}</strong>`],
    ['CPN', `<span class="mono">${val(pr.cpn)}</span>`],
    ['Practice', val(pr.facilityName)],
    ['Prescribed', val(job.original?.payload?.prescribedAt ? fmtDate(job.original.payload.prescribedAt) : null)],
  ]), 'half');
}

function originalSection({ job }) {
  const o = job.original ?? {};
  const integrity = o.intact === false || (o.documents ?? []).some((d) => d.intact === false)
    ? '<strong class="fail">✗ INTEGRITY CHECK FAILED — do not dispense; investigate</strong>'
    : o.intact ? '<strong>✓ Intact</strong> — stored copy matches the hash recorded at receipt' : '—';
  const rows = [
    ['Kind', val(KIND_LABEL[o.kind] ?? o.kind)],
    ['Received', val(o.receivedAt ? fmtDateTime(o.receivedAt) : null)],
    ['Integrity', integrity],
    ['SHA-256', o.hash ? `<span class="mono">${esc(String(o.hash).slice(0, 16))}…</span>` : '—'],
  ];
  let body = kv(rows);

  if (o.kind === 'electronic') {
    const it = receivedItem(o, job);
    if (it) {
      const fields = [
        ['Item ref', it.itemRef], ['Medicine code', it.medicineCode], ['Directions', it.directions],
        ['Quantity', it.quantity], ['Repeats', it.repeats ?? 0], ['Period (days)', it.periodDays],
        ['Dose', it.doseUnits && it.dosesPerDay ? `${it.doseUnits} × ${it.dosesPerDay}/day` : null],
      ];
      body += `<h3>Item as received from NZePS</h3><div class="kv2">${kv(fields.map(([k, v]) => [k, val(v)]))}</div>`;
    }
  } else if (o.kind === 'document') {
    body += `<p class="note"><strong>Compare against attached scan.</strong> The fields below were keyed at intake; the scan is the original.</p>`;
    if (o.documents?.length) {
      body += `<ul class="docs">${o.documents.map((d) => `<li>${val(d.filename ?? `Document ${d.id}`)} <span class="muted">(${esc(d.mime)}, sha256 <span class="mono">${esc(String(d.sha256 ?? '').slice(0, 12))}…</span>${d.intact === false ? ', <strong class="fail">FAILED</strong>' : ''})</span></li>`).join('')}</ul>`;
    }
  } else if (o.kind === 'verbal') {
    body += `<p class="note"><strong>Verbal order — no original document on file.</strong> Obtain the written prescription as required.</p>`;
  }

  if (o.compare?.length) {
    body += `<h3>Received vs dispensing</h3><table class="grid compare"><thead><tr><th>Field</th><th>Received</th><th>Dispensing</th><th class="c">Match</th></tr></thead><tbody>${o.compare.map((c) => `<tr class="${c.match ? '' : 'diff'}"><td>${val(c.field)}</td><td>${val(c.received)}</td><td>${val(c.dispensing)}</td><td class="c mark">${c.match ? '✓' : '≠'}</td></tr>`).join('')}</tbody></table>`;
  }
  if (o.amendments?.length) {
    body += `<h3>Amendments at data entry</h3><table class="grid"><thead><tr><th>Change</th><th>Reason</th><th>By / when</th></tr></thead><tbody>${o.amendments.map((a) => `<tr><td>${Object.entries(a.changes ?? {}).map(([f, ch]) => `${esc(f)}: <s>${val(ch.from)}</s> → <strong>${val(ch.to)}</strong>`).join('<br>')}</td><td>${val(a.reason)}</td><td>${val(a.byName)}<br><span class="muted">${esc(fmtDateTime(a.at))}</span></td></tr>`).join('')}</tbody></table>`;
  }
  return section('original', 3, 'Original as received', body);
}

function dispensingSection({ job }) {
  const remaining = job.repeats_authorised != null ? Math.max(Number(job.repeats_authorised) - Number(job.sequence ?? 0), 0) : null;
  const qty = job.quantity_supplied
    ? `${esc(job.quantity_supplied)} supplied of ${esc(job.quantity)}${job.owing ? ` — <strong>owing ${esc(job.owing)}</strong>` : ''}`
    : `${val(job.quantity)}`;
  let body = `<div class="medline"><span class="medname">${val(job.medicine)}</span> <span class="medstr">${val(job.strength)} ${val(job.form)}</span></div>`;
  body += kv([
    ['Directions', `<strong>${val(job.directions)}</strong>`],
    ['Quantity', qty],
    ['Repeats', `${remaining != null ? `<strong>${esc(remaining)}</strong> remaining after this supply` : '—'} (authorised ${val(job.repeats_authorised)})`],
    ['Code', `<span class="mono">${val(job.medicine_code)}</span>`],
  ]);
  if (job.controlled_class) {
    body += `<div class="cd-box" data-cd="${esc(job.controlled_class)}"><div class="cd-title">CONTROLLED DRUG — CLASS ${esc(job.controlled_class)}</div><ul><li>${box(false)} Prescription meets controlled drug requirements</li><li>${box(false)} Entered in the CD register (balance checked)</li><li>${box(false)} Proof of collection / delivery recorded at handover</li></ul></div>`;
  }
  return section('dispensing', 4, 'Dispensing', body);
}

// What the pharmacist must record, by severity (see docs/flow-contract.md):
// hard stop = override + reason + prescriber contact; high = acknowledge; moderate = check; info = note.
function pendingDecision(severity) {
  if (severity === 'hard_stop') return `<div class="choices">${box(false)} Override &nbsp;${box(false)} Prescriber contacted<br>Reason:<span class="line"></span></div>`;
  if (severity === 'high') return `<div class="choices">${box(false)} Acknowledged<br>Note:<span class="line"></span></div>`;
  if (severity === 'moderate') return `<div class="choices">${box(false)} Checked</div>`;
  return '<span class="muted">Note only</span>';
}

function screeningSection({ job, lookupUser }) {
  const ack = job.warnings_acknowledged && typeof job.warnings_acknowledged === 'object' ? job.warnings_acknowledged : null;
  const signed = !!ack;
  const findings = (signed ? ack.warnings : null) ?? job.warnings ?? job.screening?.findings ?? [];
  const decisions = ack?.decisions ?? {};
  const checker = signed ? lookupUser(ack.by)?.name ?? (ack.by != null ? `User ${ack.by}` : null) : null;

  let body = '';
  const sv = ack?.sourceVerified;
  body += `<p class="status-line">${signed
    ? `<strong>Signed off</strong> by ${val(checker)}${sv?.at ? ` at ${esc(fmtDateTime(sv.at))}` : ''}. ${box(true)} Checked against the original as received${sv?.differences?.length ? ` (differences: ${esc(sv.differences.join(', '))})` : ''}.`
    : `<strong>Not yet signed off.</strong> ${box(false)} I have checked the script against the original as received.`}${job.screening?.reviewer ? ` <span class="muted">Reviewer: ${esc(reviewerLabel(job.screening.reviewer))}</span>` : ''}</p>`;

  if (!findings.length) {
    body += `<p class="note">No findings from rules, formulary or AI review.</p>`;
  } else {
    body += `<table class="grid findings"><thead><tr><th>Severity</th><th>Origin</th><th>Finding</th><th>Pharmacist decision</th></tr></thead><tbody>${findings.map((f) => {
      const d = decisions[f.id];
      const decision = d
        ? `<strong>${val(ACTION_LABEL[d.action] ?? d.action)}</strong>${d.reason ? `<br>Reason: ${esc(d.reason)}` : ''}${d.note ? `<br>Note: ${esc(d.note)}` : ''}${d.prescriberConfirmed ? `<br>${box(true)} Prescriber confirmed` : ''}`
        : signed
          ? `<span class="muted">${f.severity === 'info' ? 'Noted' : 'Checked at sign-off'}</span>`
          : pendingDecision(f.severity);
      return `<tr class="sev-${esc(f.severity)}"><td><span class="sev">${val(SEVERITY_LABEL[f.severity] ?? f.severity)}</span></td><td>${val(ORIGIN_LABEL[f.origin] ?? f.origin)}</td><td>${val(f.message)}${f.trace?.source ? `<div class="src">Source: ${esc(f.trace.source)}</div>` : ''}</td><td>${decision}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  return section('screening', 5, 'Clinical screening', body);
}

function counsellingSection({ job }) {
  const c = job.screening?.counselling;
  const points = [];
  if (Array.isArray(c)) points.push(...c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')));
  else if (typeof c === 'string') points.push(c);
  else if (c?.text) points.push(...String(c.text).split(/\n+/));
  else if (Array.isArray(c?.points)) points.push(...c.points);
  // Formulary counselling points arrive as COUNSEL findings; label warnings come from the label text.
  const ack = job.warnings_acknowledged && typeof job.warnings_acknowledged === 'object' ? job.warnings_acknowledged : null;
  const findings = ack?.warnings ?? job.warnings ?? job.screening?.findings ?? [];
  const fromLabel = String(job.label_text ?? '').split('\n').filter((l) => l.startsWith('•')).map((l) => l.replace(/^•\s*/, ''));
  const labelWarnings = [...new Set([...findings.filter((f) => f.code === 'COUNSEL').map((f) => f.message), ...fromLabel].map((s) => String(s ?? '').trim()).filter(Boolean))];
  let body = '';
  const clean = points.map((s) => String(s).trim()).filter(Boolean);
  if (clean.length) body += `<ul class="points">${clean.map((p) => `<li>${box(false)} ${esc(p)}</li>`).join('')}</ul>`;
  if (labelWarnings.length) body += `<h3>Warnings to explain</h3><ul class="points">${labelWarnings.map((w) => `<li>${box(false)} ${esc(w)}</li>`).join('')}</ul>`;
  if (!clean.length && !labelWarnings.length) body += `<p class="note">No counselling points recorded. Counsel on directions, expected effects and side effects.</p>`;
  if (c?.language && c.language !== 'en') body += `<p class="muted">Counselling language: ${esc(c.language)}</p>`;
  body += `<p class="writein">Notes:<span class="line"></span><span class="line"></span></p>`;
  return section('counselling', 6, 'Counselling points', body);
}

function labelSection({ job }) {
  const body = job.label_text
    ? `<pre class="label-preview">${esc(job.label_text)}</pre>`
    : `<div class="label-preview empty">Label is generated at assembly.</div>`;
  return section('label', 7, 'Label preview', body);
}

function signoffSection({ job, lookupUser, signoffs = {} }) {
  const who = (id) => {
    const u = id != null ? lookupUser(id) : null;
    return u ? `${u.name} (${u.initials})` : id != null ? `User ${id}` : '';
  };
  const cell = (key, title, userId, extra = '') => {
    const ev = signoffs[key] ?? {};
    const uid = userId ?? ev.userId ?? null;
    const name = who(uid);
    const at = ev.at ? fmtDateTime(ev.at) : '';
    return `<div class="sign${name ? ' done' : ''}" data-step="${key}"><div class="sign-title">${esc(title)}</div>
      <div class="field"><span class="lbl">Name / initials</span><span class="fill">${esc(name)}</span></div>
      <div class="field"><span class="lbl">Date / time</span><span class="fill">${esc(at)}</span></div>${extra}</div>`;
  };
  const assemblyExtra = ['Stock / product', 'Batch', 'Expiry'].map((l) => `<div class="field"><span class="lbl">${l}</span><span class="fill"></span></div>`).join('');
  const handoverExtra = `<div class="field"><span class="lbl">Collected by / proof</span><span class="fill">${esc(signoffs.release?.proof ?? '')}</span></div>`;
  const body = `<div class="signgrid">
    ${cell('enter', 'Data entry', job.entered_by)}
    ${cell('clinical_check', 'Clinical check', job.clinical_checked_by)}
    ${cell('assemble', 'Assembly', job.assembled_by, assemblyExtra)}
    ${cell('final_check', 'Final check', job.final_checked_by)}
    ${cell('release', 'Handover', signoffs.release?.userId ?? null, handoverExtra)}
  </div>`;
  return section('signoff', 8, 'Sign-off', body, 'keep');
}

const CSS = `
@page { size: A4; margin: 12mm 12mm 16mm; @bottom-center { content: "Prototype — not for clinical use · Page " counter(page) " of " counter(pages); font: 8pt Arial, Helvetica, sans-serif; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; color: #000; font: 9.5pt/1.32 Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif; }
.sheet { max-width: 186mm; margin: 0 auto; }
@media screen { body { background: #e6e6e6; } .sheet { background: #fff; padding: 12mm; margin: 8mm auto; box-shadow: 0 0 0 1px #bbb; max-width: 210mm; } }
.mono { font-family: "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace; }
.big { font-size: 12.5pt; }
.muted { color: #333; font-size: 8.5pt; }
.tag { display: inline-block; border: 1px solid #000; padding: 0 4px; font-size: 8pt; text-transform: uppercase; letter-spacing: .03em; vertical-align: 1px; }
h1 { font-size: 17pt; margin: 2mm 0 1.5mm; letter-spacing: -.01em; }
h2 { font-size: 11pt; margin: 0 0 2mm; padding: 1mm 0; border-bottom: 1.5pt solid #000; text-transform: uppercase; letter-spacing: .04em; }
h2 .n { display: inline-block; width: 6mm; }
h3 { font-size: 9.5pt; margin: 3mm 0 1mm; text-transform: uppercase; letter-spacing: .03em; }
.sheet-head { display: flex; justify-content: space-between; gap: 6mm; border-bottom: 2.5pt solid #000; padding-bottom: 3mm; margin-bottom: 3mm; }
.head-left { flex: 1; min-width: 0; }
.pharmacy { font-weight: 700; font-size: 11pt; }
.pharmacy-sub { font-size: 8.5pt; }
.head-right { text-align: center; flex: none; }
.barcode svg { display: block; max-width: 80mm; height: auto; }
.scan-hint { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .08em; }
.cd-badge { border: 2.5pt solid #000; font-weight: 800; font-size: 12pt; padding: 1mm 3mm; margin-bottom: 2mm; display: inline-block; letter-spacing: .05em; }
.kv { display: grid; grid-template-columns: 26mm 1fr; gap: .6mm 3mm; margin: 0; }
.kv dt { font-weight: 700; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .02em; padding-top: .5mm; }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.kv dd.alert { border: 1.5pt solid #000; padding: .5mm 2mm; }
.sec { margin: 0 0 3.2mm; }
.sec.keep, .sec.half { break-inside: avoid; }
h2, h3 { break-after: avoid; }
.kv dt, .kv dd { break-inside: avoid; }
.kv2 .kv { grid-template-columns: 26mm 1fr 26mm 1fr; }
.kv2 .kv dd { padding-right: 2mm; }
.halves { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.note { margin: 2mm 0; padding: 1.5mm 2.5mm; border-left: 2.5pt solid #000; }
.docs { margin: 1mm 0 0 5mm; padding: 0; }
.fail { text-decoration: underline; }
table.grid { width: 100%; border-collapse: collapse; margin-top: 1mm; font-size: 9pt; }
table.grid th, table.grid td { border: .75pt solid #000; padding: 1mm 1.5mm; text-align: left; vertical-align: top; }
table.grid th { font-size: 8pt; text-transform: uppercase; letter-spacing: .03em; border-bottom-width: 1.5pt; }
table.grid tr { break-inside: avoid; }
table.grid .c { text-align: center; width: 13mm; }
table.compare td.mark { font-size: 13pt; font-weight: 700; line-height: 1; }
table.compare tr.diff td { font-weight: 700; border-width: 1.5pt; }
table.findings td:first-child { width: 22mm; }
table.findings td:nth-child(2) { width: 18mm; }
table.findings td:last-child { width: 52mm; }
.sev { display: inline-block; font-weight: 800; font-size: 8pt; letter-spacing: .03em; padding: .3mm 1.2mm; border: 1pt solid #000; white-space: nowrap; }
tr.sev-hard_stop .sev { border-width: 2pt; }
.src { font-size: 8pt; margin-top: .6mm; }
.status-line { margin: 0 0 1.5mm; }
.box { display: inline-block; width: 3.6mm; height: 3.6mm; border: 1pt solid #000; vertical-align: -.7mm; text-align: center; line-height: 3.2mm; font-size: 8pt; font-weight: 700; }
.choices { line-height: 1.7; }
.line { display: block; border-bottom: .75pt solid #000; height: 5mm; }
.medline { margin: 0 0 1.5mm; }
.medname { font-size: 15pt; font-weight: 800; }
.medstr { font-size: 12pt; font-weight: 700; }
.cd-box { border: 3pt solid #000; padding: 2mm 3mm; margin-top: 2.5mm; break-inside: avoid; }
.cd-title { font-weight: 900; font-size: 13pt; letter-spacing: .05em; }
.cd-box ul, .points { list-style: none; margin: 1mm 0 0; padding: 0; }
.cd-box li, .points li { margin: .8mm 0; }
.writein { margin: 2mm 0 0; font-weight: 700; font-size: 8.5pt; }
.label-preview { border: 1.5pt solid #000; padding: 3mm 4mm; margin: 0; font: 8.5pt/1.35 "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.label-preview.empty { font-family: inherit; font-style: italic; }
.signgrid { display: grid; grid-template-columns: repeat(5, 1fr); border: 1.5pt solid #000; }
.sign { padding: 2mm; border-right: .75pt solid #000; min-height: 27mm; }
.sign:last-child { border-right: 0; }
.sign-title { font-weight: 800; text-transform: uppercase; font-size: 8.5pt; letter-spacing: .03em; border-bottom: .75pt solid #000; margin-bottom: 1.5mm; padding-bottom: .8mm; }
.field { margin-bottom: 1.8mm; }
.field .lbl { display: block; font-size: 7pt; text-transform: uppercase; letter-spacing: .03em; }
.field .fill { display: block; min-height: 5mm; border-bottom: .75pt solid #000; font-size: 8.5pt; font-weight: 700; padding-top: .5mm; overflow-wrap: anywhere; }
.sheet-foot { margin-top: 4mm; padding-top: 2mm; border-top: 1pt solid #000; font-size: 8pt; display: flex; justify-content: space-between; }
.sheet-foot strong { text-transform: uppercase; letter-spacing: .05em; }
`;

/**
 * Render the dispensing worksheet for one job.
 * @param {object} args
 * @param {object} args.job        platform.getJob(...) result
 * @param {object} args.pharmacy   config.pharmacy
 * @param {object|string} [args.printedBy] user (or name) printing the sheet
 * @param {Date|string} [args.printedAt]
 * @param {object|Array|Map} [args.users] user lookup by id (resolves entered_by etc.)
 * @param {object} [args.signoffs] { enter|clinical_check|assemble|final_check|release: { userId, at, proof? } }
 */
export function renderWorksheet({ job, pharmacy, printedBy, printedAt = new Date(), users, signoffs } = {}) {
  if (!job) throw new TypeError('renderWorksheet: job is required');
  const lookupUser = userLookup(users);
  const ctx = { job, pharmacy, printedBy, printedAt, lookupUser, signoffs };
  const body = `<main class="sheet">
${header(ctx)}
<div class="halves">${patientSection(ctx)}${prescriberSection(ctx)}</div>
${originalSection(ctx)}
${dispensingSection(ctx)}
${screeningSection(ctx)}
<div class="halves">${counsellingSection(ctx)}${labelSection(ctx)}</div>
${signoffSection(ctx)}
<footer class="sheet-foot"><strong>Prototype — not for clinical use</strong><span>Rx ${esc(worksheetId(job))} · ${esc(fmtDateTime(printedAt))}</span></footer>
</main>`;
  return documentShell({ title: `Dispensing worksheet — Rx ${worksheetId(job)}`, css: CSS, body });
}
