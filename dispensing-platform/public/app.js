import { renderFlowDesigner, renderFlowTimeline } from './flow.js';

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (c) => `$${(c / 100).toFixed(2)}`;

const COLUMNS = [
  ['queued', 'Received'],
  ['entered', 'Entered'],
  ['clinically_checked', 'Clinical ✓'],
  ['assembled', 'Assembled'],
  ['checked', 'Final ✓'],
  ['on_hold', 'On hold'],
];
const ACTION_LABEL = {
  enter: 'Confirm data entry', clinical_check: 'Clinical check', assemble: 'Assemble + label',
  final_check: 'Final check', release: 'Release', hold: 'Hold', resume: 'Resume', cancel: 'Cancel',
};

let userId = localStorageGet('userId');
let currentTab = 'home';
let users = [];

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-User-Id': userId } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error ?? res.statusText), { status: res.status, details: data?.details });
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ''), 3500);
}

const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ───────────── boot ─────────────
async function boot() {
  const [cfg, userList] = await Promise.all([api('/api/config'), api('/api/users')]);
  users = userList;
  document.querySelectorAll('[data-pharmacy]').forEach((el) => (el.textContent = cfg.pharmacy.name));
  const sel = $('#user-select');
  sel.innerHTML = users.map((u) => `<option value="${u.id}">${esc(u.name)} (${u.role})</option>`).join('');
  if (!users.some((u) => String(u.id) === userId)) userId = String(users[0].id);
  sel.value = userId;
  const setAvatar = () => ($('#user-avatar').textContent = users.find((u) => String(u.id) === userId)?.initials ?? '');
  setAvatar();
  sel.onchange = () => { userId = sel.value; localStorageSet('userId', userId); setAvatar(); render(); };
  $('#new-script').onclick = () => showTab('intake');
  $('#global-search').onsubmit = (e) => { e.preventDefault(); $('#rx-search').value = $('#global-search-input').value; showTab('prescriptions'); };

  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $('#queue-filter').onchange = () => { selectedJobId = null; renderQueue(); };
  setCrumb(['Today']);
  $('#scid-form').onsubmit = guard(onScidSubmit);
  $('#scid-input').oninput = debounce(onScidInput, 200);
  $('#manual-form').onsubmit = guard(onManualSubmit);
  $('#rx-search').oninput = debounce(renderPrescriptions, 200);
  $('#submit-claims').onclick = guard(async () => {
    const r = await api('/api/claims/submit', { method: 'POST' });
    toast(r.batchRef ? `${r.batchRef}: ${r.accepted} accepted, ${r.rejected} rejected` : 'No pending claims');
    renderClaims();
  });
  const meds = await api('/api/medicines');
  $('#med-select').innerHTML = meds.map((m) => `<option value="${esc(m.code)}">${esc(m.name)} ${esc(m.strength)}${m.controlled_class ? ` (CD ${m.controlled_class})` : ''}</option>`).join('');
  render();
}

const TAB_TITLE = { home: 'Today', queue: 'Queue', intake: 'Intake', prescriptions: 'Scripts', counter: 'Counter', fulfilment: 'Fulfilment', stock: 'Stock & CD', claims: 'Claims', safety: 'Safety log', audit: 'Audit', flows: 'Pharmacy flows' };
function setCrumb(parts) {
  $('#crumb').innerHTML = parts.map((p, i) => (i === 0 ? `<span>${p}</span>` : `<span class="sep">›</span>${p.startsWith('<') ? p : `<b>${p}</b>`}`)).join(' ');
}

function showTab(tab) {
  currentTab = tab;
  setCrumb([TAB_TITLE[tab] ?? tab]);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  render();
}

function render() {
  guard(updateNavCount)();
  return guard(({ home: renderHome, queue: renderQueue, intake: renderIntake, prescriptions: renderPrescriptions, counter: renderCounter, fulfilment: renderFulfilment, stock: renderStock, claims: renderClaims, safety: renderSafety, audit: renderAudit, flows: renderFlows })[currentTab])();
}

// ───────────── flows + printing ─────────────
const currentUser = () => users.find((u) => String(u.id) === userId);
function renderFlows() {
  const el = $('#flow-designer'); const fresh = el.cloneNode(false); el.replaceWith(fresh);
  renderFlowDesigner(fresh, { api, toast, user: currentUser() });
}

/** Print views need the acting-user header, so fetch them and open as a blob. */
async function openPrint(path) {
  const w = window.open('', '_blank');
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

// ───────────── home ─────────────
async function updateNavCount() {
  const d = await api('/api/dashboard');
  const n = ['queued', 'entered', 'clinically_checked', 'assembled', 'checked'].reduce((t, k) => t + (d.jobs[k] ?? 0), 0);
  $('#nav-queue-count').textContent = n || '';
  const h = await api('/api/home');
  $('#case-desc').textContent = `${h.inProgress} script${h.inProgress === 1 ? '' : 's'} in progress · ${h.awaitingPharmacist} waiting for a pharmacist · ${h.readyForCollection} ready to collect`;
}

function since(ts) {
  if (!ts) return '—';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(ts.replace(' ', 'T') + 'Z')) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function renderHome() {
  const h = await api('/api/home');
  const n = h.next;
  const card = $('#next-decision');
  card.className = `card next-card ${n?.finding?.severity ?? ''}`;
  if (n) {
    const stepLabel = n.step === 'clinical_check' ? 'Clinical check' : 'Final check';
    const reason = n.finding ? ({ hard_stop: 'Hard stop', high: 'Needs review', moderate: 'Check', info: 'Ready' })[n.finding.severity] : 'Ready';
    card.innerHTML = `
      <div class="eyebrow">Next decision · ${esc(stepLabel)} · ${esc(reason)}</div>
      <div class="med">${esc(n.medicine)} <span class="muted" style="font-size:20px">${esc(n.form)}</span></div>
      <div class="who">${esc(n.patient)} · NHI ${esc(n.nhi ?? '—')} · ${esc(n.source)} · waiting ${since(n.waitingSince)} ${n.controlled ? `<span class="tag cd">CD ${esc(n.controlled)}</span>` : ''}</div>
      ${n.finding ? `<div class="why">${esc(n.finding.message)}</div>` : '<div class="why">No findings that need a decision.</div>'}
      <div class="actions"><button class="primary" id="open-next">Open the script →</button></div>`;
    $('#open-next').onclick = guard(() => openJob(n.jobId));
  } else {
    card.innerHTML = `<div class="eyebrow">Next decision</div><div class="empty-state">Nothing is waiting for a pharmacist.</div>`;
  }
  $('#side-stats').innerHTML = [
    [h.awaitingPharmacist, 'waiting for a pharmacist'],
    [h.inProgress, 'scripts in progress'],
    [since(h.oldestWaitingSince), 'longest wait'],
  ].map(([v, l]) => `<div class="side-stat"><b>${v}</b><span>${l}</span></div>`).join('');

  const t = h.today;
  $('#kpis').innerHTML = [
    ['Received today', t.received, 'supplies queued'],
    ['Screened', t.screened, 'rules + reviewer'],
    ['Hard stops resolved', t.hardStops, `${t.overrides} overridden with a reason`],
    ['Reviewed findings', t.acknowledged, 'acknowledged by a pharmacist'],
    ['Released', t.released, `${h.readyForCollection} awaiting pickup · ${h.outForDelivery} out for delivery`],
  ].map(([l, v, sub]) => `<div class="kpi"><span class="label">${l}</span><b>${v}</b><span class="sub">${sub}</span></div>`).join('');

  barChart($('#days-chart'), h.days.map((d) => ({ label: d.day, value: d.n })));

  $('#collections').innerHTML = h.collections.map((f) => `<li><span><b>${esc(f.patient_name)}</b><br/><span class="muted">${esc(f.method.replace('_', ' '))} · ${f.items} item${f.items === 1 ? '' : 's'}</span></span>
    ${f.pickup_code && f.method === 'pickup' ? `<code>${esc(f.pickup_code)}</code>` : f.tracking_ref ? `<span class="tag">${esc(f.tracking_ref)}</span>` : statusTag(f.status)}</li>`).join('') || '<li class="muted">Nothing waiting.</li>';
}

/** Single-series bar chart: one hue, 4px rounded tops anchored to the baseline, recessive grid, hover tooltip. */
function barChart(el, data) {
  const W = el.clientWidth || 600, H = 220, padL = 28, padB = 24, padT = 8;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = Math.ceil(max / 4) || 1;
  const top = step * 4;
  const plotW = W - padL, plotH = H - padB - padT;
  const slot = plotW / data.length, bw = Math.max(4, Math.min(28, slot - 6));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const grid = [0, 1, 2, 3, 4].map((i) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(i * step)}" y2="${y(i * step)}"/><text class="axis" x="${padL - 6}" y="${y(i * step) + 4}" text-anchor="end">${i * step}</text>`).join('');
  const fmt = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
  const bars = data.map((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2, h = Math.max(0, y(0) - y(d.value)), r = Math.min(4, h, bw / 2);
    const path = h ? `M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + bw - r} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + r} V${y(0)} Z` : '';
    const label = i % 2 === data.length % 2 || i === data.length - 1 ? `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${i === data.length - 1 ? 'Today' : fmt(d.label)}</text>` : '';
    return `<g data-i="${i}"><rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>${path ? `<path class="bar" d="${path}"/>` : ''}${label}</g>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scripts received per day, last 14 days">${grid}${bars}</svg><div class="tooltip"></div>
    <table class="sr-only" style="position:absolute;left:-9999px"><tr><th>Day</th><th>Scripts</th></tr>${data.map((d) => `<tr><td>${d.label}</td><td>${d.value}</td></tr>`).join('')}</table>`;
  const tip = el.querySelector('.tooltip');
  el.querySelectorAll('g[data-i]').forEach((g) => {
    g.onmouseenter = () => {
      const d = data[g.dataset.i];
      g.querySelector('.bar')?.classList.add('hover');
      const r = g.querySelector('rect');
      tip.textContent = `${fmt(d.label)}: ${d.value} script${d.value === 1 ? '' : 's'}`;
      tip.style.left = `${((+r.getAttribute('x') + slot / 2) / W) * 100}%`;
      tip.style.top = `${y(d.value)}px`;
      tip.classList.add('show');
    };
    g.onmouseleave = () => { g.querySelector('.bar')?.classList.remove('hover'); tip.classList.remove('show'); };
  });
}

// ───────────── queue (stage list · script view · reviewer rail) ─────────────
let selectedJobId = null;
let railOpen = true;
let railTab = 'original';
const openTrace = new Set();

const SPECIALIST = { pharma: 'medication review', pharmacology: 'clinical pharmacology', regulatory: 'regulatory', advocacy: 'patient advocacy' };
const LANG = { en: 'English', mi: 'te reo Māori', sm: 'Samoan', to: 'Tongan', zh: 'Chinese', hi: 'Hindi' };
const SEV_LABEL = { hard_stop: 'Hard stop', high: 'Review', moderate: 'Check', info: 'Note' };
const ICONS = {
  stop: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M12 8v5M12 16.5v.01"/>',
  alert: '<path d="M12 4 2.8 20h18.4z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  dot: '<circle cx="12" cy="12" r="8"/><path d="M8.5 12h7"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.01"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.4 2.5 2.5 4.9-5.1"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  diff: '<path d="M6 9.5h12M6 14.5h12M15.5 5l-7 14"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  print: '<path d="M7 9V4h10v5"/><path d="M7 17H4.5v-7h15v7H17"/><path d="M7 14h10v6H7z"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  pill: '<rect x="3" y="8.5" width="18" height="7" rx="3.5"/><path d="M12 8.5v7"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
const ico = (name) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const SEV_ICON_NAME = { hard_stop: 'stop', high: 'alert', moderate: 'dot', info: 'info', ok: 'check' };
/** Status tag: icon + word, tinted by severity. Never colour alone. */
const stag = (kind, label, { href, title } = {}) => {
  const icon = ico(SEV_ICON_NAME[kind] ?? kind);
  return href
    ? `<a class="stag s-${kind}" href="${href}" ${title ? `title="${esc(title)}"` : ''}>${icon}<span>${esc(label)}</span></a>`
    : `<span class="stag s-${kind}" ${title ? `title="${esc(title)}"` : ''}>${icon}<span>${esc(label)}</span></span>`;
};

async function renderQueue() {
  const jobs = await api('/api/queue');
  const filter = $('#queue-filter').value;
  const keep = (j) => filter === 'all' ? true
    : filter === 'pharmacist' ? ['entered', 'assembled'].includes(j.state)
    : filter === 'flagged' ? ['hard_stop', 'high'].includes(j.top_severity)
    : filter === 'cd' ? !!j.controlled_class : true;
  const visible = jobs.filter(keep);
  if (!selectedJobId || !jobs.some((j) => j.id === selectedJobId)) {
    const rank = (j) => ({ hard_stop: 0, high: 1 })[j.top_severity] ?? (j.state === 'entered' ? 2 : j.state === 'assembled' ? 3 : 4);
    selectedJobId = [...visible].sort((a, b) => rank(a) - rank(b))[0]?.id ?? null;
  }
  $('#thread-list').innerHTML = COLUMNS.map(([state, title], i) => {
    const list = visible.filter((j) => j.state === state);
    const worst = list.some((j) => j.top_severity === 'hard_stop') ? 'hard_stop' : list.some((j) => j.top_severity === 'high') ? 'high' : null;
    const open = list.length && (list.some((j) => j.id === selectedJobId) || ['entered', 'assembled'].includes(state));
    return `<details class="thread ${list.length ? '' : 'empty-group'}" ${open ? 'open' : ''}>
      <summary><span class="n">${list.length}</span>${title}${worst ? `<span class="tflag s-${worst}" title="${worst === 'high' ? 'Has findings to review' : 'Has a hard stop'}">${ico(worst === 'high' ? 'alert' : 'stop')}</span>` : ''}</summary>
      ${list.map((j) => `<div class="titem ${j.id === selectedJobId ? 'sel' : ''}" data-id="${j.id}" title="${esc(j.patient_name)}">
        <span class="ico">${j.controlled_class ? 'CD' : 'Rx'}</span><span class="t">${esc(j.medicine)} ${esc(j.strength)} · ${esc(j.patient_name.split(' ')[0])}</span>
        ${j.top_severity && j.top_severity !== 'info' ? `<span class="sevdot ${j.top_severity}"></span>` : ''}</div>`).join('')}
    </details>`;
  }).join('');
  document.querySelectorAll('.titem').forEach((el) => (el.onclick = () => { selectedJobId = Number(el.dataset.id); renderQueue(); }));
  if (selectedJobId) await renderJobPane(selectedJobId);
  else { $('#job-pane').innerHTML = '<div class="empty">Nothing in the queue for this filter.</div>'; $('#code-bar').innerHTML = ''; setCrumb(['Queue']); }
}

/** Open a job from anywhere: jump to the queue with it selected. */
async function openJob(id) {
  selectedJobId = Number(id);
  showTab('queue');
}

function ageOf(dob) { if (!dob) return null; const d = new Date(dob); return Math.floor((Date.now() - d) / 31557600000); }

async function renderJobPane(id, { autoScreen = true } = {}) {
  let j = await api(`/api/jobs/${id}`);
  if (autoScreen && j.state === 'entered' && (!j.screening || j.screening.status !== 'pending')) {
    await api(`/api/jobs/${id}/screen`, { method: 'POST' }).catch(() => {});
    j = await api(`/api/jobs/${id}`);
  }
  const signedOff = j.warnings_acknowledged;
  const SPEC_ORDER = ['pharma', 'pharmacology', 'regulatory', 'advocacy'];
  const SEV_ORDER = ['hard_stop', 'high', 'moderate', 'info'];
  const findings = [...(j.warnings ?? signedOff?.warnings ?? [])]
    .sort((a, b) => SPEC_ORDER.indexOf(a.specialist) - SPEC_ORDER.indexOf(b.specialist) || SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const editable = j.actions.includes('clinical_check');
  const decisions = signedOff?.decisions ?? {};
  const fileName = `${j.medicine.toLowerCase().replace(/\s+/g, '_')}_${j.strength.replace(/\s+/g, '')}.rx`;
  setCrumb(['Queue', `<span class="file"><i>Rx</i><b>${esc(fileName)}</b></span>`, `<span class="when">${esc(new Date(j.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>`]);

  // toolbar above the panel
  $('#code-bar').innerHTML = `
    ${['queued', 'entered'].includes(j.state) ? `<button class="chip" id="rescreen">${ico('refresh')} Screen again</button>` : ''}
    <button class="chip" id="print-worksheet" title="Print the standardised dispensing worksheet">${ico('print')} Worksheet</button>
    <span class="chip">${esc(({ nzeps: 'NZePS e-script', paper: 'Paper', fax: 'Fax', phone: 'Phone order', signature_exempt: 'Signature exempt' })[j.source] ?? j.source)}</span>
    <span class="chip">${esc(j.patient_name)}</span>
    <span class="grow"></span>
    ${j.controlled_class ? `<span class="chip">CD ${esc(j.controlled_class)}</span>` : ''}
    <span class="chip"><span class="dot"></span>${j.scid ? `${esc(j.scid.slice(0, 6))}… · ` : ''}${since(j.created_at)} ago</span>
    <span class="chip">${esc(j.state.replace('_', ' '))}</span>`;

  // ── the e-script panel: every field, with its flags and any difference from the original ──
  const age = ageOf(j.patient?.dob);
  const o = j.original;
  const canEdit = ['queued', 'entered'].includes(j.state) && ['technician', 'pharmacist', 'admin'].includes(currentUser()?.role);
  const editing = canEdit && editJobId === j.id;
  const flags = fieldFlags(findings);
  const srcWord = o?.kind === 'electronic' ? 'Original' : 'Keyed';
  const diff = (field) => o?.compare?.find((c) => c.field === field && !c.match);
  const worst = (list) => list.reduce((w, f) => (SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(w) ? f.severity : w), 'info');
  // One chip per kind of flag on a field (rule and formulary may both raise it); show the most severe.
  const chips = (key) => {
    const byLabel = new Map();
    for (const f of (flags[key] ?? []).filter((x) => x.severity !== 'info')) {
      const label = shortFlag(f), cur = byLabel.get(label);
      const rank = (x) => (decisions[x.id] ? 9 : SEV_ORDER.indexOf(x.severity));
      if (!cur || rank(f) < rank(cur)) byLabel.set(label, f);
    }
    return [...byLabel.entries()].map(([label, f]) =>
      stag(decisions[f.id] ? 'ok' : f.severity, label, { href: `#flag-${esc(f.id)}`, title: f.message })).join('');
  };
  const field = (key, label, valueHtml, { diffField, input } = {}) => {
    const list = (flags[key] ?? []).filter((f) => f.severity !== 'info' && !decisions[f.id]);
    const d = diffField ? diff(diffField) : null;
    const sev = list.length ? worst(list) : d ? 'high' : '';
    return `<div class="rx-field ${sev ? `sev-${sev}` : ''}">
      <div class="rx-label">${label}</div>
      <div class="rx-value">${editing && input ? input : valueHtml}
        ${d && !editing ? `<div class="rx-orig">${srcWord}: <s>${esc(d.received)}</s></div>` : ''}</div>
      <div class="rx-flags">${chips(key)}${d ? `<span class="stag s-edit">${ico('diff')}<span>Changed</span></span>` : ''}</div>
    </div>`;
  };
  const num = (name, val, attrs = '') => `<input class="rx-in" type="number" name="${name}" value="${esc(val ?? '')}" ${attrs} />`;
  const dailyMg = j.dose_units && j.doses_per_day && j.unit_mg ? j.dose_units * j.doses_per_day * j.unit_mg : null;
  const p = o?.payload ?? {};
  const escriptHtml = `
    <form class="rx-panel" id="rx-form" onsubmit="return false">
      <div class="rx-top">
        <div><div class="rx-kind">${o?.kind === 'electronic' ? 'NZ e-prescription' : o?.kind === 'document' ? 'Written prescription (scanned)' : 'Verbal order'}</div>
          <div class="rx-scidline">${j.scid ? `SCID <b>${esc(j.scid)}</b> · ` : ''}Rx ${esc(j.id)}-${esc(j.sequence)} · ${j.sequence === 0 ? 'original supply' : `repeat ${j.sequence}`}</div></div>
        <div class="rx-top-right">${o?.intact ? `<span class="stag s-ok">${ico('shield')}<span>Original intact</span></span>` : stag('hard_stop', 'Integrity failed')}
          ${editing ? `<span class="stag s-edit">${ico('edit')}<span>Editing</span></span>` : ''}</div>
      </div>
      <div class="rx-cols">
        <section class="rx-sec"><h5>Prescriber</h5>
          ${field('prescriber', 'Name', esc(j.prescriber_name))}
          ${field('prescriber_ids', 'CPN · Practice', esc([p.prescriber?.cpn, p.prescriber?.facilityName].filter(Boolean).join(' · ') || '—'))}
          ${field('prescribed', 'Prescribed', esc(p.prescribedAt ?? '—'))}
        </section>
        <section class="rx-sec"><h5>Patient</h5>
          ${field('patient', 'Name · NHI', `${esc(j.patient_name)} · <span class="mono">${esc(j.nhi ?? '—')}</span>`)}
          ${field('age', 'DOB · Age', `${esc(j.patient?.dob ?? '—')}${age != null ? ` · ${age}` : ''}`)}
          ${field('allergies', 'Allergies', (j.patient?.allergies ?? []).length ? j.patient.allergies.map((a) => `<b>${esc(a)}</b>`).join(', ') : 'None recorded')}
          ${field('egfr', 'eGFR', j.patient?.egfr != null ? `${j.patient.egfr} mL/min/1.73m²` : 'Not recorded')}
        </section>
      </div>
      <section class="rx-sec rx-item"><h5>Medicine</h5>
        ${field('medicine', 'Medicine', `<span class="rx-med">${esc(j.medicine)} ${esc(j.strength)} ${esc(j.form)}</span> <span class="mono muted">${esc(j.medicine_code ?? '')}</span>${j.controlled_class ? ` <span class="stag s-cd">${ico('pill')}<span>Controlled · Class ${esc(j.controlled_class)}</span></span>` : ''}`, { diffField: 'Medicine' })}
        ${field('directions', 'Directions', `<span class="rx-dir">${esc(j.directions)}</span>`, { diffField: 'Directions', input: `<textarea class="rx-in" name="directions" rows="2">${esc(j.directions)}</textarea>` })}
        ${field('dose', 'Dose', j.dose_units && j.doses_per_day ? `${j.dose_units} × ${j.doses_per_day} a day${dailyMg ? ` <span class="muted">(${dailyMg} mg/day)</span>` : ''}` : '<span class="muted">Free text only</span>', { diffField: 'Dose', input: `${num('doseUnits', j.dose_units, 'step="0.5" min="0"')} units × ${num('dosesPerDay', j.doses_per_day, 'step="1" min="0"')} a day` })}
        ${field('quantity', 'Quantity', `<b>${j.quantity}</b>${j.quantity_supplied ? ` <span class="muted">· supplied ${j.quantity_supplied}${j.owing ? `, owing ${j.owing}` : ''}</span>` : ''} <span class="muted">· ${j.on_hand} on hand</span>`, { diffField: 'Quantity', input: num('quantity', j.quantity, 'min="1" step="1"') })}
        ${field('repeats', 'Repeats', `${j.repeats_authorised} <span class="muted">· this is supply ${j.sequence + 1} of ${j.repeats_authorised + 1}</span>`, { diffField: 'Repeats', input: num('repeats', j.repeats_authorised, 'min="0" step="1"') })}
        ${field('period', 'Supply period', j.period_days ? `${j.period_days} days` : '—', { diffField: 'Supply period', input: `${num('periodDays', j.period_days, 'min="1" step="1"')} days` })}
        ${editing ? `<div class="rx-field rx-reason"><div class="rx-label">Reason for change</div><div class="rx-value"><input class="rx-in" name="reason" placeholder="Required, e.g. clarified with prescriber by phone" /></div><div></div></div>` : ''}
      </section>
      <section class="rx-sec"><h5>Other medicines (${j.medication_list?.length ?? 0})</h5>
        ${(j.medication_list ?? []).map((m) => field(`med:${m.ingredient.toLowerCase()}`, esc(m.source), esc(m.name ?? m.ingredient))).join('') || '<div class="rx-empty">None on record</div>'}
      </section>
      <section class="rx-sec"><h5>Flags for the pharmacist <span class="muted">· ${esc(j.screening?.reviewer ?? 'rules only')} · ${esc(j.screening?.status ?? 'not run')}</span></h5>
        ${flagListHtml(findings, decisions, j.actions.includes('clinical_check'))}
      </section>
      ${j.label_text ? `<section class="rx-sec"><h5>Label</h5><pre class="label">${esc(j.label_text)}</pre></section>` : ''}
    </form>`;

  const counsel = j.screening?.counselling;
  const aiCount = findings.filter((f) => f.origin === 'ai' && f.code !== 'AI_STATUS').length;
  const aiStatus = findings.find((f) => f.code === 'AI_STATUS');
  $('#job-pane').innerHTML = `
    <div class="code rx-scroll">${escriptHtml}</div>
    <aside class="rail ${railOpen ? '' : 'closed'}">
      <button class="chip accent rail-toggle" id="rail-toggle">${railOpen ? 'Hide panel' : 'Show panel'} <span class="chev ${railOpen ? 'open' : ''}">${ico('chevron')}</span></button>
      <div class="rail-tabs">
        <button class="${railTab === 'original' ? 'on' : ''}" data-rail="original">Original script</button>
        <button class="${railTab === 'flow' ? 'on' : ''}" data-rail="flow">Pipeline</button>
        <button class="${railTab === 'reviewer' ? 'on' : ''}" data-rail="reviewer">AI reviewer</button>
      </div>
      ${railTab === 'original' ? originalHtml(j, o) : railTab === 'flow' ? '<div id="job-flow"></div>' : `
        <div class="meta">${esc(j.screening?.reviewer ?? 'Not run yet')} · ${aiCount} added finding${aiCount === 1 ? '' : 's'}${aiStatus ? `<br/>${esc(aiStatus.message)}` : ''}</div>
        <div class="meta">Works on a de-identified case. Can add findings; can't clear or downgrade a rule.</div>
        ${counsel ? `<h4>Counselling draft · ${esc(LANG[counsel.language] ?? counsel.language)}</h4><div class="counsel">${esc(counsel.text)}</div>` : ''}`}
    </aside>
    <div class="code-actions">
      ${editing ? `<button id="edit-cancel">Cancel</button><button class="primary" id="edit-save">Save changes</button><span class="muted">Saving re-runs screening. The original as received is kept unchanged.</span>`
      : `${canEdit ? `<button id="edit-start">${ico('pencil')} Edit e-script</button>` : ''}
      ${j.actions.includes('clinical_check') ? `<label class="verify"><input type="checkbox" id="src-verified" /> ${o?.kind === 'document' ? 'Read against the scanned original' : o?.kind === 'verbal' ? 'Verbal order confirmed with prescriber' : 'Checked against the original e-script'}${o?.compare?.some((c) => !c.match) ? ` <span class="tag warn">${o.compare.filter((c) => !c.match).length} change${o.compare.filter((c) => !c.match).length === 1 ? '' : 's'}</span>` : ''}</label>` : ''}
      ${j.actions.includes('release') ? `<select id="rel-method"><option value="pickup">Pickup in store</option><option value="delivery">Pharmacy delivery</option><option value="courier">Courier</option><option value="compliance_pack">Compliance pack</option></select><input id="rel-address" placeholder="Delivery address (defaults to patient's)" />` : ''}
      <span class="grow"></span>
      ${j.actions.filter((a) => a === 'hold' || a === 'cancel').map((a) => `<button data-act="${a}" class="${a === 'cancel' ? 'danger' : ''}">${ACTION_LABEL[a]}</button>`).join('')}
      ${j.owing ? '<button data-act="supply-owing">Supply owing</button>' : ''}
      ${nextStep(j) ? `<button class="primary submit" data-act="${nextStep(j).act}">Submit → ${esc(nextStep(j).label)}</button>` : !j.owing ? '<span class="muted">Nothing for your role at this stage.</span>' : ''}`}
    </div>`;

  if (railOpen && railTab === 'flow') renderFlowTimeline($('#job-flow'), { api, jobId: j.id, user: currentUser(), onChange: () => renderJobPane(j.id, { autoScreen: false }) });
  $('#print-worksheet')?.addEventListener('click', () => openPrint(`/api/print/jobs/${j.id}/worksheet`));
  $('#rescreen')?.addEventListener('click', guard(async () => { await api(`/api/jobs/${j.id}/screen`, { method: 'POST' }); await renderJobPane(j.id, { autoScreen: false }); }));
  $('#rail-toggle').onclick = () => { railOpen = !railOpen; renderJobPane(j.id, { autoScreen: false }); };
  document.querySelectorAll('[data-rail]').forEach((b) => (b.onclick = () => { railTab = b.dataset.rail; railOpen = true; renderJobPane(j.id, { autoScreen: false }); }));
  document.querySelectorAll('#job-pane [data-trace]').forEach((el) => (el.onclick = () => {
    const fid = el.dataset.trace;
    openTrace.has(fid) ? openTrace.delete(fid) : openTrace.add(fid);
    renderJobPane(j.id, { autoScreen: false });
  }));
  $('#edit-start')?.addEventListener('click', () => { editJobId = j.id; renderJobPane(j.id, { autoScreen: false }); });
  $('#edit-cancel')?.addEventListener('click', () => { editJobId = null; renderJobPane(j.id, { autoScreen: false }); });
  $('#edit-save')?.addEventListener('click', guard(async () => {
    const f = Object.fromEntries(new FormData($('#rx-form')));
    const body = { reason: f.reason };
    for (const k of ['directions', 'doseUnits', 'dosesPerDay', 'quantity', 'repeats', 'periodDays']) if (k in f) body[k] = k === 'directions' ? f[k] : (f[k] === '' ? null : Number(f[k]));
    await api(`/api/jobs/${j.id}/amend`, { method: 'POST', body });
    editJobId = null;
    toast('E-script updated and re-screened');
    render();
  }));
  document.querySelectorAll('#job-pane .decide').forEach((el) => el.addEventListener('click', (e) => e.stopPropagation()));
  document.querySelectorAll('#job-pane [data-act]').forEach((b) => (b.onclick = guard(() => doAction(j, b.dataset.act))));
}

function originalHtml(j, o) {
  if (!o) return '<div class="meta">No original stored.</div>';
  const kindLabel = { electronic: `E-script · ${esc(o.payloadRole)}`, document: 'Written script · scan attached at intake', verbal: 'Verbal order · no written original' }[o.kind];
  const integrity = o.intact && o.documents.every((d) => d.intact)
    ? `<span class="stag s-ok">${ico('shield')}<span>Unchanged since receipt</span></span>`
    : stag('hard_stop', 'Integrity check failed');
  const p = o.payload ?? {};
  const doc = o.kind === 'electronic' ? `
    <div class="rx-doc">
      <div class="rx-head"><b>E-prescription</b><span>${esc(p.prescribedAt ?? '')}</span></div>
      ${o.scid ? `<div class="rx-sec"><span>Script ID (SCID)</span><code class="rx-scid">${esc(o.scid)}</code></div>` : ''}
      <div class="rx-sec"><span>Prescriber</span>${esc(p.prescriber?.name ?? '')}<br/><small>CPN ${esc(p.prescriber?.cpn ?? '—')} · ${esc(p.prescriber?.facilityName ?? '')} ${p.prescriber?.facilityHpi ? `(${esc(p.prescriber.facilityHpi)})` : ''}</small></div>
      <div class="rx-sec"><span>Patient</span>${esc(p.patient?.name ?? '')}<br/><small>NHI ${esc(p.patient?.nhi ?? '—')} · DOB ${esc(p.patient?.dob ?? '—')}<br/>${esc(p.patient?.address ?? '')}</small></div>
      ${(p.items ?? []).map((it, i) => `<div class="rx-item ${String(it.itemRef ?? i + 1) === String(j.item_ref) ? 'cur' : ''}">
        <b>${esc(it.medicineCode)}</b> · qty ${esc(it.quantity)} · repeats ${esc(it.repeats ?? 0)}<br/><span>${esc(it.directions)}</span></div>`).join('')}
    </div>` : o.kind === 'document' ? o.documents.map((d) => d.mime === 'application/pdf'
      ? `<a class="pill" target="_blank" rel="noopener" href="/api/prescriptions/${j.prescription_id}/documents/${d.id}">Open original (PDF)</a>`
      : `<a target="_blank" rel="noopener" href="/api/prescriptions/${j.prescription_id}/documents/${d.id}"><img class="rx-scan" alt="Scan of the original script" src="/api/prescriptions/${j.prescription_id}/documents/${d.id}" /></a>`).join('')
    : '<div class="meta">Phone order: get written or electronic confirmation from the prescriber within the legal timeframe.</div>';
  return `
    <div class="meta">${kindLabel}</div>
    <div>${integrity}</div>
    <div class="meta mono-hash">received ${esc(o.receivedAt)} · sha256 ${esc((o.hash ?? '').slice(0, 16))}…</div>
    ${doc}
    ${o.kind !== 'electronic' ? '<div class="meta"><b>The scan above is the original.</b> Read it against the script lines on the left; the table below only compares what was keyed at intake with what is being dispensed.</div>' : ''}
    ${o.compare.length ? `<h4>${o.kind === 'electronic' ? 'Received vs dispensing' : 'Keyed at intake vs dispensing'}</h4>
      <table class="cmp"><tr><th></th><th>${o.kind === 'electronic' ? 'Received' : 'Keyed'}</th><th>Dispensing</th></tr>
      ${o.compare.map((c) => `<tr class="${c.match ? '' : 'diff'}"><td>${c.match ? '✓' : '≠'} ${esc(c.field)}</td><td>${esc(c.received)}</td><td>${esc(c.dispensing)}</td></tr>`).join('')}</table>`
      : ''}
    ${o.amendments.length ? `<h4>Changes to the script</h4>${o.amendments.map((a) => `<div class="meta">${esc(a.byName ?? '')}: ${Object.entries(a.changes).map(([k, v]) => `${esc(k)} ${esc(v.from)} → ${esc(v.to)}`).join('; ')}<br/>“${esc(a.reason)}”</div>`).join('')}` : ''}
    ${o.payload ? `<details class="raw"><summary>Raw message (${esc(o.payloadRole)})</summary><pre>${esc(JSON.stringify(o.payload, null, 2))}</pre></details>` : ''}`;
}

let editJobId = null;

const NEXT = {
  queued: ['enter', 'Confirm data entry'], entered: ['clinical_check', 'Clinical check'],
  clinically_checked: ['assemble', 'Assembled'], assembled: ['final_check', 'Final check'],
  checked: ['release', 'Release'], on_hold: ['resume', 'Resume'],
};
function nextStep(j) {
  const n = NEXT[j.state];
  return n && j.actions.includes(n[0]) ? { act: n[0], label: n[1] } : null;
}

/** Which e-script field each finding belongs on. */
function fieldFlags(findings) {
  const map = {};
  const put = (k, f) => (map[k] ??= []).push(f);
  for (const f of findings) {
    const subject = (f.id.split(':')[1] ?? '').toLowerCase();
    const c = f.code.replace(/^NZF_/, '');
    if (c === 'ALLERGY') { put('medicine', f); put('allergies', f); }
    else if (['DOSE_CEILING', 'DOSE', 'DOSE_UNSTRUCTURED'].includes(c)) { put('dose', f); put('directions', f); }
    else if (c.startsWith('RENAL')) { put('medicine', f); put('egfr', f); }
    else if (c === 'HEPATIC') put('medicine', f);
    else if (['INTERACTION', 'DUPLICATE', 'THERAPEUTIC_DUPLICATION'].includes(c)) {
      put('medicine', f);
      const other = f.trace?.inputs?.other?.ingredient ?? f.trace?.inputs?.with ?? subject;
      if (other) put(`med:${String(other).toLowerCase()}`, f);
    }
    else if (c === 'EARLY_REPEAT') put('repeats', f);
    else if (c === 'DURATION') { put('quantity', f); put('period', f); }
    else if (c === 'OLDER_ADULT_CNS') { put('medicine', f); put('age', f); }
    else if (['LASA', 'CONTROLLED'].includes(c)) put('medicine', f);
    else if (c === 'LANGUAGE') put('patient', f);
  }
  return map;
}

function shortFlag(f) {
  const c = f.code.replace(/^NZF_/, '');
  return ({ ALLERGY: 'Allergy', DOSE_CEILING: 'Over max dose', DOSE: 'Over max dose', DOSE_UNSTRUCTURED: 'Check dose', RENAL_AVOID: 'Renal: avoid', RENAL_ADJUST: 'Renal dose', RENAL: 'Renal', HEPATIC: 'Hepatic', INTERACTION: 'Interaction', DUPLICATE: 'Duplicate', THERAPEUTIC_DUPLICATION: 'Same class', EARLY_REPEAT: 'Early repeat', DURATION: 'Long course', OLDER_ADULT_CNS: 'Falls risk', LASA: 'Look-alike', CONTROLLED: 'Controlled' })[c] ?? c.toLowerCase().replace(/_/g, ' ');
}

function flagListHtml(findings, decisions, editable) {
  const shown = findings.filter((f) => f.code !== 'AI_STATUS' || f.message);
  if (!shown.length) return '<div class="rx-empty">No flags.</div>';
  return shown.map((f) => {
    const d = decisions[f.id];
    const sev = d ? 'ok' : f.severity;
    const decide = editable && f.severity === 'hard_stop'
      ? `<div class="decide" data-fid="${esc(f.id)}" data-kind="override"><input type="text" placeholder="Override reason (required)" data-reason /><label><input type="checkbox" data-prescriber /> Prescriber contacted</label></div>`
      : editable && f.severity === 'high'
        ? `<div class="decide" data-fid="${esc(f.id)}" data-kind="ack"><label><input type="checkbox" data-ack /> Reviewed</label><input type="text" placeholder="Note (optional)" data-note /></div>`
        : d ? `<div class="rx-decision">${ico('check')} ${esc(d.action === 'override' ? 'Overridden' : 'Reviewed')}${d.reason || d.note ? `: ${esc(d.reason ?? d.note)}` : ''}${d.prescriberConfirmed ? ' · prescriber contacted' : ''}</div>` : '';
    return `<div class="rx-flag sev-${sev}" id="flag-${esc(f.id)}">
      <div class="rx-flag-head">${stag(d ? 'ok' : f.severity, d ? 'Resolved' : SEV_LABEL[f.severity])}
        <span class="rx-origin">${f.origin === 'ai' ? 'AI reviewer' : f.origin === 'formulary' ? 'Formulary' : 'Rule'} · ${esc(SPECIALIST[f.specialist] ?? f.specialist)}</span>
        <button type="button" class="rx-why ${openTrace.has(f.id) ? 'open' : ''}" data-trace="${esc(f.id)}" aria-expanded="${openTrace.has(f.id)}">Details ${ico('chevron')}</button></div>
      <div class="rx-flag-msg">${esc(f.message)}</div>
      ${openTrace.has(f.id) ? `<div class="rx-trace"><b>Rule</b> ${esc(f.trace?.rule ?? '')}<br/><b>Source</b> ${esc(f.trace?.source ?? '')}${f.trace?.link ? ` · <a href="${esc(f.trace.link)}" target="_blank" rel="noopener">reference</a>` : ''}<br/><b>Inputs</b> <code>${esc(typeof f.trace?.inputs === 'string' ? f.trace.inputs : JSON.stringify(f.trace?.inputs))}</code></div>` : ''}
      ${decide}
    </div>`;
  }).join('');
}

function collectDecisions() {
  const decisions = {};
  document.querySelectorAll('#job-pane .decide').forEach((el) => {
    if (el.dataset.kind === 'override') {
      const reason = el.querySelector('[data-reason]').value.trim();
      if (reason) decisions[el.dataset.fid] = { action: 'override', reason, prescriberConfirmed: el.querySelector('[data-prescriber]').checked };
    } else if (el.querySelector('[data-ack]').checked) {
      decisions[el.dataset.fid] = { action: 'acknowledge', note: el.querySelector('[data-note]').value.trim() || null };
    }
  });
  return decisions;
}

async function doAction(j, act) {
  const body = {};
  if (act === 'hold' || act === 'cancel') {
    body.reason = prompt(`Reason to ${act}?`);
    if (!body.reason) return;
  }
  if (act === 'clinical_check') {
    body.decisions = collectDecisions();
    body.sourceVerified = !!$('#src-verified')?.checked;
  }

  if (act === 'release') {
    body.method = $('#rel-method').value;
    body.address = $('#rel-address').value || undefined;
  }
  if (act === 'supply-owing') await api(`/api/jobs/${j.id}/supply-owing`, { method: 'POST' });
  else await api(`/api/jobs/${j.id}/${act.replace(/_/g, '-')}`, { method: 'POST', body });
  toast(`${ACTION_LABEL[act] ?? act}: done`);
  if (act === 'release' || act === 'cancel') selectedJobId = null;
  render();
}

// ───────────── intake ─────────────
async function renderIntake() {
  const demos = await api('/api/demo/escripts');
  $('#demo-scripts').innerHTML = demos.map((d) => `<li><div><code>${esc(d.scid)}</code><br/><span class="muted">${esc(d.patient)} · ${d.items.map(esc).join(', ')}</span></div><button data-scid="${esc(d.scid)}">Use</button></li>`).join('');
  document.querySelectorAll('#demo-scripts [data-scid]').forEach((b) => (b.onclick = () => { $('#scid-input').value = b.dataset.scid; onScidInput(); }));
}

async function onScidInput() {
  const v = $('#scid-input').value.trim();
  if (!v) return ($('#scid-status').textContent = '');
  const r = await api(`/api/scid/validate?scid=${encodeURIComponent(v)}`);
  $('#scid-status').innerHTML = r.valid ? `<span class="tag ok">Valid SCID</span> <code>${esc(r.scid)}</code>` : `<span class="tag danger">${esc(r.error)}</span>`;
}

async function onScidSubmit(e) {
  e.preventDefault();
  try {
    const rx = await api('/api/intake/nzeps', { method: 'POST', body: { scid: $('#scid-input').value } });
    toast(`Received script for ${rx.patient_name}: ${rx.items.length} item(s) queued`);
    $('#scid-input').value = '';
    $('#scid-status').textContent = '';
    renderIntake();
  } catch (err) {
    if (/BUS002/.test(err.message)) $('#scid-status').innerHTML = `<span class="tag danger">Not on NZePS</span> Dispense from the paper copy using the manual form →`;
    throw err;
  }
}

async function onManualSubmit(e) {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const file = e.target.querySelector('[name=document]').files[0];
  const document = file ? { filename: file.name, dataBase64: await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); }) } : undefined;
  const rx = await api('/api/intake/manual', {
    method: 'POST',
    body: {
      source: f.source,
      document,
      externalId: f.externalId || undefined,
      patient: { nhi: f.nhi || undefined, name: f.pname, dob: f.dob || undefined, address: f.address || undefined },
      prescriber: { cpn: f.cpn || undefined, name: f.dname },
      items: [{ medicineCode: f.medicineCode, quantity: Number(f.quantity), repeats: Number(f.repeats || 0), directions: f.directions }],
    },
  });
  toast(`Script for ${rx.patient_name} added to queue`);
  e.target.reset();
}

// ───────────── prescriptions ─────────────
async function renderPrescriptions() {
  const q = $('#rx-search').value;
  const rows = await api(`/api/prescriptions${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#rx-table').innerHTML = `<tr><th>#</th><th>Patient</th><th>Prescriber</th><th>Source</th><th>Items</th><th>Status</th></tr>` +
    rows.map((r) => `<tr class="click" data-id="${r.id}"><td>${r.id}</td><td>${esc(r.patient_name)} <span class="muted">${esc(r.nhi ?? '')}</span></td><td>${esc(r.prescriber_name)}</td><td>${esc(r.source)}${r.scid ? `<br/><code>${esc(r.scid)}</code>` : ''}</td><td>${r.item_count}</td><td>${statusTag(r.status)}</td></tr>`).join('');
  document.querySelectorAll('#rx-table tr.click').forEach((tr) => (tr.onclick = guard(() => showRx(tr.dataset.id))));
}

async function showRx(id) {
  const rx = await api(`/api/prescriptions/${id}`);
  $('#rx-detail').innerHTML = `<div class="card"><h2>Script #${rx.id} — ${esc(rx.patient_name)}</h2>
    <p class="muted">${esc(rx.prescriber_name)}${rx.facility_name ? `, ${esc(rx.facility_name)}` : ''} · prescribed ${esc(rx.prescribed_at)}</p>
    <table><tr><th>Medicine</th><th>Directions</th><th>Qty</th><th>Supplies</th><th>Jobs</th><th></th></tr>
    ${rx.items.map((i) => `<tr><td>${esc(i.medicine)} ${esc(i.strength)} ${i.controlled_class ? `<span class="tag cd">CD ${i.controlled_class}</span>` : ''}</td><td>${esc(i.directions)}</td><td>${i.quantity}</td>
      <td>${i.dispensings_count} / ${i.repeats_authorised + 1}</td>
      <td>${i.jobs.map((j) => `<span class="tag">${j.sequence === 0 ? 'Orig' : 'R' + j.sequence}: ${esc(j.state)}</span>`).join(' ')}</td>
      <td>${i.status === 'active' ? `<button data-item="${i.id}">Dispense repeat</button>` : statusTag(i.status)}</td></tr>`).join('')}</table></div>`;
  document.querySelectorAll('#rx-detail [data-item]').forEach((b) => (b.onclick = guard(async () => {
    await api(`/api/items/${b.dataset.item}/repeat`, { method: 'POST' });
    toast('Repeat added to the queue');
    showRx(id);
  })));
}

const statusTag = (s) => `<span class="tag ${['completed', 'accepted'].includes(s) ? 'ok' : ['cancelled', 'rejected', 'failed'].includes(s) ? 'danger' : ''}">${esc(s)}</span>`;

// ───────────── fulfilment ─────────────
async function renderFulfilment() {
  const list = await api('/api/fulfilments');
  $('#fulfilment-list').innerHTML = list.map((f) => {
    const acts = [];
    if (f.status === 'open' && ['delivery', 'courier'].includes(f.method)) acts.push(['dispatch', 'Dispatch']);
    if ((f.status === 'open' && ['pickup', 'compliance_pack'].includes(f.method)) || f.status === 'out_for_delivery') acts.push(['complete', f.method === 'pickup' ? 'Collected' : 'Delivered']);
    if (f.status === 'out_for_delivery') acts.push(['fail', 'Failed delivery']);
    if (f.status === 'failed') acts.push(['retry', 'Retry']);
    return `<div class="card"><div class="row space"><b>${esc(f.patient_name)}</b>${statusTag(f.status)}</div>
      <div class="muted">${esc(f.method.replace('_', ' '))}${f.address ? ` · ${esc(f.address)}` : ''}${f.tracking_ref ? ` · ${esc(f.provider)} <code>${esc(f.tracking_ref)}</code>` : ''}${f.pickup_code && f.method === 'pickup' ? ` · pickup code <code>${esc(f.pickup_code)}</code>` : ''}</div>
      <ul class="list" style="margin-top:8px">${f.jobs.map((j) => `<li><span>${esc(j.medicine)} ${esc(j.strength)} ×${j.quantity_supplied}${j.controlled_class ? ' <span class="tag cd">CD</span>' : ''}${j.owing ? ` <span class="tag warn">owing ${j.owing}</span>` : ''}</span><span class="tag">${esc(j.state)}</span></li>`).join('')}</ul>
      ${f.proof ? `<p class="muted">${esc(f.proof)}</p>` : ''}
      <div class="actions"><button data-print-label="${f.id}">${ico('print')} ${['pickup', 'compliance_pack'].includes(f.method) ? 'Bag label' : 'Shipping label'}</button>${f.ready || f.status !== 'open' ? acts.map(([a, l]) => `<button class="primary" data-f="${f.id}" data-a="${a}" data-cd="${f.hasControlled}">${l}</button>`).join('') : '<span class="muted">Waiting for remaining items…</span>'}</div></div>`;
  }).join('') || '<p class="muted">Nothing released yet.</p>';
  document.querySelectorAll('[data-print-label]').forEach((b) => (b.onclick = () => openPrint(`/api/print/fulfilments/${b.dataset.printLabel}/label`)));
  document.querySelectorAll('[data-f]').forEach((b) => (b.onclick = guard(async () => {
    const body = {};
    if (b.dataset.a === 'complete') {
      body.proof = prompt(b.dataset.cd === 'true' ? 'Controlled drug — who collected/received it, and ID checked?' : 'Proof / note (optional)') || undefined;
      if (b.dataset.cd === 'true' && !body.proof) return;
    }
    if (b.dataset.a === 'fail') { body.reason = prompt('Why did delivery fail?'); if (!body.reason) return; }
    await api(`/api/fulfilments/${b.dataset.f}/${b.dataset.a}`, { method: 'POST', body });
    toast('Updated');
    renderFulfilment();
  })));
}

// ───────────── stock / CD ─────────────
async function renderStock() {
  const [meds, cd] = await Promise.all([api('/api/medicines'), api('/api/cd-register')]);
  $('#stock-table').innerHTML = '<tr><th>Medicine</th><th>On hand</th><th>Pack</th><th></th></tr>' +
    meds.map((m) => `<tr><td>${esc(m.name)} ${esc(m.strength)} ${m.controlled_class ? `<span class="tag cd">CD ${m.controlled_class}</span>` : ''}</td><td>${m.on_hand < m.pack_size ? `<span class="tag warn">${m.on_hand}</span>` : m.on_hand}</td><td>${m.pack_size}</td><td><button data-med="${m.id}">Receive / adjust</button></td></tr>`).join('');
  document.querySelectorAll('[data-med]').forEach((b) => (b.onclick = guard(async () => {
    const delta = Number(prompt('Quantity change (+ received, − removed):'));
    if (!delta) return;
    const reason = prompt('Reason (e.g. wholesaler invoice #, stocktake):') || 'Stock adjustment';
    await api(`/api/medicines/${b.dataset.med}/stock`, { method: 'POST', body: { delta, reason } });
    toast('Stock updated');
    renderStock();
  })));
  const [reorder, ledger] = await Promise.all([api('/api/stock/reorder'), api('/api/stock/ledger')]);
  $('#reorder-table').innerHTML = '<tr><th>Product</th><th>On hand</th><th>Used 30d</th><th>Order</th></tr>' +
    (reorder.lines.map((l) => `<tr><td>${esc(l.name)}${l.controlled ? ' <span class="tag cd">CD</span>' : ''}</td><td>${l.onHand}</td><td>${l.used30}</td><td><b>${l.packs} × ${l.packSize}</b> = ${l.units}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing below its reorder point.</td></tr>');
  $('#ledger-table').innerHTML = '<tr><th>When</th><th>Product</th><th>Change</th><th>Balance</th><th>Kind</th></tr>' +
    ledger.slice(0, 60).map((l) => `<tr><td class="mono">${esc(l.at)}</td><td>${esc(l.medicine)} ${esc(l.strength)}</td><td>${l.change > 0 ? '+' : ''}${l.change}</td><td>${l.balance}</td><td><span class="tag">${esc(l.kind)}</span></td></tr>`).join('');
  $('#cd-table').innerHTML = '<tr><th>When</th><th>Medicine</th><th>Change</th><th>Balance</th><th>Reason</th><th>By</th></tr>' +
    cd.map((c) => `<tr><td class="mono">${esc(c.at)}</td><td>${esc(c.medicine)} ${esc(c.strength)}</td><td>${c.change > 0 ? '+' : ''}${c.change}</td><td><b>${c.balance}</b></td><td>${esc(c.reason)}</td><td>${esc(c.user_name ?? '—')}</td></tr>`).join('');
}

// ───────────── claims / audit ─────────────
async function renderClaims() {
  const rows = await api('/api/claims');
  $('#claims-table').innerHTML = '<tr><th>#</th><th>Job</th><th>NHI</th><th>Medicine</th><th>Qty</th><th>Subsidy</th><th>Patient charge</th><th>Status</th><th>Batch</th></tr>' +
    rows.map((c) => `<tr><td>${c.id}</td><td>${c.job_id}</td><td>${esc(c.patient_nhi ?? '—')}</td><td>${esc(c.medicine_code)}</td><td>${c.quantity}</td><td>${money(c.subsidy_cents)}</td><td>${money(c.patient_charge_cents)}</td><td>${statusTag(c.status)}${c.response ? ` <span class="muted">${esc(c.response)}</span>` : ''}</td><td class="mono">${esc(c.batch_ref ?? '')}</td></tr>`).join('');
}

async function renderAudit() {
  const [rows, v] = await Promise.all([api('/api/audit'), api('/api/audit/verify')]);
  $('#audit-verify').innerHTML = v.ok ? `<span class="tag ok">Chain intact · ${v.checked} entries</span>` : `<span class="tag danger">Chain broken at #${v.brokenAt}</span>`;
  $('#audit-table').innerHTML = '<tr><th>#</th><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr>' +
    rows.map((r) => `<tr><td>${r.id}</td><td class="mono">${esc(r.at.replace('T', ' ').slice(0, 19))}</td><td>${esc(r.user_name ?? '—')}</td><td><code>${esc(r.action)}</code></td><td>${esc(r.entity)} ${r.entity_id ?? ''}</td><td class="mono">${esc(JSON.stringify(r.data))}</td></tr>`).join('');
}

// ───────────── counter ─────────────
let saleId = null;

async function renderCounter() {
  $('#new-sale').onclick = guard(async () => { saleId = (await api('/api/counter/sales', { method: 'POST', body: {} })).id; renderCounter(); });
  $('#pickup-form').onsubmit = guard(async (e) => {
    e.preventDefault();
    if (!saleId) saleId = (await api('/api/counter/sales', { method: 'POST', body: {} })).id;
    await api(`/api/counter/sales/${saleId}/pickup`, { method: 'POST', body: { code: $('#pickup-code').value } });
    $('#pickup-code').value = '';
    renderCounter();
  });
  const [products, sales, eod] = await Promise.all([api('/api/counter/products'), api('/api/counter/sales'), api('/api/counter/end-of-day')]);
  $('#otc-list').innerHTML = products.map((m) => `<li><span>${esc(m.name)} <span class="muted">${esc(m.strength)} · ${m.on_hand} in stock</span></span><span>${money(m.price_cents)} <button data-otc="${m.id}">Add</button></span></li>`).join('');
  document.querySelectorAll('[data-otc]').forEach((b) => (b.onclick = guard(async () => {
    if (!saleId) saleId = (await api('/api/counter/sales', { method: 'POST', body: {} })).id;
    await api(`/api/counter/sales/${saleId}/lines`, { method: 'POST', body: { kind: 'otc', medicineId: Number(b.dataset.otc), quantity: 1 } });
    renderCounter();
  })));

  if (saleId) {
    const sale = await api(`/api/counter/sales/${saleId}`);
    const open = sale.status === 'open';
    $('#sale-box').innerHTML = `<p>${sale.patient_name ? esc(sale.patient_name) : '<span class="muted">Walk-in</span>'} · ${statusTag(sale.status)}</p>
      <table>${sale.lines.map((l) => `<tr><td>${l.kind === 'rx' ? '<span class="tag">Rx</span>' : ''}${esc(l.description)}${l.refunded ? ' <span class="tag danger">refunded</span>' : ''}</td><td>×${l.quantity}</td><td>${money(l.unit_cents * l.quantity)}</td><td>${open ? `<button data-rm="${l.id}">✕</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">Empty</td></tr>'}</table>
      <p class="total">${money(sale.total_cents)} <span class="muted" style="font-size:12px;font-weight:400">incl. GST ${money(sale.gst_cents)}</span></p>
      <div class="actions">${open ? `<button class="primary" data-pay="card">Card</button><button data-pay="cash">Cash</button>` : ''}${['paid', 'partially_refunded'].includes(sale.status) ? '<button class="danger" id="refund">Refund</button>' : ''}</div>`;
    document.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => { await api(`/api/counter/sales/${saleId}/lines/${b.dataset.rm}/remove`, { method: 'POST' }); renderCounter(); })));
    document.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = guard(async () => {
      const body = { method: b.dataset.pay };
      if (sale.has_controlled) { body.proof = prompt('Controlled drug: who collected it, and what ID was checked?'); if (!body.proof) return; }
      const r = await api(`/api/counter/sales/${saleId}/pay`, { method: 'POST', body });
      toast(`Paid ${money(r.total_cents)} (${r.payment_ref})${r.notes?.length ? ' · ' + r.notes.join('; ') : ''}`);
      renderCounter();
    })));
    $('#refund')?.addEventListener('click', guard(async () => {
      const reason = prompt('Refund reason?'); if (!reason) return;
      await api(`/api/counter/sales/${saleId}/refund`, { method: 'POST', body: { reason } });
      toast('Refunded. Over-the-counter items were restocked; prescription medicines were not.');
      renderCounter();
    }));
  } else $('#sale-box').innerHTML = '<span class="muted">Start a basket, scan a pickup code, or add an over-the-counter item.</span>';

  $('#eod').innerHTML = `<table>
    <tr><td>Transactions</td><td>${eod.transactions}</td></tr><tr><td>Prescription</td><td>${money(eod.rxCents)}</td></tr>
    <tr><td>Over the counter</td><td>${money(eod.otcCents)}</td></tr><tr><td>Refunds</td><td>−${money(eod.refundsCents)}</td></tr>
    <tr><td><b>Net</b></td><td><b>${money(eod.netCents)}</b></td></tr><tr><td>GST included</td><td>${money(eod.gstCents)}</td></tr>
    ${Object.entries(eod.byMethod).map(([m, c]) => `<tr><td class="muted">${esc(m)}</td><td class="muted">${money(c)}</td></tr>`).join('')}</table>`;
  $('#sales-table').innerHTML = '<tr><th>#</th><th>Customer</th><th>Total</th><th>Status</th></tr>' +
    sales.slice(0, 20).map((x) => `<tr class="click" data-sale="${x.id}"><td>${x.id}</td><td>${esc(x.patient_name ?? 'Walk-in')}</td><td>${money(x.total_cents)}</td><td>${statusTag(x.status)}</td></tr>`).join('');
  document.querySelectorAll('[data-sale]').forEach((tr) => (tr.onclick = () => { saleId = Number(tr.dataset.sale); renderCounter(); }));
}

async function renderSafety() {
  const rows = await api('/api/screening/overrides');
  $('#overrides-table').innerHTML = '<tr><th>When</th><th>Pharmacist</th><th>Patient</th><th>Medicine</th><th>Finding</th><th>Decision</th></tr>' +
    (rows.map((r) => `<tr><td class="mono">${esc(r.at)}</td><td>${esc(r.pharmacist)}</td><td>${esc(r.patient)}</td><td>${esc(r.medicine)}</td>
      <td>${stag(r.severity, SEV_LABEL[r.severity])} <span class="muted">${r.origin === 'ai' ? 'AI reviewer' : r.origin === 'formulary' ? 'Formulary' : 'Rule'}</span><div>${esc(r.message)}</div></td>
      <td><b>${esc(r.action)}</b>${r.reason ? `: ${esc(r.reason)}` : ''}${r.prescriberConfirmed ? '<br/><span class="muted">prescriber contacted</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No overrides yet.</td></tr>');
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => guard(fn)(...a), ms); }; }

boot().catch((e) => toast(e.message, true));
