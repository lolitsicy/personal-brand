// 100 mm × 150 mm thermal label for a fulfilment.
//  - courier / delivery: shipping label. The outside of a parcel must not say
//    what is inside, so it reads only "Pharmacy parcel, N items".
//  - pickup / compliance pack: collection bag label for the in-store shelf;
//    it stays inside the pharmacy, so it may list the items.
// Self-contained HTML: no JS, no external resources; every value escaped.

import { code128Svg } from './code128.js';
import { esc, val, fmtDateTime, documentShell } from './html.js';

const BAG_METHODS = new Set(['pickup', 'compliance_pack']);
const KEEP_COOL_RE = /refrigerat|fridge|keep cool|cold chain|2\s*(?:°|deg)?\s*(?:c\s*)?(?:-|–|to)\s*8\s*°?\s*c/i;

export const isBagLabel = (f) => BAG_METHODS.has(f?.method);

/** True when any job needs cold storage (explicit flag, or a fridge warning on its label/medicine). */
export function needsKeepCool(f) {
  return (f?.jobs ?? []).some((j) => j.keep_cool === true || j.keepCool === true
    || KEEP_COOL_RE.test(String(j.label_text ?? '')) || KEEP_COOL_RE.test(JSON.stringify(j.warnings ?? '')));
}

export const needsSignature = (f) => !!f?.hasControlled || (f?.jobs ?? []).some((j) => j.controlled_class);

const METHOD_LABEL = { courier: 'Courier', delivery: 'Pharmacy delivery', pickup: 'In-store collection', compliance_pack: 'Compliance pack collection' };

const CSS = `
@page { size: 100mm 150mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font: 10pt/1.25 Arial, Helvetica, "Liberation Sans", "DejaVu Sans", sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media screen { body { background: #ddd; padding: 6mm; } .label { box-shadow: 0 0 0 1px #999; margin: 0 auto; } }
.label { width: 100mm; height: 150mm; padding: 4mm; background: #fff; overflow: hidden; display: flex; flex-direction: column; gap: 2.2mm; page-break-after: always; break-after: page; }
.mono { font-family: "DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace; }
.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2pt solid #000; padding-bottom: 1.5mm; }
.top h1 { margin: 0; font-size: 13pt; text-transform: uppercase; letter-spacing: .03em; }
.top .ref { font-size: 8pt; text-align: right; }
.cap { font-size: 6.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
.from { font-size: 8pt; line-height: 1.25; }
.to { border: 2pt solid #000; padding: 2mm 3mm; }
.to .name { font-size: 16pt; font-weight: 800; line-height: 1.1; overflow-wrap: anywhere; }
.to .addr { font-size: 12pt; font-weight: 700; margin-top: 1mm; white-space: pre-line; overflow-wrap: anywhere; }
.svc { display: flex; justify-content: space-between; font-size: 9pt; border-bottom: .75pt solid #000; padding-bottom: 1mm; }
.svc strong { font-size: 10.5pt; }
.flags { display: flex; gap: 2mm; flex-wrap: wrap; }
.flag { border: 2.5pt solid #000; padding: 1mm 2.5mm; font-weight: 900; font-size: 11pt; text-transform: uppercase; letter-spacing: .03em; }
.flag.inv { background: #000; color: #fff; }
.contents { font-size: 11pt; font-weight: 700; }
.items { margin: 0; padding: 0; list-style: none; font-size: 8.5pt; }
.items li { border-bottom: .5pt solid #000; padding: .6mm 0; display: flex; justify-content: space-between; gap: 2mm; }
.code { text-align: center; }
.code .cap { margin-bottom: .8mm; }
.pickup-code { font-size: 30pt; font-weight: 900; letter-spacing: .15em; line-height: 1; margin: 1mm 0; }
.barcode { margin-top: auto; text-align: center; }
.barcode svg { width: 92mm; height: auto; display: block; margin: 0 auto; }
.barcode .pending { border: 1.5pt dashed #000; padding: 4mm; font-weight: 700; }
.foot { font-size: 6.5pt; display: flex; justify-content: space-between; border-top: .75pt solid #000; padding-top: .8mm; }
`;

/**
 * @param {object} args
 * @param {object} args.fulfilment platform.getFulfilment(...) (jobs may carry label_text/keep_cool)
 * @param {object} args.pharmacy   config.pharmacy
 * @param {Date|string} [args.printedAt]
 */
export function renderShippingLabel({ fulfilment: f, pharmacy, printedAt = new Date() } = {}) {
  if (!f) throw new TypeError('renderShippingLabel: fulfilment is required');
  const bag = isBagLabel(f);
  const title = bag ? 'Collection bag label' : 'Shipping label';
  const jobs = f.jobs ?? [];
  const count = jobs.length;
  const itemsText = `${count} item${count === 1 ? '' : 's'}`;
  const signature = needsSignature(f);
  const cool = needsKeepCool(f);

  const flags = [
    cool ? '<span class="flag inv" data-flag="keep-cool">❄ Keep cool 2–8 °C</span>' : '',
    signature ? `<span class="flag" data-flag="signature">${bag ? 'ID + signature on collection' : 'Signature required'}</span>` : '',
  ].filter(Boolean).join('');

  const sender = `<div class="blk from"><div class="cap">From</div><strong>${val(pharmacy?.name)}</strong><br>${val(pharmacy?.address)}${pharmacy?.phone ? `<br>Ph ${esc(pharmacy.phone)}` : ''}</div>`;

  let recipient;
  let middle;
  let barcode;
  if (bag) {
    recipient = `<div class="blk to"><div class="cap">For collection by</div><div class="name">${val(f.patient_name)}</div>${f.nhi ? `<div class="mono">NHI ${esc(f.nhi)}</div>` : ''}</div>`;
    middle = `<div class="code"><div class="cap">Pickup code</div><div class="pickup-code mono">${val(f.pickup_code)}</div></div>
<div class="contents">${esc(itemsText)}</div>
<ul class="items">${jobs.map((j) => `<li><span>${val(j.medicine)} ${val(j.strength)}${j.controlled_class ? ` <strong>[CD ${esc(j.controlled_class)}]</strong>` : ''}</span><span class="mono">Rx ${esc(j.id)}-${esc(j.sequence ?? 0)} · ${esc(j.quantity_supplied ?? '')}</span></li>`).join('')}</ul>`;
    barcode = f.pickup_code ? code128Svg(String(f.pickup_code), { module: 3, height: 70, fontSize: 18, label: `Pickup code ${f.pickup_code}` }) : '';
  } else {
    recipient = `<div class="blk to"><div class="cap">Deliver to</div><div class="name">${val(f.patient_name)}</div><div class="addr">${val(f.address)}</div></div>`;
    // Privacy: no medicine names on the outside of a parcel.
    middle = `<div class="contents">Pharmacy parcel, ${esc(itemsText)}</div>`;
    barcode = f.tracking_ref
      ? `<div class="cap">Tracking</div>${code128Svg(String(f.tracking_ref), { module: 2.4, height: 90, fontSize: 18, label: `Tracking ${f.tracking_ref}` })}`
      : '<div class="pending">Tracking reference pending — dispatch the order to book the courier, then reprint.</div>';
  }

  const body = `<main class="label" data-kind="${bag ? 'bag' : 'shipping'}">
<div class="top"><h1>${esc(title)}</h1><div class="ref"><span class="mono">ORDER ${esc(f.id)}</span><br>${esc(fmtDateTime(printedAt))}</div></div>
${sender}
${recipient}
<div class="svc"><span>Service<br><strong>${val(METHOD_LABEL[f.method] ?? f.method)}</strong></span><span style="text-align:right">${bag ? 'Status' : 'Provider'}<br><strong>${bag ? val(String(f.status ?? '').replace(/_/g, ' ')) : val(f.provider ?? (f.method === 'delivery' ? 'in-house' : 'not booked'))}</strong></span></div>
${flags ? `<div class="flags">${flags}</div>` : ''}
${middle}
<div class="barcode">${barcode}</div>
<div class="foot"><span>Prototype — not for clinical use</span><span>${bag ? 'Keep in dispensary' : 'If undeliverable return to sender'}</span></div>
</main>`;
  return documentShell({ title, css: CSS, body });
}
