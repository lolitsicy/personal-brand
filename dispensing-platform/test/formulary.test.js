import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFormulary, createLocalFormularySource, createNzfSource, createDefaultFormulary,
  buildHistory, continuousDays, mapNzfResponse, NzfNotConfiguredError, NZF_NOT_CONFIGURED, DEFAULT_DEMO_PATH,
} from '../src/formulary/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-09T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

// Medicine rows shaped like the seed's medicines table.
const MEDS = {
  MET500: { code: 'MET500', name: 'Metformin', ingredient: 'metformin', strength: '500 mg', unit_mg: 500, therapeutic_class: 'biguanide' },
  MTZ400: { code: 'MTZ400', name: 'Metronidazole', ingredient: 'metronidazole', strength: '400 mg', unit_mg: 400, therapeutic_class: 'nitroimidazole' },
  ATO40: { code: 'ATO40', name: 'Atorvastatin', ingredient: 'atorvastatin', strength: '40 mg', unit_mg: 40, therapeutic_class: 'statin' },
  AMX500: { code: 'AMX500', name: 'Amoxicillin', ingredient: 'amoxicillin', strength: '500 mg', unit_mg: 500, therapeutic_class: 'penicillin' },
  OXY5: { code: 'OXY5', name: 'Oxycodone', ingredient: 'oxycodone', strength: '5 mg', unit_mg: 5, therapeutic_class: 'opioid' },
  PAR500: { code: 'PAR500', name: 'Paracetamol', ingredient: 'paracetamol', strength: '500 mg', unit_mg: 500, therapeutic_class: 'analgesic' },
  COD30: { code: 'COD30', name: 'Codeine phosphate', ingredient: 'codeine', strength: '30 mg', unit_mg: 30, therapeutic_class: 'opioid' },
  CLA500: { code: 'CLA500', name: 'Clarithromycin', ingredient: 'clarithromycin', strength: '500 mg', unit_mg: 500, therapeutic_class: 'macrolide' },
  IBU: { code: 'IBU-OTC24', name: 'Ibuprofen 24 pack', ingredient: 'ibuprofen', strength: '200 mg', unit_mg: 200, therapeutic_class: 'nsaid' },
  LOR: { code: 'LOR-OTC30', name: 'Loratadine 30 pack', ingredient: 'loratadine', strength: '10 mg', unit_mg: 10, therapeutic_class: 'antihistamine' },
};
const patient = (over = {}) => ({ egfr: 90, dob: '1980-01-01', allergies: '[]', ...over });
const item = (over = {}) => ({ dose_units: 1, doses_per_day: 2, quantity: 20, directions: 'Take one twice daily', ...over });

const formulary = createFormulary({ now: () => NOW });
const ctx = (med, over = {}) => ({ medicine: MEDS[med], item: item(over.item), patient: patient(over.patient), otherMeds: over.otherMeds ?? [], history: over.history ?? [], now: NOW, ...(over.extra ?? {}) });
const codes = (fs) => fs.map((f) => f.code);
const byCode = (fs, code) => fs.filter((f) => f.code === code);

function assertFindingShape(f) {
  assert.match(f.id, /^[a-z0-9_]+:[^A-Z]*$/, `id lowercase CODE:subject (${f.id})`);
  assert.equal(f.id, `${f.code}:${f.id.split(':').slice(1).join(':')}`.toLowerCase());
  assert.match(f.code, /^NZF_[A-Z_]+$/);
  assert.ok(['hard_stop', 'high', 'moderate', 'info'].includes(f.severity));
  assert.ok(['pharma', 'pharmacology', 'regulatory', 'advocacy'].includes(f.specialist));
  assert.equal(f.origin, 'formulary');
  assert.equal(typeof f.message, 'string');
  assert.ok(f.message.length > 0);
  assert.equal(typeof f.trace, 'object');
  assert.equal(typeof f.trace.inputs, 'object');
  assert.equal(typeof f.trace.rule, 'string');
  assert.equal(typeof f.trace.source, 'string');
  assert.match(f.trace.source, /demo-formulary-2026\.11|New Zealand Formulary/);
  if ('link' in f.trace) assert.match(f.trace.link, /^https:\/\//);
}

describe('demo data', () => {
  const raw = JSON.parse(readFileSync(DEFAULT_DEMO_PATH, 'utf8'));
  test('is labelled as demo data and has every seed ingredient', () => {
    assert.equal(raw._disclaimer, 'DEMO DATA — not clinically validated; replace with licensed NZF/NZULM data');
    for (const m of Object.values(MEDS)) assert.ok(raw.monographs[m.ingredient], `monograph for ${m.ingredient}`);
  });
  test('nzfUrl stays null (no verified public URL pattern)', () => {
    for (const m of Object.values(raw.monographs)) assert.equal(m.nzfUrl, null);
  });
  test('lookup returns the monograph shape with source metadata', () => {
    const m = formulary.lookup(MEDS.OXY5);
    assert.equal(m.ingredient, 'oxycodone');
    assert.equal(m.nzfUrl, null);
    assert.equal(m.adultMaxDailyMg, 80);
    assert.ok(Array.isArray(m.renal) && Array.isArray(m.interactions));
    assert.equal(m.maxContinuousDays, 14);
    assert.deepEqual(m.source, { name: 'Local demo formulary', version: 'demo-formulary-2026.11', licensed: false });
    assert.equal(formulary.lookup({ ingredient: 'unobtainium' }), null);
    assert.equal(formulary.lookup(null), null);
  });
  test('lookup and check are synchronous', () => {
    assert.ok(!(formulary.lookup(MEDS.MET500) instanceof Promise));
    assert.ok(Array.isArray(formulary.check(ctx('MET500'))));
  });
});

describe('dose ceiling', () => {
  test('within the adult maximum: no finding', () => {
    assert.deepEqual(byCode(formulary.check(ctx('PAR500', { item: { dose_units: 2, doses_per_day: 4 } })), 'NZF_DOSE'), []);
  });
  test('above the adult maximum: hard stop with inputs', () => {
    const [f] = byCode(formulary.check(ctx('PAR500', { item: { dose_units: 2, doses_per_day: 5 } })), 'NZF_DOSE');
    assert.equal(f.severity, 'hard_stop');
    assert.equal(f.id, 'nzf_dose:paracetamol');
    assert.equal(f.trace.inputs.dailyMg, 5000);
    assert.equal(f.trace.inputs.adultMaxDailyMg, 4000);
    assertFindingShape(f);
  });
  test('unstructured dose is skipped (screening.js owns DOSE_UNSTRUCTURED)', () => {
    const fs = formulary.check(ctx('PAR500', { item: { dose_units: null, doses_per_day: null, directions: 'as directed' } }));
    assert.deepEqual(byCode(fs, 'NZF_DOSE'), []);
  });
});

describe('renal tiers', () => {
  const renal = (egfr) => byCode(formulary.check(ctx('MET500', { patient: { egfr } })), 'NZF_RENAL');
  test('normal eGFR: none', () => assert.deepEqual(renal(90), []));
  test('monitor tier -> moderate', () => assert.equal(renal(55)[0].severity, 'moderate'));
  test('reduce tier -> high (most restrictive applicable rule wins)', () => {
    const [f] = renal(38);
    assert.equal(f.severity, 'high');
    assert.equal(f.trace.inputs.egfrBelow, 45);
    assert.equal(renal(38).length, 1);
  });
  test('avoid tier -> hard stop', () => {
    const [f] = renal(25);
    assert.equal(f.severity, 'hard_stop');
    assert.equal(f.trace.inputs.action, 'avoid');
    assertFindingShape(f);
  });
  test('threshold is strict (eGFR equal to threshold does not trigger that tier)', () => assert.equal(renal(30)[0].severity, 'high'));
  test('missing eGFR: no renal finding', () => assert.deepEqual(renal(null), []));
  test('ibuprofen avoided in severe renal impairment', () => {
    const [f] = byCode(formulary.check(ctx('IBU', { patient: { egfr: 20 }, item: { dose_units: 1, doses_per_day: 3 } })), 'NZF_RENAL');
    assert.equal(f.severity, 'hard_stop');
  });
  test('hepatic rule only when impairment flagged', () => {
    assert.deepEqual(byCode(formulary.check(ctx('PAR500')), 'NZF_HEPATIC'), []);
    const [f] = byCode(formulary.check(ctx('PAR500', { patient: { hepatic_impairment: 1 } })), 'NZF_HEPATIC');
    assert.equal(f.severity, 'high');
  });
});

describe('interactions', () => {
  const ix = (med, other) => byCode(formulary.check(ctx(med, { otherMeds: [{ source: 'test', ...other }] })), 'NZF_INTERACTION');
  test('contraindicated -> hard stop (clarithromycin + simvastatin)', () => {
    const [f] = ix('CLA500', { ingredient: 'simvastatin', name: 'Simvastatin 40 mg' });
    assert.equal(f.severity, 'hard_stop');
    assert.equal(f.id, 'nzf_interaction:simvastatin');
    assert.equal(f.specialist, 'pharmacology');
    assertFindingShape(f);
  });
  test('severe -> high (atorvastatin + clarithromycin)', () => {
    const [f] = ix('ATO40', { ingredient: 'clarithromycin', name: 'Clarithromycin 500 mg', therapeutic_class: 'macrolide' });
    assert.equal(f.severity, 'high');
    assert.equal(f.trace.inputs.interactionSeverity, 'severe');
  });
  test('moderate -> moderate (metronidazole + alcohol)', () => {
    const [f] = ix('MTZ400', { ingredient: 'alcohol', name: 'Alcohol' });
    assert.equal(f.severity, 'moderate');
    assert.match(f.message, /48 hours/);
  });
  test('mild -> info (loratadine + clarithromycin)', () => {
    assert.equal(ix('LOR', { ingredient: 'clarithromycin' })[0].severity, 'info');
  });
  test('group match: oxycodone + diazepam (benzodiazepine) -> high', () => {
    const [f] = ix('OXY5', { ingredient: 'diazepam', name: 'Diazepam 5 mg' });
    assert.equal(f.severity, 'high');
    assert.equal(f.trace.inputs.matchedOn, 'benzodiazepine');
  });
  test('codeine + lorazepam -> high', () => assert.equal(ix('COD30', { ingredient: 'lorazepam' })[0].severity, 'high'));
  test('class match: oxycodone + codeine (opioid) -> high', () => assert.equal(ix('OXY5', { ingredient: 'codeine', therapeutic_class: 'opioid' })[0].severity, 'high'));
  test('reverse direction found from the other monograph (clarithromycin new, atorvastatin on list)', () => {
    const [f] = ix('CLA500', { ingredient: 'atorvastatin' });
    assert.equal(f.severity, 'high');
  });
  test('most severe of both directions wins (oxycodone + clarithromycin: moderate either way)', () => {
    const fs = ix('OXY5', { ingredient: 'clarithromycin' });
    assert.equal(fs.length, 1);
    assert.equal(fs[0].severity, 'moderate');
  });
  test('ibuprofen + ACE inhibitor -> moderate; + warfarin -> high', () => {
    assert.equal(ix('IBU', { ingredient: 'cilazapril' })[0].severity, 'moderate');
    assert.equal(ix('IBU', { ingredient: 'warfarin' })[0].severity, 'high');
  });
  test('same ingredient and unrelated medicines are ignored', () => {
    assert.deepEqual(ix('MET500', { ingredient: 'metformin' }), []);
    assert.deepEqual(ix('MET500', { ingredient: 'loratadine' }), []);
  });
  test('one finding per other medicine across a list', () => {
    const fs = byCode(formulary.check(ctx('OXY5', { otherMeds: [{ ingredient: 'diazepam' }, { ingredient: 'pregabalin' }, { ingredient: 'loratadine' }] })), 'NZF_INTERACTION');
    assert.deepEqual(fs.map((f) => f.id).sort(), ['nzf_interaction:diazepam', 'nzf_interaction:pregabalin']);
  });
});

describe('duration', () => {
  test('continuous supplies chain and include the new supply', () => {
    // 10 days supplied 20 days ago, 10 days supplied 10 days ago, new 14 days now -> 34 days.
    const history = [
      { ingredient: 'oxycodone', suppliedAt: daysAgo(20), daysSupplied: 10 },
      { ingredient: 'oxycodone', suppliedAt: daysAgo(10), daysSupplied: 10 },
    ];
    const fs = formulary.check(ctx('OXY5', { history, item: { quantity: 28, dose_units: 1, doses_per_day: 2 } }));
    const [f] = byCode(fs, 'NZF_DURATION');
    assert.equal(f.severity, 'high');
    assert.match(f.message, /^Oxycodone: about 34 days of continuous supply \(review limit 14 days\)/);
    assert.equal(f.trace.inputs.continuousDays, 34);
    assert.equal(f.trace.inputs.newSupplyDays, 14);
    assertFindingShape(f);
  });
  test('gap of more than 7 days beyond run-out breaks the episode', () => {
    // 10-day supply 30 days ago ran out 20 days ago -> gap 20 days > 7 -> break.
    const history = [{ ingredient: 'oxycodone', suppliedAt: daysAgo(30), daysSupplied: 10 }];
    assert.deepEqual(byCode(formulary.check(ctx('OXY5', { history })), 'NZF_DURATION'), []);
    assert.equal(continuousDays(history, 'oxycodone', { now: NOW, newDays: 10 }).days, 10);
  });
  test('gap within the 7-day tolerance does not break it', () => {
    // ran out 5 days ago (supplied 15 days ago, 10 days) -> continues: 15 + 10 = 25.
    const r = continuousDays([{ ingredient: 'oxycodone', suppliedAt: daysAgo(15), daysSupplied: 10 }], 'oxycodone', { now: NOW, newDays: 10 });
    assert.equal(r.days, 25);
    assert.equal(r.supplies, 2);
  });
  test('early refill stacks onto the remaining supply', () => {
    const r = continuousDays([{ ingredient: 'codeine', suppliedAt: daysAgo(5), daysSupplied: 10 }], 'codeine', { now: NOW, newDays: 10 });
    assert.equal(r.days, 20);
  });
  test('only the same ingredient counts; future-dated and zero-day rows ignored', () => {
    const history = [
      { ingredient: 'codeine', suppliedAt: daysAgo(10), daysSupplied: 10 },
      { ingredient: 'oxycodone', suppliedAt: daysAgo(10), daysSupplied: 0 },
      { ingredient: 'oxycodone', suppliedAt: new Date(NOW + 3 * DAY).toISOString(), daysSupplied: 30 },
    ];
    assert.equal(continuousDays(history, 'oxycodone', { now: NOW, newDays: 10 }).days, 10);
  });
  test('antibiotic course limit (amoxicillin)', () => {
    const newCourse = { item: { quantity: 21, dose_units: 1, doses_per_day: 3 } }; // 7 days
    const atLimit = [{ ingredient: 'amoxicillin', suppliedAt: daysAgo(7), daysSupplied: 7 }]; // 7 + 7 = 14, not > 14
    assert.deepEqual(byCode(formulary.check(ctx('AMX500', { history: atLimit, ...newCourse })), 'NZF_DURATION'), []);
    const over = [{ ingredient: 'amoxicillin', suppliedAt: daysAgo(8), daysSupplied: 8 }]; // 8 + 7 = 15
    const [f] = byCode(formulary.check(ctx('AMX500', { history: over, ...newCourse })), 'NZF_DURATION');
    assert.equal(f.severity, 'high');
    assert.match(f.message, /^Amoxicillin: about 15 days of continuous supply \(review limit 14 days\)/);
  });
  test('no maxContinuousDays -> never flagged', () => {
    const history = [{ ingredient: 'paracetamol', suppliedAt: daysAgo(90), daysSupplied: 100 }];
    assert.deepEqual(byCode(formulary.check(ctx('PAR500', { history })), 'NZF_DURATION'), []);
  });
  test('newSupplyDays override and period_days fallback', () => {
    const history = [{ ingredient: 'ibuprofen', suppliedAt: daysAgo(6), daysSupplied: 6 }];
    const [f] = byCode(formulary.check(ctx('IBU', { history, item: { dose_units: null, doses_per_day: null, period_days: 7 } })), 'NZF_DURATION');
    assert.equal(f.trace.inputs.continuousDays, 13);
    const [g] = byCode(formulary.check(ctx('IBU', { history, extra: { newSupplyDays: 2 } })), 'NZF_DURATION');
    assert.equal(g, undefined);
  });
});

describe('buildHistory', () => {
  test('quantity / (dose_units × doses_per_day), else period_days, else skipped', () => {
    const h = buildHistory([
      { ingredient: 'Oxycodone', supplied_at: '2026-10-20 09:00:00', quantity_supplied: 20, dose_units: 1, doses_per_day: 2, period_days: 30 },
      { ingredient: 'codeine', supplied_at: '2026-10-21T09:00:00Z', quantity_supplied: 20, dose_units: null, doses_per_day: null, period_days: 30 },
      { ingredient: 'paracetamol', supplied_at: '2026-10-22 09:00:00', quantity_supplied: 20, dose_units: null, doses_per_day: null, period_days: null },
      { ingredient: 'metformin', supplied_at: null, quantity_supplied: 20, dose_units: 1, doses_per_day: 1 },
    ]);
    assert.deepEqual(h, [
      { ingredient: 'oxycodone', suppliedAt: '2026-10-20T09:00:00Z', daysSupplied: 10 },
      { ingredient: 'codeine', suppliedAt: '2026-10-21T09:00:00.000Z', daysSupplied: 30 },
    ]);
  });
});

describe('not found', () => {
  test('missing monograph -> exactly one info NZF_NOT_FOUND', () => {
    const fs = formulary.check({ medicine: { code: 'XYZ', name: 'Mystery', ingredient: 'mysterium', unit_mg: 1 }, item: item(), patient: patient(), otherMeds: [{ ingredient: 'diazepam' }], history: [] });
    assert.equal(fs.length, 1);
    assert.equal(fs[0].code, 'NZF_NOT_FOUND');
    assert.equal(fs[0].severity, 'info');
    assert.equal(fs[0].id, 'nzf_not_found:mysterium');
    assertFindingShape(fs[0]);
  });
});

describe('NZF source', () => {
  test('unconfigured source throws a clear error on use', () => {
    const nzf = createNzfSource({});
    assert.equal(nzf.configured, false);
    assert.throws(() => nzf.get('oxycodone'), (e) => e instanceof NzfNotConfiguredError && e.message.includes(NZF_NOT_CONFIGURED));
    return assert.rejects(nzf.prefetch(['oxycodone']), NzfNotConfiguredError);
  });
  test('unconfigured NZF in the chain falls back to local demo and says so', async () => {
    const f = createDefaultFormulary({ env: {} });
    const m = f.lookup(MEDS.OXY5);
    assert.equal(m.source.name, 'Local demo formulary');
    assert.deepEqual(m.fallbackFrom, [{ source: 'New Zealand Formulary', reason: NZF_NOT_CONFIGURED }]);
    const [finding] = byCode(f.check(ctx('OXY5', { otherMeds: [{ ingredient: 'diazepam' }] })), 'NZF_INTERACTION');
    assert.match(finding.trace.source, /Local demo formulary demo-formulary-2026\.11/);
    assert.match(finding.trace.source, /fell back from New Zealand Formulary: NZF data licence\/API not configured/);
    const report = await f.prefetch([MEDS.OXY5]);
    assert.equal(report[0].skipped, true);
    assert.deepEqual(f.sources().map((s) => s.configured), [false, true]);
  });
  test('configured: prefetch fills cache via injected fetch; NZF answers; uncached falls back', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization });
      if (url.endsWith('/oxycodone')) {
        return { ok: true, status: 200, json: async () => ({
          contentVersion: 'nzf-2026-11', url: 'https://example.invalid/nzf/oxycodone',
          dosing: { adultMaxDailyMg: 60 },
          renal: [{ egfrBelow: 50, action: 'reduce', text: 'Reduce.' }],
          interactions: [{ group: 'benzodiazepine', severity: 'major', mechanism: 'CNS depression.', management: 'Avoid.' }],
          duration: { maxContinuousDays: 7, text: 'Review at a week.' },
        }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const nzf = createNzfSource({ baseUrl: 'https://nzf.example.invalid/api/', apiKey: 'k', fetchImpl });
    const f = createFormulary({ sources: [nzf, createLocalFormularySource()] });
    assert.equal(f.lookup(MEDS.OXY5).source.name, 'Local demo formulary'); // not prefetched yet
    assert.equal(f.lookup(MEDS.OXY5).fallbackFrom[0].reason, 'monograph not cached (run prefetch)');
    const report = await f.prefetch([MEDS.OXY5, MEDS.PAR500, 'oxycodone']);
    assert.deepEqual(report[0].fetched, ['oxycodone']);
    assert.deepEqual(report[0].missing, ['paracetamol']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://nzf.example.invalid/api/monographs/oxycodone');
    assert.equal(calls[0].auth, 'Bearer k');
    const m = f.lookup(MEDS.OXY5);
    assert.deepEqual(m.source, { name: 'New Zealand Formulary', version: 'nzf-2026-11', licensed: true });
    assert.equal(m.adultMaxDailyMg, 60);
    assert.equal(m.interactions[0].severity, 'severe');
    // NZF said "no monograph" for paracetamol -> local answers, noted.
    assert.equal(f.lookup(MEDS.PAR500).fallbackFrom[0].reason, 'no monograph');
    const fs = f.check(ctx('OXY5', { otherMeds: [{ ingredient: 'diazepam' }], patient: { egfr: 40 }, item: { dose_units: 4, doses_per_day: 4 } }));
    const ixf = byCode(fs, 'NZF_INTERACTION')[0];
    assert.equal(ixf.severity, 'high');
    assert.equal(ixf.trace.link, 'https://example.invalid/nzf/oxycodone');
    assert.match(ixf.trace.source, /^New Zealand Formulary nzf-2026-11$/);
    assert.equal(byCode(fs, 'NZF_DOSE')[0].severity, 'hard_stop'); // 80 > 60
    assert.equal(byCode(fs, 'NZF_RENAL')[0].severity, 'high');
    fs.forEach(assertFindingShape);
  });
  test('fetch errors are reported, not thrown', async () => {
    const nzf = createNzfSource({ baseUrl: 'https://x.invalid', apiKey: 'k', fetchImpl: async () => { throw new Error('offline'); } });
    const r = await nzf.prefetch(['oxycodone']);
    assert.deepEqual(r.errors, [{ ingredient: 'oxycodone', error: 'offline' }]);
    assert.equal(nzf.get('oxycodone'), undefined);
  });
  test('mapNzfResponse maps severities conservatively', () => {
    const m = mapNzfResponse({ ingredient: 'X', interactions: [
      { ingredient: 'a', severity: 'contraindication' }, { ingredient: 'b', severity: 'minor' }, { ingredient: 'c', severity: 'weird' },
    ] });
    assert.deepEqual(m.interactions.map((i) => i.severity), ['contraindicated', 'mild', 'moderate']);
    assert.equal(mapNzfResponse(null), null);
  });
});

describe('local source', () => {
  test('loads an alternative JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nzf-'));
    const p = join(dir, 'f.json');
    writeFileSync(p, JSON.stringify({ name: 'Custom', version: 'v1', monographs: { foo: { adultMaxDailyMg: 10, interactions: [{ with: 'bar', severity: 'mild' }] } } }));
    const f = createFormulary({ source: createLocalFormularySource(p) });
    assert.equal(f.lookup({ ingredient: 'FOO' }).source.version, 'v1');
    const fs = f.check({ medicine: { ingredient: 'foo', name: 'Foo', unit_mg: 20 }, item: { dose_units: 1, doses_per_day: 1 }, patient: {}, otherMeds: [{ ingredient: 'bar' }] });
    assert.deepEqual(codes(fs).sort(), ['NZF_DOSE', 'NZF_INTERACTION']);
  });
});

describe('seed scenario (Aroha: metformin + atorvastatin, eGFR 38, clarithromycin from history)', () => {
  test('all findings valid; renal high on metformin, severe interaction on atorvastatin', () => {
    const other = [{ ingredient: 'clarithromycin', name: 'Clarithromycin 500 mg', therapeutic_class: 'macrolide', source: 'filled at another pharmacy (history)' }];
    const met = formulary.check(ctx('MET500', { patient: { egfr: 38, dob: '1958-03-14' }, otherMeds: other }));
    const ato = formulary.check(ctx('ATO40', { patient: { egfr: 38, dob: '1958-03-14' }, otherMeds: other, item: { dose_units: 1, doses_per_day: 1 } }));
    assert.deepEqual(codes(met), ['NZF_RENAL']);
    assert.equal(met[0].severity, 'high');
    assert.deepEqual(codes(ato), ['NZF_INTERACTION']);
    [...met, ...ato].forEach(assertFindingShape);
  });
});
