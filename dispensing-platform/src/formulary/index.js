// Formulary module: monograph-style lookups and deterministic formulary checks.
//
// `lookup()` and `check()` are SYNCHRONOUS on purpose: the platform calls them
// inside a synchronous SQLite transaction at clinical sign-off. Network-backed
// sources (NZF) are read only from an in-memory cache filled ahead of time by
// the async `prefetch()`. If the NZF cache has no entry, the chain falls back
// to the next source (normally the local demo file) and the finding trace says
// so.
//
// Findings use the shared shape from docs/flow-contract.md with origin
// 'formulary' and NZF_* codes so they never collide with src/domain/screening.js.
//
// The bundled data (data/formulary.demo.json) is DEMO DATA, not clinically
// validated, and contains no NZF text.

import { readFileSync } from 'node:fs';

export const DEFAULT_DEMO_PATH = new URL('../../data/formulary.demo.json', import.meta.url);
export const NZF_NOT_CONFIGURED = 'NZF data licence/API not configured';

const DAY_MS = 86_400_000;
const GAP_TOLERANCE_DAYS = 7;
const RENAL_ACTIONS = ['avoid', 'reduce', 'monitor'];
const RENAL_SEVERITY = { avoid: 'hard_stop', reduce: 'high', monitor: 'moderate' };
const IX_SEVERITY = { contraindicated: 'hard_stop', severe: 'high', moderate: 'moderate', mild: 'info' };
const IX_RANK = ['contraindicated', 'severe', 'moderate', 'mild'];

export class NzfNotConfiguredError extends Error {
  constructor(detail) {
    super(`${NZF_NOT_CONFIGURED}${detail ? `: ${detail}` : ''}. Obtain an NZF content licence and API credentials, then set baseUrl and apiKey.`);
    this.name = 'NzfNotConfiguredError';
    this.code = 'NZF_NOT_CONFIGURED';
  }
}

const key = (s) => String(s ?? '').trim().toLowerCase();

// ───────────────────────── sources ─────────────────────────
// A source is { name, version, licensed, configured, get(ingredient) -> monograph | null | undefined, prefetch?(medicines) }
// get(): monograph = answered; null = source knows it has no monograph; undefined = not cached / unknown.
// get() may throw NzfNotConfiguredError.

function normaliseMonograph(ingredient, raw) {
  return {
    ingredient: key(raw.ingredient ?? ingredient),
    nzfUrl: raw.nzfUrl ?? null,
    adultMaxDailyMg: raw.adultMaxDailyMg ?? null,
    renal: (raw.renal ?? []).filter((r) => RENAL_ACTIONS.includes(r.action) && Number.isFinite(r.egfrBelow)),
    ...(raw.hepatic ? { hepatic: raw.hepatic } : {}),
    interactions: (raw.interactions ?? []).map((i) => ({ ...i, with: key(i.with) })).filter((i) => i.with && IX_SEVERITY[i.severity]),
    ...(raw.maxContinuousDays != null ? { maxContinuousDays: raw.maxContinuousDays } : {}),
    ...(raw.durationNote ? { durationNote: raw.durationNote } : {}),
  };
}

/** Local JSON source (default: data/formulary.demo.json). Synchronous; reads the file once. */
export function createLocalFormularySource(path = DEFAULT_DEMO_PATH) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const monographs = new Map(Object.entries(data.monographs ?? {}).map(([ing, m]) => [key(ing), normaliseMonograph(ing, m)]));
  const groups = Object.fromEntries(Object.entries(data.groups ?? {}).map(([g, list]) => [key(g), list.map(key)]));
  return {
    kind: 'local',
    name: data.name ?? 'Local formulary',
    version: data.version ?? 'unversioned',
    licensed: data.licensed === true,
    configured: true,
    disclaimer: data._disclaimer ?? null,
    groups,
    get: (ingredient) => monographs.get(key(ingredient)) ?? null,
    ingredients: () => [...monographs.keys()],
  };
}

/**
 * Map the ASSUMED NZF response shape onto our monograph object.
 *
 * ASSUMPTION (not a published NZF contract): the licensed feed returns, per
 * ingredient, JSON like
 *   { ingredient, url, contentVersion,
 *     dosing: { adultMaxDailyMg },
 *     renal: [{ egfrBelow, action: 'avoid'|'reduce'|'monitor', text }],
 *     hepatic: { action, text },
 *     interactions: [{ ingredient | group, severity, mechanism, management }],
 *     duration: { maxContinuousDays, text } }
 * The real NZF API is FHIR (OAuth2) and delivers interactions only through
 * custom operations (see docs/formulary-sources.md), so a production adapter
 * must replace this function once the licensed interface is known.
 */
export function mapNzfResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const sev = (s) => {
    const v = key(s);
    if (IX_SEVERITY[v]) return v;
    if (['avoid', 'contra-indicated', 'contraindication'].includes(v)) return 'contraindicated';
    if (['major', 'high', 'serious'].includes(v)) return 'severe';
    if (['minor', 'low'].includes(v)) return 'mild';
    return 'moderate';
  };
  return normaliseMonograph(json.ingredient, {
    ingredient: json.ingredient,
    nzfUrl: json.url ?? null,
    adultMaxDailyMg: json.dosing?.adultMaxDailyMg ?? null,
    renal: (json.renal ?? []).map((r) => ({ egfrBelow: Number(r.egfrBelow), action: key(r.action), note: r.text ?? r.note ?? '' })),
    hepatic: json.hepatic ? { action: key(json.hepatic.action), note: json.hepatic.text ?? json.hepatic.note ?? '' } : undefined,
    interactions: (json.interactions ?? []).map((i) => ({
      with: i.ingredient ?? i.group ?? i.with,
      severity: sev(i.severity),
      mechanism: i.mechanism ?? '',
      advice: i.management ?? i.advice ?? '',
    })),
    maxContinuousDays: json.duration?.maxContinuousDays,
    durationNote: json.duration?.text,
  });
}

/**
 * NZF adapter skeleton. Unconfigured (no baseUrl/apiKey) -> get/prefetch throw
 * NzfNotConfiguredError. Configured -> prefetch() fetches into a cache, get()
 * reads only the cache (undefined = not cached, null = NZF has no monograph).
 */
export function createNzfSource({ baseUrl, apiKey, fetchImpl = globalThis.fetch, version = 'nzf-live', ttlMs = 24 * 3600_000, now = Date.now } = {}) {
  const configured = Boolean(baseUrl && apiKey);
  const cache = new Map(); // ingredient -> { monograph|null, at }
  let contentVersion = version;
  const ensure = () => {
    if (!configured) throw new NzfNotConfiguredError(!baseUrl ? 'baseUrl missing' : 'apiKey missing');
  };
  return {
    kind: 'nzf',
    name: 'New Zealand Formulary',
    get version() { return contentVersion; },
    licensed: configured,
    configured,
    get(ingredient) {
      ensure();
      const hit = cache.get(key(ingredient));
      if (!hit || now() - hit.at > ttlMs) return undefined;
      return hit.monograph;
    },
    /** Async: fill the cache for these medicines (rows with .ingredient, or ingredient strings). */
    async prefetch(medicines = []) {
      ensure();
      const ingredients = [...new Set([].concat(medicines).map((m) => key(typeof m === 'string' ? m : m?.ingredient)).filter(Boolean))];
      const result = { fetched: [], missing: [], errors: [] };
      for (const ing of ingredients) {
        try {
          const res = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/monographs/${encodeURIComponent(ing)}`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          });
          if (res.status === 404) {
            cache.set(ing, { monograph: null, at: now() });
            result.missing.push(ing);
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          if (json?.contentVersion) contentVersion = json.contentVersion;
          cache.set(ing, { monograph: mapNzfResponse({ ingredient: ing, ...json }), at: now() });
          result.fetched.push(ing);
        } catch (err) {
          result.errors.push({ ingredient: ing, error: err.message });
        }
      }
      return result;
    },
    clearCache: () => cache.clear(),
  };
}

// ───────────────────────── history ─────────────────────────

/**
 * rows: [{ ingredient, supplied_at, quantity_supplied, dose_units, doses_per_day, period_days }]
 * -> [{ ingredient, suppliedAt (ISO), daysSupplied }]; rows without a computable duration are skipped.
 */
export function buildHistory(rows = []) {
  const out = [];
  for (const r of rows) {
    const days = supplyDays(r.quantity_supplied, r.dose_units, r.doses_per_day, r.period_days);
    if (!r.ingredient || !r.supplied_at || days == null) continue;
    out.push({ ingredient: key(r.ingredient), suppliedAt: toIso(r.supplied_at), daysSupplied: days });
  }
  return out;
}

function supplyDays(quantity, doseUnits, dosesPerDay, periodDays) {
  const perDay = Number(doseUnits) * Number(dosesPerDay);
  if (Number(quantity) > 0 && perDay > 0) return Math.round((Number(quantity) / perDay) * 10) / 10;
  if (Number(periodDays) > 0) return Number(periodDays);
  return null;
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO -> ISO string. */
function toIso(s) {
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str)) return `${str.replace(' ', 'T')}Z`;
  const t = Date.parse(str);
  return Number.isNaN(t) ? str : new Date(t).toISOString();
}

/**
 * Continuous-therapy days for one ingredient, ending with the new supply.
 * Supplies are chained in date order: each one extends the expected run-out
 * date (early refills stack on top). A supply that starts more than
 * GAP_TOLERANCE_DAYS after the expected run-out breaks the episode.
 */
export function continuousDays(history, ingredient, { now = Date.now(), newDays = 0, gapDays = GAP_TOLERANCE_DAYS } = {}) {
  const ing = key(ingredient);
  const supplies = history
    .filter((h) => key(h.ingredient) === ing && Number(h.daysSupplied) > 0 && !Number.isNaN(Date.parse(h.suppliedAt)))
    .map((h) => ({ at: Date.parse(h.suppliedAt), days: Number(h.daysSupplied) }))
    .filter((s) => s.at <= now)
    .sort((a, b) => a.at - b.at);
  if (newDays > 0) supplies.push({ at: now, days: newDays, isNew: true });
  let start = null;
  let runOut = null;
  let count = 0;
  for (const s of supplies) {
    if (start == null || s.at > runOut + gapDays * DAY_MS) {
      start = s.at;
      runOut = s.at + s.days * DAY_MS;
      count = 1;
    } else {
      runOut = Math.max(runOut, s.at) + s.days * DAY_MS;
      count++;
    }
  }
  if (start == null) return { days: 0, supplies: 0, episodeStart: null, runOut: null };
  return { days: Math.round((runOut - start) / DAY_MS), supplies: count, episodeStart: new Date(start).toISOString(), runOut: new Date(runOut).toISOString() };
}

// ───────────────────────── formulary ─────────────────────────

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * createFormulary({ source }) where source is one source or an ordered
 * fallback chain, e.g. [createNzfSource({...}), createLocalFormularySource()].
 * Defaults to the local demo source.
 */
export function createFormulary({ source, sources, now = () => Date.now() } = {}) {
  const chain = [].concat(sources ?? source ?? createLocalFormularySource()).filter(Boolean);
  if (!chain.length) throw new Error('createFormulary needs at least one source');
  const groups = Object.assign({}, ...chain.map((s) => s.groups ?? {}));

  function lookup(medicine) {
    const ingredient = key(typeof medicine === 'string' ? medicine : medicine?.ingredient);
    if (!ingredient) return null;
    const skipped = [];
    for (const s of chain) {
      let m;
      try {
        m = s.get(ingredient);
      } catch (err) {
        if (err instanceof NzfNotConfiguredError || err.code === 'NZF_NOT_CONFIGURED') {
          skipped.push({ source: s.name, reason: NZF_NOT_CONFIGURED });
          continue;
        }
        skipped.push({ source: s.name, reason: `error: ${err.message}` });
        continue;
      }
      if (m === undefined) {
        skipped.push({ source: s.name, reason: s.kind === 'nzf' ? 'monograph not cached (run prefetch)' : 'not available' });
        continue;
      }
      if (m === null) {
        skipped.push({ source: s.name, reason: 'no monograph' });
        continue;
      }
      return {
        ...m,
        source: { name: s.name, version: s.version, licensed: Boolean(s.licensed) },
        ...(skipped.length ? { fallbackFrom: skipped } : {}),
      };
    }
    return null;
  }

  /** Async: let network-backed sources fill their caches before the sync checks run. */
  async function prefetch(medicines = []) {
    const report = [];
    for (const s of chain) {
      if (typeof s.prefetch !== 'function') continue;
      try {
        report.push({ source: s.name, ...(await s.prefetch(medicines)) });
      } catch (err) {
        report.push({ source: s.name, skipped: true, reason: err.message });
      }
    }
    return report;
  }

  function sourceLabel(mono) {
    const base = `${mono.source.name} ${mono.source.version}${mono.source.licensed ? '' : ' (unlicensed demo data)'}`;
    if (!mono.fallbackFrom?.length) return base;
    return `${base}; fell back from ${mono.fallbackFrom.map((f) => `${f.source}: ${f.reason}`).join('; ')}`;
  }

  /** Does interaction target `target` (ingredient or group name) match this medicine? */
  function matches(target, ingredient, therapeuticClass) {
    const t = key(target);
    if (t === ingredient) return true;
    if (therapeuticClass && t === key(therapeuticClass)) return true;
    return Boolean(groups[t]?.includes(ingredient));
  }

  function check(ctx = {}) {
    const { medicine, item = {}, patient = {}, otherMeds = [], history = [] } = ctx;
    const nowMs = ctx.now != null ? Date.parse(ctx.now) || Number(ctx.now) : now();
    const ingredient = key(medicine?.ingredient);
    const label = medicine?.name ?? cap(ingredient);
    const out = [];
    const mono = lookup(medicine);

    const mk = ({ code, subject, severity, specialist = 'pharma', message, inputs, rule, srcMono = mono }) => ({
      id: `${code}:${subject ?? ''}`.toLowerCase(),
      code,
      severity,
      specialist,
      message,
      origin: 'formulary',
      trace: {
        inputs,
        rule,
        source: srcMono ? sourceLabel(srcMono) : chain.map((s) => `${s.name} ${s.version}`).join(' → '),
        ...(srcMono?.nzfUrl ? { link: srcMono.nzfUrl } : {}),
      },
    });

    if (!mono) {
      out.push(mk({
        code: 'NZF_NOT_FOUND', subject: ingredient, severity: 'info',
        message: `No formulary monograph found for ${label}: formulary dose, renal, interaction and duration checks were not run`,
        inputs: { ingredient, code: medicine?.code ?? null }, rule: 'Monograph lookup across the source chain',
      }));
      return out;
    }

    // ── Dose vs adult maximum ──
    const unitMg = Number(medicine.unit_mg);
    const units = Number(item.dose_units);
    const perDay = Number(item.doses_per_day);
    if (mono.adultMaxDailyMg && unitMg > 0 && units > 0 && perDay > 0) {
      const dailyMg = unitMg * units * perDay;
      if (dailyMg > mono.adultMaxDailyMg) {
        out.push(mk({
          code: 'NZF_DOSE', subject: ingredient, severity: 'hard_stop',
          message: `${label}: ${dailyMg} mg a day is above the ${mono.adultMaxDailyMg} mg adult maximum`,
          inputs: { unitMg, doseUnits: units, dosesPerDay: perDay, dailyMg, adultMaxDailyMg: mono.adultMaxDailyMg, directions: item.directions ?? null },
          rule: `unit mg × units per dose × doses per day > adult maximum daily dose (${mono.adultMaxDailyMg} mg)`,
        }));
      }
    }

    // ── Renal ──
    const egfr = patient.egfr == null ? null : Number(patient.egfr);
    if (egfr != null && Number.isFinite(egfr) && mono.renal.length) {
      const applicable = mono.renal.filter((r) => egfr < r.egfrBelow).sort((a, b) => a.egfrBelow - b.egfrBelow);
      const hit = applicable[0];
      if (hit) {
        const verb = { avoid: 'avoid', reduce: 'reduce the dose', monitor: 'monitor' }[hit.action];
        out.push(mk({
          code: 'NZF_RENAL', subject: ingredient, severity: RENAL_SEVERITY[hit.action],
          message: `${label}: eGFR ${egfr} is below ${hit.egfrBelow}, ${verb}. ${hit.note ?? ''}`.trim(),
          inputs: { egfr, egfrBelow: hit.egfrBelow, action: hit.action, rules: mono.renal.map(({ egfrBelow, action }) => ({ egfrBelow, action })) },
          rule: 'Most restrictive renal rule whose eGFR threshold the patient is below (avoid → hard stop, reduce → high, monitor → moderate)',
        }));
      }
    }

    // ── Hepatic (only when the patient record flags impairment) ──
    if (patient.hepatic_impairment && mono.hepatic?.action && RENAL_SEVERITY[mono.hepatic.action]) {
      out.push(mk({
        code: 'NZF_HEPATIC', subject: ingredient, severity: RENAL_SEVERITY[mono.hepatic.action],
        message: `${label}: liver impairment recorded, ${mono.hepatic.action}. ${mono.hepatic.note ?? ''}`.trim(),
        inputs: { hepaticImpairment: patient.hepatic_impairment, action: mono.hepatic.action },
        rule: 'Hepatic rule applies when the patient record flags liver impairment',
      }));
    }

    // ── Interactions (both directions; keep the most severe per other ingredient) ──
    const best = new Map();
    for (const other of otherMeds) {
      const oi = key(other?.ingredient);
      if (!oi || oi === ingredient) continue; // same-ingredient duplication is screening.js's DUPLICATE rule
      const candidates = [];
      for (const ix of mono.interactions) {
        if (matches(ix.with, oi, other.therapeutic_class)) candidates.push({ ix, via: mono, direction: `${ingredient} monograph` });
      }
      const otherMono = lookup(oi);
      if (otherMono) {
        for (const ix of otherMono.interactions) {
          if (matches(ix.with, ingredient, medicine.therapeutic_class)) candidates.push({ ix, via: otherMono, direction: `${oi} monograph` });
        }
      }
      candidates.sort((a, b) => IX_RANK.indexOf(a.ix.severity) - IX_RANK.indexOf(b.ix.severity));
      const top = candidates[0];
      if (!top) continue;
      const prev = best.get(oi);
      if (!prev || IX_RANK.indexOf(top.ix.severity) < IX_RANK.indexOf(prev.top.ix.severity)) best.set(oi, { top, other });
    }
    for (const [oi, { top, other }] of best) {
      const { ix, via, direction } = top;
      out.push(mk({
        code: 'NZF_INTERACTION', subject: oi, severity: IX_SEVERITY[ix.severity], specialist: 'pharmacology', srcMono: via,
        message: `${cap(ingredient)} + ${other.name ?? oi} (${other.source ?? 'medication list'}): ${ix.severity} interaction. ${ix.mechanism} ${ix.advice}`.replace(/\s+/g, ' ').trim(),
        inputs: { ingredient, other: { ingredient: oi, name: other.name ?? null, source: other.source ?? null }, matchedOn: ix.with, interactionSeverity: ix.severity, foundIn: direction },
        rule: 'Interaction listed in the formulary (contraindicated → hard stop, severe → high, moderate → moderate, mild → info)',
      }));
    }

    // ── Duration of continuous therapy ──
    if (mono.maxContinuousDays) {
      const newDays = ctx.newSupplyDays ?? supplyDays(item.quantity, item.dose_units, item.doses_per_day, item.period_days) ?? 0;
      const run = continuousDays(history, ingredient, { now: nowMs, newDays });
      if (run.days > mono.maxContinuousDays) {
        out.push(mk({
          code: 'NZF_DURATION', subject: ingredient, severity: 'high',
          message: `${cap(ingredient)}: about ${run.days} days of continuous supply (review limit ${mono.maxContinuousDays} days)${mono.durationNote ? `. ${mono.durationNote}` : ''}`,
          inputs: { newSupplyDays: newDays, historySupplies: run.supplies - (newDays > 0 ? 1 : 0), episodeStart: run.episodeStart, expectedRunOut: run.runOut, continuousDays: run.days, maxContinuousDays: mono.maxContinuousDays, gapToleranceDays: GAP_TOLERANCE_DAYS },
          rule: `Chain supplies of the same ingredient; a gap of more than ${GAP_TOLERANCE_DAYS} days past expected run-out breaks the episode; flag when the episode including this supply exceeds the review limit`,
        }));
      }
    }

    return out;
  }

  return {
    lookup,
    check,
    prefetch,
    sources: () => chain.map((s) => ({ name: s.name, version: s.version, licensed: Boolean(s.licensed), configured: s.configured !== false, kind: s.kind ?? 'custom' })),
  };
}

/** Convenience: NZF first if configured via env, then the local demo file. */
export function createDefaultFormulary({ env = process.env, fetchImpl, demoPath } = {}) {
  return createFormulary({
    sources: [
      createNzfSource({ baseUrl: env.NZF_BASE_URL, apiKey: env.NZF_API_KEY, fetchImpl }),
      createLocalFormularySource(demoPath),
    ],
  });
}
