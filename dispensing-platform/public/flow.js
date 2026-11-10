// Pharmacy flow UI: the pipeline designer (flows tab) and the per-job flow
// timeline (job pane). Vanilla ES module, no dependencies. Codes strictly
// against docs/flow-contract.md: the server owns validation and guardrails;
// this module only renders, edits a draft and asks the server.
//
//   renderFlowDesigner(container, { api, toast, user }) -> { reload, getDraft }
//   renderFlowTimeline(container, { api, jobId, user?, layout?, onChange? }) -> Promise<{ refresh }>
//
// `api(path, { method, body })` resolves to JSON and throws an Error carrying
// `.status` and `.details` on non-2xx (same helper as public/app.js).

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export const SOURCES = [
  ['nzeps', 'NZePS'],
  ['paper', 'Paper'],
  ['signature_exempt', 'Signature exempt'],
  ['fax', 'Fax'],
  ['phone', 'Phone'],
];
const SOURCE_LABEL = Object.fromEntries(SOURCES);
/** Who performs each human checkpoint (mirrors the roles in src/domain/workflow.js). */
const HUMAN_ROLE = { clinical_check: 'Pharmacist', final_check: 'Pharmacist', data_entry: 'Technician', assemble: 'Technician', handover: 'Technician' };
const EDIT_ROLES = ['pharmacist', 'admin'];

const svg = (body, cls = '') => `<svg class="fi ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/><circle cx="12" cy="12" r="6.2"/>'),
  person: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.2c.9-3.8 3.7-5.9 7.2-5.9s6.3 2.1 7.2 5.9"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', 'lock'),
  up: svg('<path d="M6 14l6-6 6 6"/>'),
  down: svg('<path d="M6 10l6 6 6-6"/>'),
  trash: svg('<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 'chev'),
  grip: svg('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>', 'grip'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cross: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  skip: svg('<path d="M6 12h12"/>'),
  clock: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>'),
  retry: svg('<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4.5V9h-4.5"/>'),
  alert: svg('<path d="M12 3.5 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
  flow: svg('<rect x="4" y="3.5" width="7" height="5" rx="1.5"/><rect x="13" y="15.5" width="7" height="5" rx="1.5"/><path d="M7.5 8.5v4.5a2 2 0 0 0 2 2h3.5"/>'),
};

const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Steps an error message mentions: by id or type (whole token, any case), by
 * catalogue label (whole phrase, exact case, e.g. "Clinical check is required…"),
 * or by position ("Step 3 …").
 */
function stepsMentioned(message, steps, labelOf = () => null) {
  const msg = String(message ?? '');
  const token = (term) => term && new RegExp(`(^|[^a-z0-9_-])${reEsc(term)}([^a-z0-9_-]|$)`, 'i').test(msg);
  const phrase = (term) => term && new RegExp(`(^|[^A-Za-z0-9_-])${reEsc(term)}([^A-Za-z0-9_-]|$)`).test(msg);
  const pos = [...msg.matchAll(/\bStep (\d+)\b/g)].map((m) => Number(m[1]) - 1);
  return steps.filter((st, i) => token(st.id) || token(st.type) || phrase(labelOf(st.type)) || pos.includes(i)).map((st) => st.id);
}

function parseTs(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(+d) ? null : d;
}
const fmtTime = (ts) => parseTs(ts)?.toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }) ?? '';
const fmtDate = (ts) => parseTs(ts)?.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) ?? '';
function fmtDuration(a, b) {
  const s = parseTs(a), e = parseTs(b);
  if (!s || !e) return '';
  const sec = Math.max(0, Math.round((e - s) / 1000));
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

// ═════════════════════════ designer ═════════════════════════

export function renderFlowDesigner(container, { api, toast = () => {}, user } = {}) {
  const canEdit = EDIT_ROLES.includes(user?.role);
  const s = {
    flows: [], catalogue: [], byType: {},
    selectedId: null,         // saved flow the draft started from (null = new, unsaved)
    draft: null,              // { key?, name, description, appliesTo, steps }
    dirty: false,
    validation: { ok: true, errors: [] }, validating: false, valSeq: 0, valTimer: null,
    expanded: new Set(), focusStep: null, busy: false,
    drag: null,
  };

  container.classList.add('fd');
  container.innerHTML = `
    <div class="fd-readonly" role="note" ${canEdit ? 'hidden' : ''}>${ICON.lock}<span><b>View only.</b> Only a pharmacist or admin can change or activate pharmacy flows${user?.role ? ` (you are signed in as ${esc(user.role)})` : ''}.</span></div>
    <div class="fd-grid">
      <aside class="fd-list card" aria-label="Flows">
        <div class="fd-head"><h2>Flows</h2>${canEdit ? `<button type="button" class="fd-new" data-act="new" aria-label="New flow from a copy of the selected flow">${ICON.plus}New flow</button>` : ''}</div>
        <div class="fd-groups" data-region="list"><div class="fd-empty">Loading…</div></div>
      </aside>
      <section class="fd-canvas card" aria-label="Pipeline">
        <header class="fd-canvas-head" data-region="head"></header>
        <div class="fd-errors" data-region="errors" aria-live="polite"></div>
        <ol class="fd-chain" data-region="chain" aria-label="Pipeline steps"></ol>
      </section>
      <aside class="fd-side" aria-label="Flow details and step palette">
        <div class="card fd-details" data-region="details"></div>
        <div class="card fd-palette-card">
          <div class="fd-head"><h2>Add a step</h2></div>
          <p class="fd-hint">${canEdit ? 'Click to add after the selected step, or drag into the pipeline.' : 'Steps available to pharmacy flows.'}</p>
          <div class="fd-palette" data-region="palette"></div>
        </div>
      </aside>
    </div>`;
  const $r = (name) => container.querySelector(`[data-region="${name}"]`);

  // ── data ──
  async function load(selectId) {
    try {
      const [flows, catalogue] = await Promise.all([api('/api/flows'), s.catalogue.length ? s.catalogue : api('/api/flows/catalogue')]);
      s.flows = flows ?? [];
      s.catalogue = catalogue ?? [];
      s.byType = Object.fromEntries(s.catalogue.map((c) => [c.type, c]));
      const keep = selectId ?? s.selectedId;
      const pick = s.flows.find((f) => f.id === keep) ?? s.flows.find((f) => f.active) ?? s.flows[0];
      if (pick) selectFlow(pick.id, { force: true });
      else newBlank();
      renderPalette();
    } catch (e) {
      $r('list').innerHTML = `<div class="fd-empty">Couldn't load flows: ${esc(e.message)}</div>`;
      toast(e.message, true);
    }
  }

  function draftFrom(f) {
    return { key: f.key, name: f.name ?? '', description: f.description ?? f.definition?.description ?? '', appliesTo: [...(f.appliesTo ?? f.definition?.appliesTo ?? [])], steps: clone(f.steps ?? f.definition?.steps ?? []) };
  }
  const definition = () => ({ name: s.draft.name, description: s.draft.description, appliesTo: s.draft.appliesTo, steps: s.draft.steps });
  const selected = () => s.flows.find((f) => f.id === s.selectedId) ?? null;
  const meta = (type) => s.byType[type] ?? { type, kind: 'auto', label: type, description: 'Unknown step type', required: false, configSchema: [] };

  function selectFlow(id, { force = false } = {}) {
    if (!force && s.dirty && !confirmDiscard()) return;
    const f = s.flows.find((x) => x.id === id);
    if (!f) return;
    s.selectedId = id;
    s.draft = draftFrom(f);
    s.dirty = false;
    s.expanded.clear();
    s.focusStep = null;
    renderAll();
    validateSoon(0);
  }
  function newBlank() {
    s.selectedId = null;
    s.draft = { name: 'New flow', description: '', appliesTo: [], steps: [] };
    s.dirty = true;
    renderAll();
    validateSoon(0);
  }
  function newFromCopy() {
    if (s.dirty && !confirmDiscard()) return;
    const base = s.draft ?? { name: 'New flow', description: '', appliesTo: [], steps: [] };
    s.draft = { ...clone(base), key: undefined, name: `Copy of ${base.name || 'flow'}` };
    delete s.draft.key;
    s.selectedId = null;
    s.dirty = true;
    renderAll();
    validateSoon(0);
    container.querySelector('[data-field="name"]')?.select();
    container.querySelector('[data-field="name"]')?.focus();
  }
  function confirmDiscard() {
    try { return window.confirm('Discard unsaved changes to this flow?'); } catch { return true; }
  }

  function changed({ structural = true } = {}) {
    s.dirty = true;
    if (structural) { renderChain(); renderPalette(); }
    renderHead();
    validateSoon();
  }

  // ── validation (server-side, debounced) ──
  function validateSoon(delay = 250) {
    clearTimeout(s.valTimer);
    s.validating = true;
    renderHead();
    s.valTimer = setTimeout(runValidation, delay);
  }
  async function runValidation() {
    const seq = ++s.valSeq;
    try {
      const r = await api('/api/flows/validate', { method: 'POST', body: { definition: definition() } });
      if (seq !== s.valSeq) return;
      s.validation = { ok: !!r?.ok, errors: r?.errors ?? [] };
    } catch (e) {
      if (seq !== s.valSeq) return;
      s.validation = { ok: false, errors: e.details?.errors ?? (Array.isArray(e.details) ? e.details : [`Couldn't validate: ${e.message}`]) };
    }
    s.validating = false;
    renderHead();
    renderErrors();
    markErrors();
  }

  function errorsByStep() {
    const map = new Map();
    for (const msg of s.validation.errors) for (const id of stepsMentioned(msg, s.draft.steps, (t) => s.byType[t]?.label)) map.set(id, [...(map.get(id) ?? []), msg]);
    return map;
  }

  // ── save / activate ──
  async function save() {
    if (!canEdit || s.busy || s.validating || !s.validation.ok) return;
    s.busy = true; renderHead();
    try {
      const body = { definition: definition() };
      if (s.draft.key) body.key = s.draft.key;
      const created = await api('/api/flows', { method: 'POST', body });
      toast(`Saved ${created?.name ?? s.draft.name} as version ${created?.version ?? ''}`.trim());
      s.dirty = false;
      await load(created?.id);
    } catch (e) {
      const errs = e.details?.errors ?? (Array.isArray(e.details) ? e.details : null);
      if (errs) { s.validation = { ok: false, errors: errs }; renderErrors(); markErrors(); }
      toast(e.message, true);
    } finally {
      s.busy = false; renderHead();
    }
  }
  async function activate() {
    const f = selected();
    if (!canEdit || !f || f.active || s.dirty || s.busy) return;
    s.busy = true; renderHead();
    try {
      await api(`/api/flows/${f.id}/activate`, { method: 'POST' });
      toast(`${f.name} v${f.version} is now active`);
      await load(f.id);
    } catch (e) {
      toast(e.message, true);
    } finally {
      s.busy = false; renderHead();
    }
  }

  // ── step edits ──
  const idx = (id) => s.draft.steps.findIndex((st) => st.id === id);
  function uniqueId(type) {
    const base = type.replace(/_/g, '-');
    const ids = new Set(s.draft.steps.map((st) => st.id));
    if (!ids.has(base)) return base;
    let n = 2;
    while (ids.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }
  function insertType(type, at) {
    const m = meta(type);
    const config = Object.fromEntries((m.configSchema ?? []).map((f) => [f.key, clone(f.default ?? (f.type === 'sources' ? [] : f.type === 'boolean' ? false : f.type === 'number' ? 0 : ''))]));
    const step = { id: uniqueId(type), type, enabled: true, config };
    if (at == null) {
      const sel = s.focusStep ? idx(s.focusStep) : -1;
      at = sel >= 0 ? sel + 1 : s.draft.steps.length;
    }
    s.draft.steps.splice(Math.max(0, Math.min(at, s.draft.steps.length)), 0, step);
    s.focusStep = step.id;
    changed();
    focusIn(`.fd-step[data-id="${CSS.escape(step.id)}"] .fd-step-main`);
    toast(`Added ${m.label}`);
  }
  function moveTo(id, to) {
    const from = idx(id);
    if (from < 0) return false;
    const [st] = s.draft.steps.splice(from, 1);
    const target = to > from ? to - 1 : to;
    s.draft.steps.splice(Math.max(0, Math.min(target, s.draft.steps.length)), 0, st);
    if (target === from) return false;
    s.focusStep = id;
    changed();
    return true;
  }
  function move(id, delta, btn) {
    const from = idx(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= s.draft.steps.length) return;
    const [st] = s.draft.steps.splice(from, 1);
    s.draft.steps.splice(to, 0, st);
    s.focusStep = id;
    changed();
    const sel = `.fd-step[data-id="${CSS.escape(id)}"] [data-act="${btn}"]`;
    const el = container.querySelector(sel);
    focusIn(el && !el.disabled ? sel : `.fd-step[data-id="${CSS.escape(id)}"] [data-act="${btn === 'up' ? 'down' : 'up'}"]`);
  }
  function remove(id) {
    const i = idx(id);
    const st = s.draft.steps[i];
    if (!st || meta(st.type).required) return;
    s.draft.steps.splice(i, 1);
    s.expanded.delete(id);
    if (s.focusStep === id) s.focusStep = s.draft.steps[Math.min(i, s.draft.steps.length - 1)]?.id ?? null;
    changed();
    if (s.focusStep) focusIn(`.fd-step[data-id="${CSS.escape(s.focusStep)}"] .fd-step-main`);
    toast(`Removed ${meta(st.type).label}`);
  }
  function toggle(id) {
    const st = s.draft.steps[idx(id)];
    if (!st) return;
    if (meta(st.type).required && st.enabled) return; // guardrail: required steps stay on
    st.enabled = !st.enabled;
    changed();
    focusIn(`.fd-step[data-id="${CSS.escape(id)}"] [data-act="toggle"]`);
  }
  function focusIn(sel) { requestAnimationFrame(() => container.querySelector(sel)?.focus()); }

  // ── rendering ──
  function renderAll() { renderList(); renderHead(); renderErrors(); renderChain(); renderDetails(); renderPalette(); }

  function renderList() {
    const groups = new Map();
    for (const f of s.flows) groups.set(f.key, [...(groups.get(f.key) ?? []), f]);
    const html = [...groups.entries()].map(([key, versions]) => {
      versions.sort((a, b) => b.version - a.version);
      const head = versions.find((v) => v.active) ?? versions[0];
      return `<div class="fd-group">
        <div class="fd-group-head">
          <div class="fd-group-name">${esc(head.name)}</div>
          <div class="fd-group-key mono">${esc(key)}</div>
          <div class="fd-applies">${(head.appliesTo ?? []).map((a) => `<span class="chip fd-src">${esc(SOURCE_LABEL[a] ?? a)}</span>`).join('') || '<span class="fd-dim">No sources</span>'}</div>
        </div>
        <ul class="fd-versions">${versions.map((v) => `
          <li><button type="button" class="fd-version ${v.id === s.selectedId ? 'sel' : ''}" data-act="select" data-flow="${v.id}" aria-current="${v.id === s.selectedId}" aria-label="${esc(v.name)} version ${v.version}${v.active ? ', active' : ''}">
            <span class="fd-vbadge">v${esc(v.version)}</span>
            <span class="fd-vname">${v.name === head.name ? `<span class="fd-vdate">${esc(fmtDate(v.created_at) || v.name)}</span>` : esc(v.name)}</span>
            ${v.active ? '<span class="fd-active"><span class="dot"></span>Active</span>' : ''}
          </button></li>`).join('')}
        </ul>
      </div>`;
    }).join('');
    const draftRow = s.selectedId == null && s.draft
      ? `<div class="fd-group fd-group-draft"><button type="button" class="fd-version sel" aria-current="true"><span class="fd-vbadge new">new</span><span class="fd-vname">${esc(s.draft.name || 'Untitled flow')}</span><span class="fd-dim">Unsaved</span></button></div>` : '';
    $r('list').innerHTML = draftRow + (html || '<div class="fd-empty">No flows yet.</div>');
  }

  function renderHead() {
    if (!s.draft) return;
    const f = selected();
    const v = s.validation;
    const status = s.validating ? '<span class="chip fd-status checking"><span class="fd-spin"></span>Checking…</span>'
      : v.ok ? `<span class="chip fd-status ok">${ICON.check}Guardrails pass</span>`
      : `<span class="chip fd-status bad">${ICON.alert}${v.errors.length} problem${v.errors.length === 1 ? '' : 's'}</span>`;
    const human = s.draft.steps.filter((st) => st.enabled && meta(st.type).kind === 'human').length;
    const auto = s.draft.steps.filter((st) => st.enabled && meta(st.type).kind !== 'human').length;
    const saveBlocked = !canEdit || s.busy || s.validating || !v.ok || (!s.dirty && s.selectedId != null);
    const saveTitle = !canEdit ? 'Only a pharmacist or admin can save flows' : !v.ok ? 'Fix the problems listed before saving' : !s.dirty && s.selectedId != null ? 'No changes to save' : 'Save as a new version';
    const actBlocked = !canEdit || s.busy || !f || f.active || s.dirty;
    const actTitle = !canEdit ? 'Only a pharmacist or admin can activate flows' : !f ? 'Save the flow first' : f.active ? 'This version is already active' : s.dirty ? 'Save your changes first' : `Make v${f.version} the active ${f.key} flow`;
    $r('head').innerHTML = `
      <div class="fd-title">
        <span class="fd-title-ico">${ICON.flow}</span>
        <div>
          <h2>${esc(s.draft.name || 'Untitled flow')}</h2>
          <div class="fd-sub">
            ${f ? `<span class="fd-vbadge">v${esc(f.version)}</span>${f.active ? '<span class="fd-active"><span class="dot"></span>Active</span>' : '<span class="fd-dim">Inactive</span>'}` : '<span class="fd-vbadge new">new</span>'}
            ${s.dirty ? '<span class="fd-dirty">● Unsaved changes</span>' : ''}
            <span class="fd-dim">${human} human checkpoint${human === 1 ? '' : 's'} · ${auto} automatic</span>
          </div>
        </div>
      </div>
      <div class="fd-actions">
        ${status}
        ${canEdit ? `${s.dirty && s.selectedId != null ? '<button type="button" data-act="revert">Discard</button>' : ''}
        <button type="button" data-act="activate" ${actBlocked ? 'disabled' : ''} title="${esc(actTitle)}">Activate</button>
        <button type="button" class="primary" data-act="save" ${saveBlocked ? 'disabled' : ''} title="${esc(saveTitle)}">${s.busy ? 'Saving…' : s.selectedId == null ? 'Save flow' : 'Save new version'}</button>` : '<span class="chip fd-viewonly">' + ICON.lock + 'View only</span>'}
      </div>`;
  }

  function renderErrors() {
    const errs = s.validation.errors;
    $r('errors').innerHTML = !s.validating && errs.length ? `
      <div class="fd-errbox" role="alert">
        <div class="fd-errtitle">${ICON.alert}This flow can't be saved until these are fixed</div>
        <ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      </div>` : '';
  }

  function markErrors() {
    const map = errorsByStep();
    container.querySelectorAll('.fd-step').forEach((el) => {
      const errs = map.get(el.dataset.id) ?? [];
      el.classList.toggle('has-error', errs.length > 0);
      const box = el.querySelector('.fd-step-errs');
      if (box) box.innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join('');
    });
  }

  function stepHtml(st, i, n) {
    const m = meta(st.type);
    const human = m.kind === 'human';
    const req = !!m.required;
    const open = s.expanded.has(st.id);
    const fields = m.configSchema ?? [];
    const role = HUMAN_ROLE[st.type] ?? 'Staff';
    const locked = !canEdit;
    return `
      <li class="fd-step ${human ? 'human' : 'auto'} ${req ? 'required' : ''} ${st.enabled ? '' : 'off'} ${open ? 'open' : ''} ${s.focusStep === st.id ? 'sel' : ''}"
          data-id="${esc(st.id)}" data-type="${esc(st.type)}" ${canEdit ? 'draggable="true"' : ''}>
        <div class="fd-step-main" tabindex="0" aria-label="Step ${i + 1} of ${n}: ${esc(m.label)}${req ? ', required' : ''}${st.enabled ? '' : ', disabled'}">
          ${canEdit ? `<span class="fd-grip-wrap" title="Drag to reorder">${ICON.grip}</span>` : '<span class="fd-grip-wrap"></span>'}
          <span class="fd-step-ico" title="${human ? `${role} checkpoint` : 'Automatic'}">${human ? ICON.person : ICON.gear}</span>
          <div class="fd-step-text">
            <div class="fd-step-label">${esc(m.label)}${req ? `<span class="fd-lock" title="Required by guardrails: can't be disabled or removed">${ICON.lock}<span>Required</span></span>` : ''}</div>
            <div class="fd-step-meta">
              ${human ? `<span class="fd-kind human">${esc(role)} checkpoint</span>` : '<span class="fd-kind auto">Automatic</span>'}
              <code>${esc(st.type)}</code>
              ${st.enabled ? '' : '<span class="fd-kind offtag">Disabled</span>'}
              ${st.type === 'data_entry' && st.config?.autoFor?.length ? `<span class="fd-dim">auto for ${st.config.autoFor.map((x) => esc(SOURCE_LABEL[x] ?? x)).join(', ')}</span>` : ''}
            </div>
          </div>
          <div class="fd-step-actions">
            <button type="button" role="switch" class="fd-switch" data-act="toggle" aria-checked="${st.enabled}"
              aria-label="${st.enabled ? 'Disable' : 'Enable'} ${esc(m.label)}" ${locked || (req && st.enabled) ? 'disabled' : ''}
              title="${req && st.enabled ? 'Required step: always enabled' : st.enabled ? 'Enabled' : 'Disabled'}"><span></span></button>
            ${locked ? '' : `<button type="button" class="fd-icon" data-act="up" aria-label="Move ${esc(m.label)} up" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
            <button type="button" class="fd-icon" data-act="down" aria-label="Move ${esc(m.label)} down" title="Move down" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
            ${req ? '<span class="fd-icon-spacer" aria-hidden="true"></span>' : `<button type="button" class="fd-icon danger" data-act="remove" aria-label="Remove ${esc(m.label)}" title="Remove">${ICON.trash}</button>`}`}
            <button type="button" class="fd-icon fd-expand" data-act="expand" aria-expanded="${open}" aria-controls="fd-cfg-${esc(st.id)}"
              aria-label="${open ? 'Hide' : 'Show'} settings for ${esc(m.label)}" title="Settings">${ICON.chevron}</button>
          </div>
        </div>
        <ul class="fd-step-errs"></ul>
        <div class="fd-step-config" id="fd-cfg-${esc(st.id)}" ${open ? '' : 'hidden'}>
          ${m.description ? `<p class="fd-desc">${esc(m.description)}</p>` : ''}
          <div class="fd-field-row"><span class="fd-flabel">Step id</span><code>${esc(st.id)}</code></div>
          ${fields.length ? fields.map((f) => fieldHtml(st, f, locked)).join('') : '<div class="fd-dim">No settings for this step.</div>'}
        </div>
      </li>`;
  }

  function fieldHtml(st, f, locked) {
    const val = st.config?.[f.key] ?? f.default;
    const name = `fd-${st.id}-${f.key}`;
    const attrs = `data-cfg="${esc(f.key)}" data-step="${esc(st.id)}" ${locked ? 'disabled' : ''}`;
    if (f.type === 'boolean') {
      return `<label class="fd-field-row fd-check"><span class="fd-flabel">${esc(f.label)}</span><input type="checkbox" ${attrs} data-kind="boolean" ${val ? 'checked' : ''} /></label>`;
    }
    if (f.type === 'number') {
      const lim = `${f.min != null ? ` min="${esc(f.min)}"` : ''}${f.max != null ? ` max="${esc(f.max)}"` : ''}`;
      return `<label class="fd-field-row"><span class="fd-flabel">${esc(f.label)}</span><input type="number" step="any"${lim} ${attrs} data-kind="number" value="${esc(val ?? '')}" /></label>`;
    }
    if (f.type === 'string' && Array.isArray(f.options) && f.options.length) {
      return `<label class="fd-field-row"><span class="fd-flabel">${esc(f.label)}</span><select ${attrs} data-kind="string">${f.options.map((o) => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'sources') {
      const set = new Set(Array.isArray(val) ? val : []);
      const allowed = Array.isArray(f.allowed) ? new Set(f.allowed) : null;
      return `<fieldset class="fd-field-row fd-sources-field"><legend class="fd-flabel">${esc(f.label)}</legend><div class="fd-srcs">
        ${SOURCES.map(([v, l]) => `<label class="fd-srcopt ${allowed && !allowed.has(v) ? 'not-allowed' : ''}" ${allowed && !allowed.has(v) ? 'title="Not allowed for this setting"' : ''}><input type="checkbox" ${attrs} data-kind="sources" value="${v}" name="${esc(name)}" ${set.has(v) ? 'checked' : ''} /><span>${esc(l)}</span></label>`).join('')}
      </div></fieldset>`;
    }
    return `<label class="fd-field-row"><span class="fd-flabel">${esc(f.label)}</span><input type="text" ${attrs} data-kind="string" value="${esc(val ?? '')}" /></label>`;
  }

  function renderChain() {
    const steps = s.draft?.steps ?? [];
    const n = steps.length;
    const parts = [];
    steps.forEach((st, i) => {
      if (i > 0) parts.push(`<li class="fd-conn" aria-hidden="true" data-at="${i}"><span></span></li>`);
      parts.push(stepHtml(st, i, n));
    });
    $r('chain').innerHTML = n ? `<li class="fd-terminal" aria-hidden="true">Prescription received</li><li class="fd-conn" aria-hidden="true" data-at="0"><span></span></li>${parts.join('')}<li class="fd-conn" aria-hidden="true" data-at="${n}"><span></span></li><li class="fd-terminal" aria-hidden="true">Supplied to patient</li>`
      : `<li class="fd-empty fd-chain-empty">No steps yet. ${canEdit ? 'Add steps from the palette.' : ''}</li>`;
    markErrors();
  }

  function renderDetails() {
    const d = s.draft;
    const ro = canEdit ? '' : 'disabled';
    $r('details').innerHTML = `
      <div class="fd-head"><h2>Flow details</h2></div>
      <label class="fd-lbl">Name<input type="text" data-field="name" value="${esc(d.name)}" ${ro} /></label>
      <label class="fd-lbl">Description<textarea data-field="description" rows="3" ${ro}>${esc(d.description)}</textarea></label>
      <fieldset class="fd-applies-field"><legend>Applies to prescriptions from</legend>
        <div class="fd-srcs">${SOURCES.map(([v, l]) => `<label class="fd-srcopt"><input type="checkbox" data-field="appliesTo" value="${v}" ${d.appliesTo.includes(v) ? 'checked' : ''} ${ro} /><span>${esc(l)}</span></label>`).join('')}</div>
      </fieldset>
      ${s.draft.key ? `<div class="fd-dim fd-keyline">Key <code>${esc(s.draft.key)}</code> · saving creates a new version</div>` : '<div class="fd-dim fd-keyline">Saving creates a new flow; its key is derived from the name.</div>'}`;
  }

  function renderPalette() {
    const counts = {};
    for (const st of s.draft?.steps ?? []) counts[st.type] = (counts[st.type] ?? 0) + 1;
    const section = (kind, title) => {
      const items = s.catalogue.filter((c) => (kind === 'human' ? c.kind === 'human' : c.kind !== 'human'));
      if (!items.length) return '';
      return `<div class="fd-pal-group"><div class="fd-pal-title">${title}</div>${items.map((c) => `
        <button type="button" class="fd-pal ${c.kind === 'human' ? 'human' : 'auto'}" data-act="add" data-type="${esc(c.type)}" ${canEdit ? 'draggable="true"' : 'disabled'}
          aria-label="Add ${esc(c.label)} step" title="${esc(c.description ?? '')}">
          <span class="fd-step-ico">${c.kind === 'human' ? ICON.person : ICON.gear}</span>
          <span class="fd-pal-text"><span class="fd-pal-label">${esc(c.label)}${c.required ? ICON.lock : ''}</span><span class="fd-pal-desc">${esc(c.description ?? '')}</span></span>
          ${counts[c.type] ? `<span class="fd-pal-count" title="Already in this flow">${counts[c.type] > 1 ? `×${counts[c.type]}` : 'In flow'}</span>` : ICON.plus}
        </button>`).join('')}</div>`;
    };
    $r('palette').innerHTML = section('auto', 'Automatic') + section('human', 'Human checkpoints');
  }

  // ── events ──
  container.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled && container.contains(b)) {
      const id = b.closest('.fd-step')?.dataset.id;
      switch (b.dataset.act) {
        case 'select': return selectFlow(Number(b.dataset.flow));
        case 'new': return canEdit && newFromCopy();
        case 'save': return save();
        case 'activate': return activate();
        case 'revert': return selectFlow(s.selectedId, { force: true });
        case 'add': return canEdit && insertType(b.dataset.type);
        case 'toggle': return canEdit && toggle(id);
        case 'up': return canEdit && move(id, -1, 'up');
        case 'down': return canEdit && move(id, +1, 'down');
        case 'remove': return canEdit && remove(id);
        case 'expand': {
          if (s.expanded.has(id)) s.expanded.delete(id); else s.expanded.add(id);
          const li = b.closest('.fd-step');
          const open = s.expanded.has(id);
          li.classList.toggle('open', open);
          li.querySelector('.fd-step-config').hidden = !open;
          b.setAttribute('aria-expanded', open);
          return;
        }
      }
      return;
    }
    const card = e.target.closest('.fd-step');
    if (card && !e.target.closest('.fd-step-config')) {
      s.focusStep = card.dataset.id;
      container.querySelectorAll('.fd-step.sel').forEach((el) => el.classList.remove('sel'));
      card.classList.add('sel');
    }
  });

  container.addEventListener('keydown', (e) => {
    const main = e.target.closest('.fd-step-main');
    if (!main || e.target !== main) return;
    const id = main.closest('.fd-step').dataset.id;
    if (canEdit && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const i = idx(id), to = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= s.draft.steps.length) return;
      const [st] = s.draft.steps.splice(i, 1);
      s.draft.steps.splice(to, 0, st);
      s.focusStep = id;
      changed();
      focusIn(`.fd-step[data-id="${CSS.escape(id)}"] .fd-step-main`);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      main.querySelector('[data-act="expand"]').click();
    }
  });
  container.addEventListener('focusin', (e) => {
    const card = e.target.closest?.('.fd-step');
    if (card && s.draft?.steps.some((st) => st.id === card.dataset.id)) s.focusStep = card.dataset.id;
  });

  container.addEventListener('input', (e) => {
    const el = e.target;
    if (!canEdit || !s.draft) return;
    if (el.dataset.field === 'name' || el.dataset.field === 'description') {
      s.draft[el.dataset.field] = el.value;
      if (el.dataset.field === 'name') { container.querySelector('.fd-title h2').textContent = el.value || 'Untitled flow'; if (s.selectedId == null) renderList(); }
      return changed({ structural: false });
    }
    if (el.dataset.cfg && el.dataset.kind !== 'boolean' && el.dataset.kind !== 'sources') {
      const st = s.draft.steps[idx(el.dataset.step)];
      if (!st) return;
      st.config = st.config ?? {};
      if (el.dataset.kind === 'number') st.config[el.dataset.cfg] = el.value === '' ? null : Number(el.value);
      else st.config[el.dataset.cfg] = el.value;
      changed({ structural: false });
    }
  });
  container.addEventListener('change', (e) => {
    const el = e.target;
    if (!canEdit || !s.draft) return;
    if (el.dataset.field === 'appliesTo') {
      const set = new Set(s.draft.appliesTo);
      if (el.checked) set.add(el.value); else set.delete(el.value);
      s.draft.appliesTo = SOURCES.map(([v]) => v).filter((v) => set.has(v));
      return changed({ structural: false });
    }
    if (el.dataset.cfg && (el.dataset.kind === 'boolean' || el.dataset.kind === 'sources')) {
      const st = s.draft.steps[idx(el.dataset.step)];
      if (!st) return;
      st.config = st.config ?? {};
      if (el.dataset.kind === 'boolean') st.config[el.dataset.cfg] = el.checked;
      else {
        const set = new Set(Array.isArray(st.config[el.dataset.cfg]) ? st.config[el.dataset.cfg] : []);
        if (el.checked) set.add(el.value); else set.delete(el.value);
        st.config[el.dataset.cfg] = SOURCES.map(([v]) => v).filter((v) => set.has(v));
      }
      changed({ structural: false });
      if (st.type === 'data_entry') { // refresh the "auto for" summary on the card without losing focus
        const metaEl = el.closest('.fd-step').querySelector('.fd-step-meta');
        const tmp = document.createElement('div');
        tmp.innerHTML = stepHtml(st, idx(st.id), s.draft.steps.length);
        metaEl.innerHTML = tmp.querySelector('.fd-step-meta').innerHTML;
      }
    }
  });

  // HTML5 drag and drop: reorder steps, or drop palette items into the chain.
  const chain = $r('chain');
  function dropIndex(clientY) {
    const cards = [...chain.querySelectorAll('.fd-step')];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return cards.length;
  }
  function showIndicator(at) {
    chain.querySelectorAll('.fd-conn.drop').forEach((el) => el.classList.remove('drop'));
    chain.querySelector(`.fd-conn[data-at="${at}"]`)?.classList.add('drop');
  }
  function clearDrag() {
    s.drag = null;
    container.classList.remove('dragging');
    chain.querySelectorAll('.fd-conn.drop, .fd-step.drag-src').forEach((el) => el.classList.remove('drop', 'drag-src'));
  }
  container.addEventListener('dragstart', (e) => {
    if (!canEdit) return;
    const step = e.target.closest?.('.fd-step');
    const pal = e.target.closest?.('.fd-pal');
    if (step && !e.target.closest('.fd-step-config')) {
      s.drag = { kind: 'step', id: step.dataset.id };
      step.classList.add('drag-src');
    } else if (pal) {
      s.drag = { kind: 'type', type: pal.dataset.type };
    } else return;
    container.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = s.drag.kind === 'step' ? 'move' : 'copy';
      e.dataTransfer.setData('text/plain', s.drag.kind === 'step' ? `step:${s.drag.id}` : `type:${s.drag.type}`);
    } catch { /* some browsers restrict dataTransfer */ }
  });
  chain.addEventListener('dragover', (e) => {
    if (!s.drag) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = s.drag.kind === 'step' ? 'move' : 'copy'; } catch { /* ignore */ }
    showIndicator(dropIndex(e.clientY));
  });
  chain.addEventListener('dragleave', (e) => { if (!chain.contains(e.relatedTarget)) showIndicator(-1); });
  chain.addEventListener('drop', (e) => {
    if (!s.drag) return;
    e.preventDefault();
    const at = dropIndex(e.clientY);
    const d = s.drag;
    clearDrag();
    if (d.kind === 'step') moveTo(d.id, at) || renderChain();
    else insertType(d.type, at);
  });
  container.addEventListener('dragend', clearDrag);

  load();
  return {
    reload: () => load(),
    getDraft: () => clone(s.draft),
    get state() { return { selectedId: s.selectedId, dirty: s.dirty, validation: clone(s.validation) }; },
  };
}

// ═════════════════════════ timeline ═════════════════════════

const STATUS = {
  done: { icon: ICON.check, label: 'Done' },
  running: { icon: '<span class="ft-spin"></span>', label: 'Running' },
  waiting: { icon: ICON.person, label: 'Waiting' },
  failed: { icon: ICON.cross, label: 'Failed' },
  skipped: { icon: ICON.skip, label: 'Skipped' },
  pending: { icon: '<span class="ft-hollow"></span>', label: 'Pending' },
};

const ACRONYM = { nhi: 'NHI', scid: 'SCID', cpn: 'CPN', id: 'ID' };

function safeHref(u) {
  const s = String(u ?? '');
  return /^(\/(?!\/)|https?:\/\/)/i.test(s) ? s : null;
}

/** Short human summary of a step run's output, plus leftover primitive fields. */
const HIDDEN_KEYS = ['reason', 'skippedReason', 'awaiting', 'roles', 'userId', 'initials', 'role', 'hash', 'receivedAt', 'fulfilmentId', 'kind', 'automated', 'message'];
const clip = (v, n = 48) => { const t = String(v); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function summariseOutput(out, type = '') {
  if (!out || typeof out !== 'object') return out == null || out === '' ? '' : `<span class="ft-kv">${esc(clip(out))}</span>`;
  const used = new Set(HIDDEN_KEYS);
  const bits = [];
  const take = (k) => { used.add(k); return out[k]; };
  if ('onHand' in out) bits.push(`<span class="ft-kv"><i>On hand</i> ${esc(take('onHand'))}</span>`);
  if ('shortBy' in out) { const v = take('shortBy'); if (v) bits.push(`<span class="tag warn">Short by ${esc(v)}</span>`); }
  for (const k of ['worksheetUrl', 'worksheet', 'labelUrl', 'label', 'url', 'href']) {
    if (k in out && typeof out[k] === 'string') {
      const href = safeHref(take(k));
      const name = k.startsWith('label') || type === 'generate_label' ? 'Label' : k.startsWith('worksheet') || type === 'print_worksheet' ? 'Worksheet' : 'Open';
      if (href) bits.push(`<a class="ft-link" href="${esc(href)}" target="_blank" rel="noopener">${name} ↗</a>`);
    }
  }
  if (out.automated === true) bits.push('<span class="tag">Automated</span>');
  for (const k of ['trackingRef', 'tracking', 'trackingNumber']) if (k in out) bits.push(`<span class="ft-kv"><i>Tracking</i> <code>${esc(take(k))}</code></span>`);
  if (Array.isArray(out.findings)) {
    const f = take('findings');
    const worst = ['hard_stop', 'high', 'moderate', 'info'].find((sv) => f.some((x) => x?.severity === sv));
    bits.push(`<span class="tag ${worst === 'hard_stop' ? 'danger' : worst === 'high' ? 'warn' : ''}">${f.length} finding${f.length === 1 ? '' : 's'}</span>`);
  }
  if (Array.isArray(out.warnings)) for (const w of take('warnings').slice(0, 3)) bits.push(`<span class="tag warn">${esc(clip(w, 90))}</span>`);
  for (const [k, v] of Object.entries(out)) {
    if (used.has(k) || v == null || v === false || typeof v === 'object' || bits.length >= 5) continue;
    const label = ACRONYM[k.toLowerCase()] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    bits.push(`<span class="ft-kv"><i>${esc(label[0].toUpperCase() + label.slice(1))}</i> ${esc(typeof v === 'boolean' ? 'yes' : clip(v))}</span>`);
  }
  return bits.join('');
}

export async function renderFlowTimeline(container, { api, jobId, user, layout = 'vertical', onChange } = {}) {
  container.classList.add('ft', `ft-${layout === 'horizontal' ? 'horizontal' : 'vertical'}`);
  let busy = null;

  function waitingText(st) {
    if (st.kind !== 'human') return 'Waiting';
    const role = HUMAN_ROLE[st.type];
    const roles = Array.isArray(st.output?.roles) ? st.output.roles : role === 'Pharmacist' ? ['pharmacist'] : ['technician', 'pharmacist'];
    if (user && (user.role === 'admin' || roles.includes(user.role))) return 'Needs you';
    return `Waiting for ${roles.includes('technician') ? 'technician' : 'pharmacist'}`;
  }

  function draw(data) {
    const steps = data?.steps ?? [];
    if (!data?.flow || !steps.length) {
      container.innerHTML = '<div class="ft-empty">No pharmacy flow has started for this script yet.</div>';
      return;
    }
    const done = steps.filter((x) => x.status === 'done' || x.status === 'skipped').length;
    const pct = Math.round((done / steps.length) * 100);
    container.innerHTML = `
      <div class="ft-head">
        <div class="ft-name">${ICON.flow}<span>${esc(data.flow.name)}</span><span class="fd-vbadge">v${esc(data.flow.version)}</span></div>
        <div class="ft-progress" title="${done} of ${steps.length} steps complete"><span class="ft-bar"><span style="width:${pct}%"></span></span><span>${done}/${steps.length}</span></div>
      </div>
      <ol class="ft-steps">${steps.map((st) => {
        const meta = STATUS[st.status] ?? STATUS.pending;
        const cur = data.current && st.stepId === data.current;
        const human = st.kind === 'human';
        const reason = st.output?.reason ?? st.output?.skippedReason ?? (st.status === 'skipped' ? st.error : null);
        const showReason = reason && (st.status === 'skipped' || st.status === 'waiting');
        const statusText = st.status === 'waiting' ? waitingText(st) : meta.label;
        const when = st.finished_at ? `${fmtTime(st.finished_at)}${st.started_at && st.status === 'done' ? ` · ${fmtDuration(st.started_at, st.finished_at)}` : ''}`
          : st.started_at ? `since ${fmtTime(st.started_at)}` : '';
        const summary = st.status === 'skipped' ? '' : summariseOutput(st.output, st.type);
        return `<li class="ft-step s-${esc(st.status)} ${human ? 'human' : 'auto'} ${cur ? 'current' : ''}" data-step="${esc(st.stepId)}" data-status="${esc(st.status)}" ${cur ? 'aria-current="step"' : ''}>
          <span class="ft-dot" aria-hidden="true">${meta.icon}</span>
          <div class="ft-body">
            <div class="ft-line">
              <span class="ft-label">${esc(st.label ?? st.type)}</span>
              ${human ? `<span class="ft-kindico" title="${esc(HUMAN_ROLE[st.type] ?? 'Human')} checkpoint">${ICON.person}</span>` : ''}
              <span class="ft-status">${esc(statusText)}</span>
              ${when ? `<time class="ft-time" datetime="${esc(st.finished_at ?? st.started_at)}">${esc(when)}</time>` : ''}
            </div>
            ${st.status === 'failed' ? `<div class="ft-error">${esc(st.error ?? 'Step failed')}</div>
              <button type="button" class="ft-retry" data-retry="${esc(st.stepId)}" aria-label="Retry ${esc(st.label ?? st.type)}" ${busy ? 'disabled' : ''}>${ICON.retry}${busy === st.stepId ? 'Retrying…' : 'Retry'}</button>` : ''}
            ${showReason ? `<div class="ft-reason">${esc(reason)}</div>` : ''}
            ${summary ? `<div class="ft-out">${summary}</div>` : ''}
          </div>
        </li>`;
      }).join('')}</ol>`;
  }

  async function refresh() {
    try {
      const data = await api(`/api/jobs/${jobId}/flow`);
      draw(data);
      return data;
    } catch (e) {
      container.innerHTML = e.status === 404
        ? '<div class="ft-empty">No pharmacy flow has started for this script yet.</div>'
        : `<div class="ft-empty ft-err">Couldn't load the flow: ${esc(e.message)}</div>`;
      return null;
    }
  }

  container.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-retry]');
    if (!b || b.disabled || busy) return;
    busy = b.dataset.retry;
    b.disabled = true;
    b.innerHTML = `${ICON.retry}Retrying…`;
    try {
      const data = await api(`/api/jobs/${jobId}/flow/retry/${encodeURIComponent(busy)}`, { method: 'POST' });
      busy = null;
      draw(data);
      onChange?.(data);
    } catch (err) {
      busy = null;
      await refresh();
      const box = container.querySelector(`[data-step="${CSS.escape(b.dataset.retry)}"] .ft-error`);
      if (box) box.textContent = `Retry failed: ${err.message}`;
    }
  });

  await refresh();
  return { refresh };
}
