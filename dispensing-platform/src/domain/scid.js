// NZePS Script ID (SCID) handling.
//
// Per Health NZ's public guidance: an SCID is 18 characters, the 18th being a
// check character over the first 17, and the letters I and O are never used
// (they should be read as 1 and 0).
//
// ASSUMPTION: the check character is computed with ISO/IEC 7064 MOD 37-2 over
// the alphabet 0-9, A-Z, '*'. Confirm against the NZePS technical specification
// from Health NZ before relying on this in production; the algorithm is isolated
// here so it can be swapped without touching anything else.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*';
export const SCID_LENGTH = 18;

export class ScidError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_SCID';
    this.status = 400;
  }
}

/** Uppercase, strip separators/whitespace, map I->1 and O->0. */
export function normaliseScid(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/I/g, '1')
    .replace(/O/g, '0');
}

function valueOf(ch) {
  const v = ALPHABET.indexOf(ch);
  if (v < 0) throw new ScidError(`Invalid character "${ch}" in SCID`);
  return v;
}

/** Compute the ISO 7064 MOD 37-2 check character for a 17-char body. */
export function computeCheckChar(body) {
  let p = 0;
  for (const ch of body) p = ((p + valueOf(ch)) * 2) % 37;
  return ALPHABET[(38 - p) % 37];
}

/** Returns { valid, scid, error } without throwing. */
export function validateScid(raw) {
  const scid = normaliseScid(raw);
  if (scid.length !== SCID_LENGTH) {
    return { valid: false, scid, error: `SCID must be ${SCID_LENGTH} characters (got ${scid.length})` };
  }
  try {
    const expected = computeCheckChar(scid.slice(0, 17));
    if (expected !== scid[17]) {
      return { valid: false, scid, error: 'SCID check character does not match — re-scan or re-key' };
    }
  } catch (err) {
    return { valid: false, scid, error: err.message };
  }
  return { valid: true, scid, error: null };
}

export function assertScid(raw) {
  const r = validateScid(raw);
  if (!r.valid) throw new ScidError(r.error);
  return r.scid;
}

/** Build a valid SCID from a 17-char body (used by the mock broker and tests). */
export function makeScid(body) {
  const b = normaliseScid(body);
  if (b.length !== 17) throw new ScidError('SCID body must be 17 characters');
  return b + computeCheckChar(b);
}
