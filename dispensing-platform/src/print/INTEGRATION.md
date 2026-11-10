# Print module — integration

Printable outputs: the A4 **dispensing worksheet** (one per job, travels with
the basket) and the 100 × 150 mm **fulfilment label** (courier/delivery
shipping label, or in-store collection bag label). Pure, dependency-free
renderers produce standalone HTML (no JS, no external resources, every value
HTML-escaped); barcodes are inline-SVG Code 128.

Owned files: `src/print/**`, `test/print.test.js`. No schema (no tables).

| File | Exports |
|---|---|
| `code128.js` | `encodeCode128(text, {optimise})`, `code128Svg(text, opts)`, `validateCode128`, `PATTERNS` |
| `worksheet.js` | `renderWorksheet({ job, pharmacy, printedBy, printedAt, users, signoffs })`, `WORKSHEET_SECTIONS` |
| `shipping-label.js` | `renderShippingLabel({ fulfilment, pharmacy, printedAt })` |
| `index.js` | `createPrint({ platform, config })` → `{ worksheetHtml(jobId, user), labelHtml(fulfilmentId, user), worksheetUrl(jobId), labelUrl(fulfilmentId) }` |
| `routes.js` | `registerPrintRoutes(route, { print })`, `PRINT_CSP` |

`worksheetHtml` records `job.worksheet_printed` in the audit log;
`labelHtml` records `fulfilment.shipping_label_printed` / `fulfilment.bag_label_printed`.

## Routes are under `/api/print/...`

The router in `src/server.js` only dispatches paths starting with `/api/`
(everything else goes to `serveStatic`), so the routes are mounted at:

- `GET /api/print/jobs/:id/worksheet`
- `GET /api/print/fulfilments/:id/label`

Both return `{ __raw: html, type: 'text/html; charset=utf-8', headers }` with
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:`
plus `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`. `worksheetUrl()` / `labelUrl()` return these
`/api/print/...` paths. (If you would rather serve `/print/...` without the
`/api` prefix, change the `startsWith('/api/')` check in `handle()` to also
accept `/print/` and change the two patterns in `routes.js` and the URL helpers
in `index.js` — not recommended; keeping `/api/` needs no router change.)

## 1. `src/server.js`

```js
// imports (top of file)
import { createPrint, registerPrintRoutes } from './print/index.js';

// in createApp(), after `const counter = createCounter(...)`
const print = createPrint({ platform, config });

// after the other route(...) registrations, before `async function handle`
registerPrintRoutes(route, { print });

// optional: expose it like platform/counter
return { db, platform, counter, print, handle, server: createServer(handle) };
```

No hooks into `platform.js` are required. A flow engine step `print_worksheet`
can call `print.worksheetHtml(jobId, user)` (or just record that the sheet is
available and hand `print.worksheetUrl(jobId)` to the UI).

## 2. UI (`public/app.js`)

### Opening a print view

The prototype identifies the user with the `X-User-Id` header, which a plain
`<a href>` or `window.open(url)` will not send. Fetch with the header and open
the HTML as a blob (the page has no scripts, so a blob URL is safe; the user
prints with Ctrl/Cmd+P, or we call `print()` on the window):

```js
async function openPrint(path) {
  const w = window.open('', '_blank'); // open synchronously to avoid popup blockers
  try {
    const res = await fetch(path, { headers: userId ? { 'X-User-Id': userId } : {} });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
    w.location = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    w?.close();
    toast(err.message, true);
  }
}
const worksheetUrl = (jobId) => `/api/print/jobs/${jobId}/worksheet`;
const labelUrl = (fulfilmentId) => `/api/print/fulfilments/${fulfilmentId}/label`;
```

### Job view — "Print worksheet"

In `renderJobPane`, add a chip to the `#code-bar` toolbar (next to the
"Screen again" chip), so it is available at every state:

```js
<button class="chip" id="print-worksheet" title="A4 worksheet with barcode for the bench">⎙ Worksheet</button>
```

and wire it with the other toolbar handlers (after `$('#rescreen')?.addEventListener(...)`):

```js
$('#print-worksheet')?.addEventListener('click', () => openPrint(worksheetUrl(j.id)));
```

Natural moments to prompt a print: after data entry (`enter`) succeeds, and
before assembly (the flow guardrail puts `print_worksheet` before `assemble`).

### Fulfilment cards — "Print label"

In `renderFulfilment`, inside each card's `<div class="actions">` (before the
action buttons). Do **not** use a `data-f` attribute: the existing handler
binds every `[data-f]` element as a fulfilment action.

```js
<button data-print-label="${f.id}">${['pickup', 'compliance_pack'].includes(f.method) ? '⎙ Bag label' : '⎙ Shipping label'}</button>
```

and after the existing `document.querySelectorAll('[data-f]')...` block:

```js
document.querySelectorAll('[data-print-label]').forEach((b) => (b.onclick = () => openPrint(labelUrl(b.dataset.printLabel))));
```

For courier orders the label shows "Tracking reference pending" until the
order is dispatched (dispatch books the courier and assigns `tracking_ref`), so
the natural flow is Dispatch → Shipping label. Bag labels can be printed as soon
as the first item is released to pickup.

## Behaviour notes for reviewers

- **Privacy:** courier/delivery labels never show medicine names or NHI; they
  read "Pharmacy parcel, N items". Bag labels (pickup / compliance pack) stay in
  the pharmacy and list items with Rx numbers.
- **Signature required** when any job in the fulfilment has a `controlled_class`.
- **Keep cool** when a job's label text mentions refrigeration (2–8 °C), or a job
  carries `keep_cool: true`. The formulary has no explicit cold-chain flag yet;
  if one is added, pass it through `getFulfilment().jobs[].keep_cool`.
- **Sign-off grid** names come from `entered_by` / `clinical_checked_by` /
  `assembled_by` / `final_checked_by`; times and the handover user come from the
  latest `job.<action>` audit entries; handover proof from the completed fulfilment.
- **Repeats remaining** on the worksheet = `repeats_authorised − sequence`
  (after this supply), matching `buildLabel`.
- Barcodes: worksheet `RX-<jobId>-<sequence>`, courier label `tracking_ref`,
  bag label `pickup_code` (the counter's pickup-code lookup can take a scan).
  Verified readable with an independent decoder (zxing-cpp) from printed PDFs.
