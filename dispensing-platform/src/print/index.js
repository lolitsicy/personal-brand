// Printable outputs: dispensing worksheet (A4) and fulfilment labels
// (100 × 150 mm). createPrint wires the pure renderers to platform data.

import { renderWorksheet, worksheetBarcodeValue } from './worksheet.js';
import { renderShippingLabel, isBagLabel } from './shipping-label.js';

export { renderWorksheet } from './worksheet.js';
export { renderShippingLabel } from './shipping-label.js';
export { code128Svg, encodeCode128 } from './code128.js';
export { registerPrintRoutes } from './routes.js';

const STEP_ACTIONS = ['enter', 'clinical_check', 'assemble', 'final_check', 'release'];

export function createPrint({ platform, config }) {
  const pharmacy = () => config?.pharmacy ?? {};

  /** Most recent audit event per workflow step: { enter: { userId, at }, ... }. */
  function signoffsFor(job) {
    const out = {};
    let events = [];
    try {
      events = platform.audit.list({ entity: 'job', entityId: job.id, limit: 500 });
    } catch { /* audit unavailable: fall back to the user ids on the job */ }
    for (const e of events) { // newest first
      const step = String(e.action ?? '').replace(/^job\./, '');
      if (STEP_ACTIONS.includes(step) && !out[step]) out[step] = { userId: e.user_id, at: e.at };
    }
    if (job.fulfilment_id) {
      try {
        const f = platform.getFulfilment(job.fulfilment_id);
        if (f.status === 'completed' && f.proof && out.release) out.release.proof = f.proof;
      } catch { /* fulfilment gone: nothing to add */ }
    }
    return out;
  }

  function worksheetHtml(jobId, user, { printedAt = new Date() } = {}) {
    const job = platform.getJob(jobId, user);
    const users = platform.users();
    const html = renderWorksheet({ job, pharmacy: pharmacy(), printedBy: user ?? null, printedAt, users, signoffs: signoffsFor(job) });
    platform.audit.record({
      userId: user?.id ?? null,
      action: 'job.worksheet_printed',
      entity: 'job',
      entityId: job.id,
      data: { worksheet: worksheetBarcodeValue(job), state: job.state },
    });
    return html;
  }

  function labelHtml(fulfilmentId, user, { printedAt = new Date() } = {}) {
    const f = platform.getFulfilment(fulfilmentId);
    // Label text carries storage warnings (e.g. refrigerate) used for the Keep cool flag.
    const jobs = f.jobs.map((j) => {
      try {
        const full = platform.getJob(j.id, user);
        return { ...j, label_text: full.label_text ?? null };
      } catch {
        return j;
      }
    });
    const fulfilment = { ...f, jobs };
    const html = renderShippingLabel({ fulfilment, pharmacy: pharmacy(), printedAt });
    platform.audit.record({
      userId: user?.id ?? null,
      action: isBagLabel(f) ? 'fulfilment.bag_label_printed' : 'fulfilment.shipping_label_printed',
      entity: 'fulfilment',
      entityId: f.id,
      data: { method: f.method, trackingRef: f.tracking_ref ?? null, items: f.jobs.length },
    });
    return html;
  }

  return {
    worksheetHtml,
    labelHtml,
    worksheetUrl: (jobId) => `/api/print/jobs/${encodeURIComponent(jobId)}/worksheet`,
    labelUrl: (fulfilmentId) => `/api/print/fulfilments/${encodeURIComponent(fulfilmentId)}/label`,
  };
}
