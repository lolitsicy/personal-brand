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

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  render();
}

function render() {
  guard(updateNavCount)();
  return guard(({ home: renderHome, queue: renderQueue, intake: renderIntake, prescriptions: renderPrescriptions, counter: renderCounter, fulfilment: renderFulfilment, stock: renderStock, claims: renderClaims, safety: renderSafety, audit: renderAudit })[currentTab])();
}

// ───────────── home ─────────────
async function updateNavCount() {
  const d = await api('/api/dashboard');
  const n = ['queued', 'entered', 'clinically_checked', 'assembled', 'checked'].reduce((t, k) => t + (d.jobs[k] ?? 0), 0);
  $('#nav-queue-count').textContent = n || '';
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

// ───────────── queue ─────────────
async function renderQueue() {
  const [jobs, dash] = await Promise.all([api('/api/queue'), api('/api/dashboard')]);
  const s = dash.jobs;
  $('#stats').innerHTML = [
    ['In progress', (s.queued ?? 0) + (s.entered ?? 0) + (s.clinically_checked ?? 0) + (s.assembled ?? 0) + (s.checked ?? 0)],
    ['Awaiting collection / delivery', s.released ?? 0],
    ['Owings', dash.owing],
    ['Claims pending', dash.claims.pending ?? 0],
    ['Low stock lines', dash.lowStock.length],
  ].map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');

  $('#board').innerHTML = COLUMNS.map(([state, title]) => {
    const col = jobs.filter((j) => j.state === state);
    return `<div class="col"><h4>${title}<span>${col.length}</span></h4>${col.map(jobCard).join('') || '<div class="muted" style="padding:4px">—</div>'}</div>`;
  }).join('');
  document.querySelectorAll('.job').forEach((el) => (el.onclick = () => openJob(el.dataset.id)));
}

function jobCard(j) {
  return `<div class="job" data-id="${j.id}">
    <div class="med">${esc(j.medicine)} ${esc(j.strength)}</div>
    <div>${esc(j.patient_name)} <span class="meta">${esc(j.nhi ?? '')}</span></div>
    <div class="meta">Qty ${j.quantity} · ${j.sequence === 0 ? 'Original' : `Repeat ${j.sequence}`} · ${esc(j.source)}</div>
    <div>${j.controlled_class ? `<span class="tag cd">CD ${j.controlled_class}</span>` : ''}${j.owing ? `<span class="tag warn">Owing ${j.owing}</span>` : ''}${j.hold_reason && j.state === 'on_hold' ? `<span class="tag warn">${esc(j.hold_reason)}</span>` : ''}</div>
  </div>`;
}

const SPECIALIST = { pharma: 'Medication review', pharmacology: 'Clinical pharmacology', regulatory: 'Regulatory', advocacy: 'Patient advocacy' };
const LANG = { en: 'English', mi: 'te reo Māori', sm: 'Samoan', to: 'Tongan', zh: 'Chinese', hi: 'Hindi' };
const SEV_LABEL = { hard_stop: 'HARD STOP', high: 'High', moderate: 'Check', info: 'Info' };

function findingsHtml(findings, { editable, decisions = {} }) {
  if (!findings.length) return '<p class="muted">No findings.</p>';
  const groups = {};
  for (const f of findings) (groups[f.specialist] ??= []).push(f);
  return Object.entries(groups).map(([spec, list]) => `<div class="spec">${SPECIALIST[spec] ?? spec}</div>` + list.map((f) => {
    const d = decisions[f.id];
    const decide = !editable ? (d ? `<div class="muted">↳ ${esc(d.action)}${d.reason ? `: ${esc(d.reason)}` : d.note ? `: ${esc(d.note)}` : ''}${d.prescriberConfirmed ? ' · prescriber contacted' : ''}</div>` : '')
      : f.severity === 'hard_stop' ? `<div class="decide" data-fid="${esc(f.id)}" data-kind="override"><input type="text" placeholder="Override reason (required)" data-reason /><label><input type="checkbox" data-prescriber /> Prescriber contacted</label></div>`
      : f.severity === 'high' ? `<div class="decide" data-fid="${esc(f.id)}" data-kind="ack"><label><input type="checkbox" data-ack /> Reviewed</label><input type="text" placeholder="Note (optional)" data-note /></div>` : '';
    return `<div class="finding ${f.severity}"><div class="head"><span class="sev ${f.severity}">${SEV_LABEL[f.severity]}</span>${f.origin === 'ai' ? '<span class="tag">AI</span>' : '<span class="tag">Rule</span>'}<span>${esc(f.message)}</span></div>
      <details><summary>Reasoning trace</summary><pre>${esc(`Rule: ${f.trace?.rule ?? ''}\nSource: ${f.trace?.source ?? ''}\nInputs: ${typeof f.trace?.inputs === 'string' ? f.trace.inputs : JSON.stringify(f.trace?.inputs, null, 1)}`)}</pre></details>${decide}</div>`;
  }).join('')).join('');
}

function collectDecisions() {
  const decisions = {};
  document.querySelectorAll('#job-detail .decide').forEach((el) => {
    if (el.dataset.kind === 'override') {
      const reason = el.querySelector('[data-reason]').value.trim();
      if (reason) decisions[el.dataset.fid] = { action: 'override', reason, prescriberConfirmed: el.querySelector('[data-prescriber]').checked };
    } else if (el.querySelector('[data-ack]').checked) {
      decisions[el.dataset.fid] = { action: 'acknowledge', note: el.querySelector('[data-note]').value.trim() || null };
    }
  });
  return decisions;
}

async function openJob(id, { autoScreen = true } = {}) {
  let j = await api(`/api/jobs/${id}`);
  if (autoScreen && j.state === 'entered' && (!j.screening || j.screening.status !== 'pending')) {
    await api(`/api/jobs/${id}/screen`, { method: 'POST' }).catch(() => {});
    j = await api(`/api/jobs/${id}`);
  }
  const dlg = $('#job-detail').closest('dialog');
  const signedOff = j.warnings_acknowledged;
  const findings = j.warnings ?? signedOff?.warnings ?? [];
  const editable = j.actions.includes('clinical_check');
  $('#job-detail').innerHTML = `
    <div class="row space"><h2>${esc(j.medicine)} ${esc(j.strength)} ${esc(j.form)}</h2><button id="close-dlg">✕</button></div>
    <p>${esc(j.patient_name)} · NHI ${esc(j.nhi ?? '—')} · ${esc(j.prescriber_name)}<br/>
      <span class="muted">${j.scid ? `SCID <code>${esc(j.scid)}</code> · ` : ''}${esc(j.source)} · ${j.sequence === 0 ? 'Original supply' : `Repeat ${j.sequence}`} of ${j.repeats_authorised + 1} · state <b>${esc(j.state)}</b></span></p>
    <p><b>Directions:</b> ${esc(j.directions)}<br/><b>Quantity:</b> ${j.quantity} ${j.quantity_supplied ? `(supplied ${j.quantity_supplied}${j.owing ? `, owing ${j.owing}` : ''})` : ''} · <span class="muted">on hand ${j.on_hand}</span></p>
    <div class="row space"><h3>Clinical screening ${j.screening ? `<span class="muted" style="text-transform:none">· ${esc(j.screening.reviewer)} · ${esc(j.screening.status)}</span>` : ''}</h3>
      ${['queued', 'entered'].includes(j.state) ? '<button id="rescreen">Re-run screening</button>' : ''}</div>
    ${findingsHtml(findings, { editable, decisions: signedOff?.decisions ?? {} })}
    ${j.screening?.counselling ? `<h3>Counselling draft (${esc(LANG[j.screening.counselling.language] ?? j.screening.counselling.language)})</h3><div class="counsel">${esc(j.screening.counselling.text)}</div>` : ''}
    ${j.label_text ? `<h3>Label</h3><pre class="label">${esc(j.label_text)}</pre>` : ''}
    <div id="release-opts" style="display:${j.actions.includes('release') ? 'block' : 'none'}">
      <h3>Fulfilment</h3>
      <div class="row"><select id="rel-method"><option value="pickup">Pickup in store</option><option value="delivery">Pharmacy delivery</option><option value="courier">Courier</option><option value="compliance_pack">Compliance pack</option></select>
      <input id="rel-address" placeholder="Delivery address (defaults to patient address)" /></div>
    </div>
    <div class="actions">
      ${j.actions.map((a) => `<button data-act="${a}" class="${a === 'cancel' ? 'danger' : ['hold'].includes(a) ? '' : 'primary'}">${ACTION_LABEL[a] ?? a}</button>`).join('')}
      ${j.owing ? '<button data-act="supply-owing">Supply owing</button>' : ''}
      ${!j.actions.length && !j.owing ? '<span class="muted">No actions available for your role in this state.</span>' : ''}
    </div>`;
  $('#close-dlg').onclick = () => dlg.close();
  $('#rescreen')?.addEventListener('click', guard(async () => { await api(`/api/jobs/${j.id}/screen`, { method: 'POST' }); await openJob(j.id, { autoScreen: false }); }));
  document.querySelectorAll('#job-detail [data-act]').forEach((b) => (b.onclick = guard(() => doAction(j, b.dataset.act))));
  if (!dlg.open) dlg.showModal();
}

async function doAction(j, act) {
  const body = {};
  if (act === 'hold' || act === 'cancel') {
    body.reason = prompt(`Reason to ${act}?`);
    if (!body.reason) return;
  }
  if (act === 'clinical_check') body.decisions = collectDecisions();
  if (act === 'release') {
    body.method = $('#rel-method').value;
    body.address = $('#rel-address').value || undefined;
  }
  try {
    if (act === 'supply-owing') await api(`/api/jobs/${j.id}/supply-owing`, { method: 'POST' });
    else await api(`/api/jobs/${j.id}/${act.replace(/_/g, '-')}`, { method: 'POST', body });
  } catch (e) {
    throw e;
  }
  toast(`${ACTION_LABEL[act] ?? act}: done`);
  if (act === 'release' || act === 'cancel') $('#job-dialog').close();
  else await openJob(j.id, { autoScreen: false });
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
  const rx = await api('/api/intake/manual', {
    method: 'POST',
    body: {
      source: f.source,
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
      <div class="actions">${f.ready || f.status !== 'open' ? acts.map(([a, l]) => `<button class="primary" data-f="${f.id}" data-a="${a}" data-cd="${f.hasControlled}">${l}</button>`).join('') : '<span class="muted">Waiting for remaining items…</span>'}</div></div>`;
  }).join('') || '<p class="muted">Nothing released yet.</p>';
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
      <td><span class="sev ${r.severity}">${SEV_LABEL[r.severity]}</span> <span class="tag">${r.origin === 'ai' ? 'AI' : 'Rule'}</span> ${esc(r.message)}</td>
      <td><b>${esc(r.action)}</b>${r.reason ? `: ${esc(r.reason)}` : ''}${r.prescriberConfirmed ? '<br/><span class="muted">prescriber contacted</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No overrides yet.</td></tr>');
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => guard(fn)(...a), ms); }; }

boot().catch((e) => toast(e.message, true));
