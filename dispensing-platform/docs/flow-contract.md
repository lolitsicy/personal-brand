# Integration contract (shared by all modules)

The platform lives in `dispensing-platform/`. Node 22, ESM, zero runtime deps
(except `@anthropic-ai/sdk`, optional). DB is `node:sqlite` (see `src/db.js`).
Tests: `node:test`, files `test/<name>.test.js`, run with `npm test`.

## Ownership — do NOT edit files you don't own
Shared files are integrated by the lead only: `src/server.js`, `src/db.js`,
`src/services/platform.js`, `src/services/counter.js`, `src/seed.js`,
`public/index.html`, `public/app.js`, `public/styles.css`, existing tests,
`package.json`, `README.md`. Read them freely. Each module exports:
- `schema` (string of `CREATE TABLE IF NOT EXISTS ...` SQL) if it needs tables
- a factory `createX(deps)`
- `registerXRoutes(route, deps)` if it has HTTP routes, where
  `route(method, pattern, handler)` is the existing router in `src/server.js`:
  handler receives `{ params, query, body, user }` and returns JSON-able data,
  or `{ __raw: string|Buffer, type: 'text/html; charset=utf-8', headers? }`.
  Throw errors with `.status` (400/403/404/409) — see `src/domain/errors.js`.
Write an `INTEGRATION.md` section in your module folder: exactly what the lead
must add to shared files (schema exec, factory call, route registration, hooks).

## Finding shape (screening results) — reuse exactly
{ id: 'CODE:subject' (lowercase), code: 'UPPER_SNAKE', severity: 'hard_stop'|'high'|'moderate'|'info',
  specialist: 'pharma'|'pharmacology'|'regulatory'|'advocacy', message: string,
  origin: 'rules'|'formulary'|'ai',
  trace: { inputs: object, rule: string, source: string, link?: string } }
Severity semantics: hard_stop = must not supply without pharmacist override + prescriber contact;
high = pharmacist must acknowledge; moderate = check; info = note.

## Flow model
Flow definition (JSON):
{ name: string, description?: string, appliesTo: ['nzeps','paper','signature_exempt','fax','phone'],
  steps: [ { id: string (unique, kebab), type: StepType, enabled: boolean, config: object } ] }
Stored versioned in table `flows(id INTEGER PK, key TEXT, version INTEGER, name, definition TEXT JSON,
  active INTEGER 0/1, created_by INTEGER, created_at)`; UNIQUE(key, version). Editing = new version.
At most one active version per key; when resolving which flow a prescription uses, pick the
active flow whose appliesTo includes the prescription source (first match by key order).
A job pins `flow_id` (specific version) when its first flow run starts.

Step catalogue (type → kind). Human steps map 1:1 to existing workflow actions in
`src/domain/workflow.js` (transition names in brackets):
 auto:  receive, match_patient, verify_original, map_formulary, check_stock, screen (rules + formulary + AI via platform.runScreening),
        check_history (duplicates + duration-too-long), print_worksheet, generate_label, book_courier, notify_patient, submit_claim
 human: data_entry [enter], clinical_check [clinical_check], assemble [assemble], final_check [final_check], handover [release]
Guardrails (validation must reject): clinical_check and final_check present, enabled, kind human;
order: screen before clinical_check; clinical_check before assemble; assemble before final_check;
final_check before handover; print_worksheet before assemble; generate_label/book_courier after final_check;
data_entry may be configured `config.autoFor: ['nzeps']` (auto-confirm structured e-scripts) but never for paper/fax.
Step run table `flow_step_runs(id PK, job_id, flow_id, step_id, type, kind, status
  'pending'|'running'|'done'|'waiting'|'failed'|'skipped', output TEXT JSON, error TEXT,
  started_at, finished_at)`.

## Flow HTTP API (engine implements, UI consumes)
GET  /api/flows                      -> [{ id, key, version, name, active, appliesTo, steps, created_at }]
GET  /api/flows/catalogue            -> [{ type, kind:'auto'|'human', label, description, required:boolean,
                                          configSchema: [{ key, label, type:'number'|'boolean'|'string'|'sources', default }] }]
POST /api/flows/validate  {definition}           -> { ok, errors: [string] }
POST /api/flows           {key?, definition}     -> created flow (new version; key derived from name if absent). 400 with errors if invalid.
POST /api/flows/:id/activate                     -> flow (deactivates other versions of same key)
GET  /api/jobs/:id/flow   -> { flow: {id,key,version,name}, steps: [{ stepId, type, kind, label, status, output, error, started_at, finished_at }], current: stepId|null }
POST /api/jobs/:id/flow/retry/:stepId            -> same as GET after retrying a failed auto step
Only pharmacist/admin may create/activate flows.
