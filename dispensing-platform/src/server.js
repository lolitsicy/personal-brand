import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { createMockAdapters } from './adapters/index.js';
import { createPlatform } from './services/platform.js';
import { createCounter } from './services/counter.js';
import { createDefaultFormulary } from './formulary/index.js';
import { createPrint, registerPrintRoutes } from './print/index.js';
import { schema as flowSchema, createFlowEngine, AUTOMATION_USER } from './flow/engine.js';
import { registerFlowRoutes } from './flow/routes.js';
import { validateScid } from './domain/scid.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export const DEFAULT_CONFIG = {
  pharmacy: { name: 'Demo Community Pharmacy', address: '1 Example St, Auckland', phone: '09 555 0100' },
  allowSelfCheck: false,
  accounts: { rx: '200', otc: '201' }, // accounting codes for the export
};

/**
 * pipeline: run the automated flow engine on every intake / transition / fulfilment.
 * Off by default so unit tests can drive each step by hand; the server turns it on.
 * formulary: a formulary instance (default: NZF if configured, else local demo data).
 */
export function createApp({ dbPath = ':memory:', adapters = createMockAdapters(), config = DEFAULT_CONFIG, withSeed = true, pipeline = false, formulary = createDefaultFormulary() } = {}) {
  const db = openDb(dbPath);
  if (withSeed) seed(db);
  const platform = createPlatform({ db, adapters, config });
  const counter = createCounter({ db, platform, adapters, config });
  const print = createPrint({ platform, config });

  // Formulary checks are part of screening (and of the safety floor at sign-off).
  if (formulary) platform.hooks.formulary = formulary;

  db.exec(flowSchema);
  const flows = createFlowEngine({ db, platform, adapters, config, hooks: { formulary, print } });
  flows.seedDefaults();
  if (pipeline) {
    const flowSafe = async (fn) => { try { await fn(); } catch (err) { console.error('[flow]', err); } };
    const isAutomation = (u) => u && u.name === AUTOMATION_USER.name && u.initials === AUTOMATION_USER.initials;
    platform.hooks.afterIntake = (rx) => flowSafe(() => flows.onPrescription(rx));
    // The engine's own actions (auto data entry, courier booking) must not re-enter it.
    platform.hooks.afterTransition = (jobId, action, user) => (isAutomation(user) ? null : flowSafe(() => flows.onTransition(jobId, action)));
    platform.hooks.afterFulfilment = (fid, action, user) => (isAutomation(user) ? null : flowSafe(() => flows.onFulfilment(fid)));
  }

  // ── tiny router ──
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', () => ({ ok: true }));
  route('GET', '/api/config', () => ({ pharmacy: config.pharmacy, allowSelfCheck: config.allowSelfCheck, sources: Object.keys(adapters.scriptSources) }));
  route('GET', '/api/users', () => platform.users());
  route('GET', '/api/dashboard', () => platform.dashboard());
  route('GET', '/api/home', ({ user }) => platform.home(user));

  route('GET', '/api/medicines', () => platform.medicines());
  route('POST', '/api/medicines/:id/stock', ({ params, body, user }) => platform.adjustStock(params.id, Number(body.delta), body.reason, user));
  route('GET', '/api/patients', ({ query }) => platform.patients(query.get('q') ?? ''));

  route('GET', '/api/scid/validate', ({ query }) => validateScid(query.get('scid')));
  route('GET', '/api/demo/escripts', () => adapters.scriptSources.nzeps?.list?.() ?? []);
  route('POST', '/api/intake/:source', ({ params, body, user }) =>
    params.source === 'manual' ? platform.intakeManual(body, user) : platform.intakeFromSource(params.source, body.id ?? body.scid, user));

  route('GET', '/api/prescriptions', ({ query }) => platform.listPrescriptions({ q: query.get('q'), status: query.get('status') }));
  route('GET', '/api/prescriptions/:id', ({ params }) => platform.getPrescription(params.id));
  route('GET', '/api/prescriptions/:id/original', ({ params }) => platform.originalFor(Number(params.id)));
  route('GET', '/api/prescriptions/:id/documents/:docId', ({ params }) => {
    const d = platform.getDocument(params.id, params.docId);
    return { __raw: d.data, type: d.mime, headers: { 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" } };
  });
  route('POST', '/api/items/:id/repeat', async ({ params, user }) => {
    const job = platform.requestRepeat(params.id, user);
    if (pipeline) { try { await flows.advance(job.id); } catch (err) { console.error('[flow]', err); } }
    return platform.getJob(job.id, user);
  });

  route('GET', '/api/queue', ({ query, user }) => platform.queue({ state: query.get('state') }, user));
  route('GET', '/api/jobs/:id', ({ params, user }) => platform.getJob(params.id, user));
  registerFlowRoutes(route, { engine: flows, platform });
  registerPrintRoutes(route, { print });
  route('POST', '/api/jobs/:id/screen', ({ params, user }) => platform.runScreening(params.id, user));
  route('POST', '/api/jobs/:id/amend', ({ params, body, user }) => platform.amend(params.id, user, body));
  route('POST', '/api/jobs/:id/supply-owing', ({ params, user }) => platform.supplyOwing(params.id, user));
  route('POST', '/api/jobs/:id/:action', ({ params, body, user }) => platform.transition(params.id, params.action.replace(/-/g, '_'), user, body));

  route('GET', '/api/screening/overrides', () => platform.overridesLog());

  route('GET', '/api/counter/products', () => counter.otcProducts());
  route('GET', '/api/counter/sales', () => counter.listSales());
  route('POST', '/api/counter/sales', ({ body, user }) => counter.openSale(user, body));
  route('GET', '/api/counter/sales/:id', ({ params }) => counter.getSale(params.id));
  route('POST', '/api/counter/sales/:id/lines', ({ params, body, user }) => counter.addLine(params.id, user, body));
  route('POST', '/api/counter/sales/:id/pickup', ({ params, body, user }) => counter.addByPickupCode(params.id, user, body.code));
  route('POST', '/api/counter/sales/:id/lines/:lineId/remove', ({ params, user }) => counter.removeLine(params.id, params.lineId, user));
  route('POST', '/api/counter/sales/:id/pay', ({ params, body, user }) => counter.pay(params.id, user, body));
  route('POST', '/api/counter/sales/:id/refund', ({ params, body, user }) => counter.refund(params.id, user, body));
  route('GET', '/api/counter/end-of-day', ({ query }) => counter.endOfDay(query.get('date') ?? undefined));
  route('GET', '/api/accounting.csv', ({ query }) => ({ __raw: counter.accountingCsv({ from: query.get('from'), to: query.get('to') }), type: 'text/csv' }));

  route('GET', '/api/stock/ledger', ({ query }) => platform.stockLedger(query.get('medicineId')));
  route('GET', '/api/stock/reorder', () => platform.reorderDraft());
  route('GET', '/api/stock/reorder.csv', () => {
    const d = platform.reorderDraft();
    return { __raw: ['code,product,on_hand,packs,pack_size,units', ...d.lines.map((l) => [l.code, `"${l.name}"`, l.onHand, l.packs, l.packSize, l.units].join(','))].join('\n'), type: 'text/csv' };
  });

  route('GET', '/api/fulfilments', ({ query }) => platform.listFulfilments({ status: query.get('status') }));
  route('GET', '/api/fulfilments/:id', ({ params }) => platform.getFulfilment(params.id));
  route('POST', '/api/fulfilments/:id/:action', ({ params, body, user }) => platform.fulfilmentAction(params.id, params.action, user, body));

  route('GET', '/api/cd-register', ({ query }) => platform.cdRegister(query.get('medicineId')));
  route('GET', '/api/claims', ({ query }) => platform.listClaims({ status: query.get('status') }));
  route('POST', '/api/claims/submit', ({ user }) => platform.submitClaims(user));
  route('GET', '/api/claims.csv', () => ({ __raw: platform.claimsCsv(), type: 'text/csv' }));

  route('GET', '/api/audit', ({ query }) => platform.audit.list({ entity: query.get('entity'), entityId: query.get('entityId') }));
  route('GET', '/api/audit/verify', () => platform.audit.verify());

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);

      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) return send(res, 404, { error: 'Not found' });
      const values = url.pathname.match(match.re).slice(1);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
      const body = req.method === 'POST' ? await readJson(req) : {};
      // PROTOTYPE AUTH: the acting user is taken from a header. Replace with
      // real authentication (SSO/MFA, per-user credentials) before any real use.
      const user = platform.getUser(req.headers['x-user-id']);
      const out = await match.handler({ params, query: url.searchParams, body, user });
      if (out?.__raw !== undefined) {
        res.writeHead(200, { 'Content-Type': out.type, ...(out.headers ?? {}) });
        return res.end(out.__raw);
      }
      send(res, 200, out);
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: err.message, code: err.code, details: err.details });
    }
  }

  return { db, platform, counter, flows, print, handle, server: createServer(handle) };
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data ?? null));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 9_000_000) throw Object.assign(new Error('Body too large'), { status: 413 });
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const { server } = createApp({ dbPath: process.env.DB_PATH ?? 'dispensing.db', pipeline: true });
  server.listen(port, () => console.log(`Dispensing platform running at http://localhost:${port}`));
}
