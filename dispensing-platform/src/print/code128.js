// Code 128 barcode encoder (subsets B and C) rendering to SVG.
//
// Symbol values 0..102 are data/function codes, 103/104/105 are Start A/B/C
// and 106 is Stop. Each pattern lists alternating bar/space widths in modules,
// starting with a bar: 6 elements summing to 11 modules (Stop: 7 elements, 13).
// Checksum = (start value + Σ value_i × position_i) mod 103, positions from 1.

export const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const START_C = 105;
export const CODE_B = 100; // switch to subset B (from C)
export const CODE_C = 99; // switch to subset C (from B)
export const STOP = 106;
export const QUIET_ZONE = 10; // modules each side (ISO/IEC 15417 minimum)

const isDigit = (c) => c >= '0' && c <= '9';

function digitRun(text, i) {
  let n = 0;
  while (i + n < text.length && isDigit(text[i + n])) n++;
  return n;
}

/** Throws unless `text` is a non-empty string of printable ASCII (0x20–0x7E). */
export function validateCode128(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('Code 128: text must be a non-empty string');
  if (text.length > 80) throw new RangeError('Code 128: text longer than 80 characters');
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c > 0x7e) throw new RangeError(`Code 128: unsupported character U+${c.toString(16).toUpperCase().padStart(4, '0')} (printable ASCII only)`);
  }
  return text;
}

/**
 * Encode text into symbol values. With `optimise` (default) long digit runs are
 * packed two-per-symbol in subset C: a run of ≥4 digits at the start or end, or
 * ≥6 in the middle (shorter runs cost more in switch codes than they save).
 * Returns { values: [start, ...data, checksum, stop], checksum, modules }.
 */
export function encodeCode128(text, { optimise = true } = {}) {
  validateCode128(text);
  const data = [];
  let set = null;
  let i = 0;
  while (i < text.length) {
    const run = optimise ? digitRun(text, i) : 0;
    const atStart = i === 0;
    const atEnd = i + run === text.length;
    const worthC = run >= 2 && (atStart && atEnd ? run % 2 === 0 || run >= 4 : atStart || atEnd ? run >= 4 : run >= 6);
    if (set !== 'C' && worthC) {
      // An odd run: the first digit goes in B so the rest pairs up in C.
      if (run % 2 === 1) {
        if (set === null) { data.push(START_B); set = 'B'; }
        data.push(text.charCodeAt(i) - 32);
        i++;
      }
      data.push(set === null ? START_C : CODE_C);
      set = 'C';
      const end = i + (run - (run % 2 === 1 ? 1 : 0));
      for (; i < end; i += 2) data.push(Number(text.slice(i, i + 2)));
      continue;
    }
    if (set !== 'B') { data.push(set === null ? START_B : CODE_B); set = 'B'; }
    data.push(text.charCodeAt(i) - 32);
    i++;
  }
  const checksum = data.reduce((sum, v, pos) => sum + v * (pos === 0 ? 1 : pos), 0) % 103;
  const values = [...data, checksum, STOP];
  // Stop (106) is 7 elements / 13 modules and already ends with the 2-module termination bar.
  return { values, checksum, modules: widthsToBits(values.map((v) => PATTERNS[v]).join('')) };
}

// '2112' → '1101' style bit string (1 = bar), alternating from a bar.
function widthsToBits(widths) {
  let out = '';
  for (let k = 0; k < widths.length; k++) out += (k % 2 === 0 ? '1' : '0').repeat(Number(widths[k]));
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Render a Code 128 barcode as a standalone inline SVG string.
 * Options: module (px or user units per module, default 2), height (bar height,
 * default 60), text (show human-readable line, default true), fontSize, unit
 * (CSS unit for width/height attributes, default 'px'), label (aria label).
 */
export function code128Svg(text, { module = 2, height = 60, text: showText = true, fontSize, unit = 'px', optimise = true, label } = {}) {
  const { modules, values } = encodeCode128(text, { optimise });
  const totalModules = modules.length + QUIET_ZONE * 2;
  const fs = fontSize ?? Math.max(10, Math.round(module * 7));
  const textGap = showText ? Math.round(fs * 0.4) + fs : 0;
  const w = totalModules * module;
  const h = height + textGap;
  const rects = [];
  for (let k = 0; k < modules.length;) {
    if (modules[k] === '1') {
      let n = 1;
      while (modules[k + n] === '1') n++;
      rects.push(`<rect x="${(QUIET_ZONE + k) * module}" y="0" width="${n * module}" height="${height}"/>`);
      k += n;
    } else k++;
  }
  const caption = showText
    ? `<text x="${w / 2}" y="${height + textGap - Math.round(fs * 0.15)}" text-anchor="middle" font-family="ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, monospace" font-size="${fs}" letter-spacing="1">${esc(text)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="code128" role="img" aria-label="${esc(label ?? `Barcode ${text}`)}" data-code128="${esc(text)}" data-symbols="${values.join(' ')}" width="${w}${unit}" height="${h}${unit}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#fff"/><g fill="#000">${rects.join('')}</g>${caption}</svg>`;
}
