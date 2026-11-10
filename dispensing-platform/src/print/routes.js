// HTTP routes for printable documents. Mounted under /api/ because the
// router in src/server.js only dispatches /api/* paths.

export const PRINT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const htmlResponse = (html) => ({
  __raw: html,
  type: 'text/html; charset=utf-8',
  headers: {
    'Content-Security-Policy': PRINT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  },
});

export function registerPrintRoutes(route, { print }) {
  route('GET', '/api/print/jobs/:id/worksheet', ({ params, user }) => htmlResponse(print.worksheetHtml(params.id, user)));
  route('GET', '/api/print/fulfilments/:id/label', ({ params, user }) => htmlResponse(print.labelHtml(params.id, user)));
}
