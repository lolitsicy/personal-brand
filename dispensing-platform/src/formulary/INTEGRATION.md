# Formulary module: integration notes for the lead

Module: `src/formulary/index.js`. Data: `data/formulary.demo.json` (DEMO DATA, not
clinically validated). Sources and licensing: `docs/formulary-sources.md`.
No schema or tables, and no HTTP routes are required.

## Contract recap

- `formulary.lookup(medicine)` and `formulary.check(ctx)` are **synchronous**, so they
  are safe inside `tx(db, ...)`. They never return a Promise.
- `await formulary.prefetch(medicines)` is the only async call. It fills the NZF cache
  when NZF is configured. With NZF unconfigured it resolves to
  `[{ source: 'New Zealand Formulary', skipped: true, reason: 'NZF data licence/API not configured: ...' }]`
  and never throws.
- On an NZF cache miss, or with NZF unconfigured, the lookup falls back to the local demo
  file. Each finding's `trace.source` then reads, for example,
  `Local demo formulary demo-formulary-2026.11 (unlicensed demo data); fell back from New Zealand Formulary: NZF data licence/API not configured`.
- Findings have `origin: 'formulary'` and the codes `NZF_DOSE`, `NZF_RENAL`, `NZF_HEPATIC`,
  `NZF_INTERACTION`, `NZF_DURATION` and `NZF_NOT_FOUND`. None of these collide with the
  codes in `screening.js`, so `dedupe`/`sortFindings` work unchanged. The formulary does
  not flag a same-ingredient duplicate, because screening.js's `DUPLICATE` rule already
  covers it.
- `ctx` is the existing `screeningContext(job)` result plus `history` (and optionally
  `now` or `newSupplyDays`). `ctx.item` is the `prescription_items` row, which already has
  `quantity`, `dose_units`, `doses_per_day` and `period_days`.

## 1. `src/services/platform.js`

```js
// imports
import { createDefaultFormulary, buildHistory } from '../formulary/index.js';

// signature: accept an injected formulary (tests), default to NZF-if-configured then local demo
export function createPlatform({ db, adapters, config, hooks = {}, formulary = createDefaultFormulary() }) {
```

Add a history query beside `screeningContext`:

```js
  // Released/completed supplies to this patient (excluding this job), for duration checks.
  function supplyHistory(job) {
    const rows = all(
      `SELECT m.ingredient,
              j.updated_at        AS supplied_at,
              j.quantity_supplied AS quantity_supplied,
              i.dose_units, i.doses_per_day, i.period_days
       FROM dispense_jobs j
       JOIN prescription_items i ON i.id = j.item_id
       JOIN prescriptions p ON p.id = i.prescription_id
       JOIN medicines m ON m.id = i.medicine_id
       WHERE p.patient_id = ? AND j.id <> ?
         AND j.state IN ('released','completed')
         AND j.quantity_supplied > 0
         AND j.updated_at >= datetime('now','-180 days')
       ORDER BY j.updated_at`,
      job.patient_id, job.id,
    );
    return buildHistory(rows); // [{ ingredient, suppliedAt ISO, daysSupplied }]; rows without a computable duration are skipped
  }
```

`buildHistory` takes days as `quantity_supplied / (dose_units * doses_per_day)`. If that
can't be computed it uses `period_days`, and if neither is available it skips the row.
SQLite `updated_at` values (`YYYY-MM-DD HH:MM:SS`, UTC) become ISO strings ending in `Z`.
If the lead later records a dedicated release timestamp, use it in place of `updated_at`.

Then, in `ruleFindings(job)`, merge the formulary findings:

```js
  function ruleFindings(job) {
    const ctx = screeningContext(job);
    const formularyRows = all('SELECT * FROM medicines');
    const rules = [...screen(ctx), ...lasaFindings(ctx.medicine, formularyRows)].map((f) => ({ ...f, origin: 'rules' }));
    const nzf = formulary.check({ ...ctx, history: supplyHistory(job) }); // sync, origin 'formulary'
    return { ctx, findings: [...rules, ...nzf] };
  }
```

`findingsForSignOff` keeps working. It re-runs `ruleFindings`, so the formulary findings
are part of the safety floor at sign-off, the same as the rules. It keeps only `origin === 'ai'`
from the stored screening, so formulary findings are never carried over stale.
`validateDecisions` handles `hard_stop` and `high` from either origin.

In `runScreening` (which is already async), warm the NZF cache before the sync work. Put
this before `const { ctx, findings: rules } = ruleFindings(job);`:

```js
    const pre = screeningContext(job);
    await formulary.prefetch([pre.medicine, ...pre.otherMeds]); // no-op/skip when NZF is not configured
```

The AI de-identified payload can include the formulary findings as is: they hold no
identifiers. `rule_findings: rules.map(...)` already covers them because they are in `rules`.

Optional: expose the chain status for the UI or an admin page, for example in a status
endpoint: `formulary.sources()` returns
`[{ name, version, licensed, configured, kind }]`.

## 2. `src/server.js` (optional)

Without changes, the platform creates `createDefaultFormulary()`. That reads
`NZF_BASE_URL` and `NZF_API_KEY` from the environment, and when they are unset NZF is
skipped and the demo file answers. To warm the cache at startup:

```js
import { createDefaultFormulary } from './formulary/index.js';
const formulary = createDefaultFormulary();
const platform = createPlatform({ db, adapters, config, formulary });
formulary.prefetch(db.prepare('SELECT ingredient FROM medicines').all()).catch(() => {});
```

## 3. Flow step `check_history`

The engine's `check_history` step (duplicates and duration-too-long) can reuse the
module directly:

```js
const findings = formulary.check({ ...ctx, history }).filter((f) => f.code === 'NZF_DURATION');
```

## 4. Tests

`test/formulary.test.js` covers the module by itself. In platform tests, inject
`createFormulary({ source: createLocalFormularySource() })` to make the demo data
deterministic. To keep other tests unaffected, pass
`{ check: () => [], lookup: () => null, prefetch: async () => [] }`.
