// Helpers shared by the printable documents. Every value that reaches the
// markup goes through esc(); templates never interpolate raw data.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Escape, falling back to an em dash for empty values. */
export const val = (v) => (v === null || v === undefined || v === '' ? '—' : esc(v));

export function fmtDateTime(v) {
  if (!v) return '—';
  // SQLite datetime('now') is UTC without a zone marker.
  const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-NZ', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

export function ageOn(dob, at = new Date()) {
  const b = new Date(dob);
  const now = new Date(at);
  if (Number.isNaN(b.getTime()) || Number.isNaN(now.getTime())) return null;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

/** Wrap body markup in a complete, self-contained HTML document (no scripts, no external resources). */
export function documentShell({ title, css, body, lang = 'en-NZ' }) {
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
