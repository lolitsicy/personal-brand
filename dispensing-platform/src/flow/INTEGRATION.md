# Flow engine: integration notes for the lead

Module files: `src/flow/catalogue.js`, `validate.js`, `defaults.js`, `engine.js`, `routes.js`.
Tests: `test/flow.test.js`. These notes cover everything that has to change in shared files.
All of it goes in **`src/server.js`**. `platform.js` needs no change (there is one optional
improvement in section 5).

## Why wire it in server.js and not platform.js

For e-scripts, the engine auto-confirms data entry: Automation calls `enter`. If the engine ran
inside `platform.intakeFromSource`, every nzeps job would already be `entered` when the call
returned. Many tests in `test/platform.test.js` call `p.transition(jobId, 'enter', lucy)` on
nzeps jobs, so they would fail with a 409. Wiring at the HTTP route layer avoids this:
platform unit tests stay as they are, and the app gets the pipeline. Flow errors are caught
and logged, so a flow problem can never break dispensing.

## 1. Imports (top of `src/server.js`)

```js
import { schema as flowSchema, createFlowEngine } from './flow/engine.js';
import { registerFlowRoutes } from './flow/routes.js';
// optional hooks, if those modules are integrated:
// import { createPrint } from './print/index.js';
// import { createDefaultFormulary } from './formulary/index.js';
```

## 2. Inside `createApp(...)`, after `const counter = ...`

```js
  db.exec(flowSchema);
  const flows = createFlowEngine({
    db, platform, adapters, config,
    hooks: {
      // formulary: platform's formulary instance (needs `lookup(medicine)`, sync or async),
      // print: createPrint({ platform, config }) (needs `worksheetUrl(jobId)`),
    },
  });
  flows.seedDefaults(); // idempotent: installs "E-script standard" + "Written script" v1 (active) and the Automation user

  // A flow must never break dispensing: log and carry on.
  const flowSafe = async (fn) => {
    try { return await fn(); } catch (err) { console.error('[flow]', err); return null; }
  };
```

If `hooks.formulary` / `hooks.print` are left out, `map_formulary` / `print_worksheet` are
recorded as `skipped` ("No formulary module installed" / "No print module installed").

## 3. Wrap the existing routes that change job state

Replace these existing routes. The handler bodies are the same as now, plus the flow calls.

```js
  route('POST', '/api/intake/:source', async ({ params, body, user }) => {
    const rx = params.source === 'manual' ? await platform.intakeManual(body, user) : await platform.intakeFromSource(params.source, body.id ?? body.scid, user);
    await flowSafe(() => flows.onPrescription(rx)); // start (pin flow) + advance every job
    return platform.getPrescription(rx.id);         // re-read: e-script jobs may now be 'entered'
  });

  route('POST', '/api/items/:id/repeat', async ({ params, user }) => {
    const job = platform.requestRepeat(params.id, user);
    await flowSafe(() => flows.advance(job.id));
    return platform.getJob(job.id, user);
  });

  route('POST', '/api/jobs/:id/screen', ({ params, user }) => platform.runScreening(params.id, user)); // unchanged

  route('POST', '/api/jobs/:id/supply-owing', ({ params, user }) => platform.supplyOwing(params.id, user)); // unchanged

  route('POST', '/api/jobs/:id/:action', async ({ params, body, user }) => {
    const action = params.action.replace(/-/g, '_');
    const job = await platform.transition(params.id, action, user, body);
    await flowSafe(() => flows.onTransition(job.id, action));
    return platform.getJob(job.id, user);
  });

  route('POST', '/api/fulfilments/:id/:action', async ({ params, body, user }) => {
    const f = await platform.fulfilmentAction(params.id, params.action, user, body);
    await flowSafe(() => flows.onFulfilment(f.id)); // e.g. a courier booking waiting for the last item to be released
    return platform.getFulfilment(f.id);
  });
```

Order matters for one route: **register the flow routes before `POST /api/jobs/:id/:action`**,
or at least make sure nothing else matches them. The flow paths have more segments than
the job routes, so the patterns don't collide in the current router; `test/flow.test.js`
checks this. Registering them first is still the safest choice.

## 4. Register the flow routes (in `createApp`, before the `/api/jobs/:id/:action` route)

```js
  registerFlowRoutes(route, { engine: flows, platform });
```

Then add `flows` to the object `createApp` returns: `return { db, platform, counter, flows, handle, server: ... }`.

Routes (as in `docs/flow-contract.md`):

| Method | Path | Who |
|---|---|---|
| GET | `/api/flows` | anyone |
| GET | `/api/flows/catalogue` | anyone |
| POST | `/api/flows/validate` `{definition}` | anyone |
| POST | `/api/flows` `{key?, definition}` | pharmacist/admin (else 403). 400 with `details.errors` if invalid |
| POST | `/api/flows/:id/activate` | pharmacist/admin (else 403) |
| GET | `/api/jobs/:id/flow` | anyone. `{ flow: null, steps: [], current: null }` if the job has no flow yet |
| POST | `/api/jobs/:id/flow/retry/:stepId` | pharmacist/technician/admin. 409 unless it's a *failed auto* step |

## 5. Optional platform.js improvement

`screen` with `config.useAi: false` has to work around `runScreening`, which has no
rules-only switch. The engine hides `adapters.reviewer` during the synchronous part of the call,
because `runScreening` reads it before its first `await`. That works with the current code but
depends on how it is implemented. A cleaner fix is a third parameter:

```js
async function runScreening(jobId, user, { useAi = true } = {}) {
  ...
  const reviewer = useAi ? adapters.reviewer : null;
```

The engine already passes `{ useAi }` as the third argument, so it picks this up with no change.

## 6. UI notes

- The engine adds a `users` row `{ name: 'Automation', initials: 'AU', role: 'technician' }`.
  `GET /api/users` (the prototype's user picker) will list it. Filter it out of the picker:
  `platform.users().filter((u) => !(u.name === 'Automation' && u.initials === 'AU'))`, or do it client-side.
  It is a technician, so even if someone picks it, it can't clinically or final check. The
  engine refuses to act if that row's role is ever changed.
- On a job, show `GET /api/jobs/:id/flow`. `current` is the step blocking progress: a failed
  step, a pending step, or a human step whose status is `waiting`. Auto steps with status
  `waiting` (`generate_label`, `book_courier`, `notify_patient`, `submit_claim` before release)
  have `output.reason` and do not block anything.
- A failed step's `error` is human-readable. Offer "Retry" only for failed auto steps.
