// Flow HTTP API (docs/flow-contract.md). `route(method, pattern, handler)` is the
// router from src/server.js; handlers receive { params, query, body, user }.

import { catalogue } from './catalogue.js';
import { validateFlow } from './validate.js';

const forbidden = (message) => Object.assign(new Error(message), { status: 403, code: 'FORBIDDEN' });
const badRequest = (message, details) => Object.assign(new Error(message), { status: 400, code: 'INVALID_FLOW', details });

const requireManager = (user, what) => {
  if (!user || !['pharmacist', 'admin'].includes(user.role)) throw forbidden(`Only a pharmacist or admin can ${what} flows`);
};

export function registerFlowRoutes(route, { engine }) {
  route('GET', '/api/flows', () => engine.listFlows());
  route('GET', '/api/flows/catalogue', () => catalogue());
  route('POST', '/api/flows/validate', ({ body }) => validateFlow(body?.definition));

  route('POST', '/api/flows', ({ body, user }) => {
    requireManager(user, 'create');
    const v = validateFlow(body?.definition);
    if (!v.ok) throw badRequest(`Flow is not valid: ${v.errors.join('; ')}`, { errors: v.errors });
    return engine.createFlow(body.definition, user, body.key);
  });

  route('POST', '/api/flows/:id/activate', ({ params, user }) => {
    requireManager(user, 'activate');
    return engine.activate(params.id, user);
  });

  route('GET', '/api/jobs/:id/flow', ({ params }) => engine.timeline(params.id));

  route('POST', '/api/jobs/:id/flow/retry/:stepId', ({ params, user }) => {
    if (!user || !['pharmacist', 'technician', 'admin'].includes(user.role)) throw forbidden('Only pharmacy staff can retry a flow step');
    return engine.retry(params.id, params.stepId, user);
  });
}
