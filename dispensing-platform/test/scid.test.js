import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScid, makeScid, normaliseScid } from '../src/domain/scid.js';

test('makeScid produces an 18-char SCID that validates', () => {
  const scid = makeScid('1A2B3C4D5E6F7G8H9');
  assert.equal(scid.length, 18);
  assert.equal(validateScid(scid).valid, true);
});

test('a single-character typo is caught by the check character', () => {
  const scid = makeScid('1A2B3C4D5E6F7G8H9');
  const typo = (scid[0] === '2' ? '3' : '2') + scid.slice(1);
  assert.equal(validateScid(typo).valid, false);
});

test('adjacent transposition is caught', () => {
  const scid = makeScid('1A2B3C4D5E6F7G8H9');
  const swapped = scid[1] + scid[0] + scid.slice(2);
  assert.equal(validateScid(swapped).valid, false);
});

test('I and O are read as 1 and 0; separators and case are ignored', () => {
  assert.equal(normaliseScid(' io-ab cd '), '10ABCD');
  const scid = makeScid('1A2B3C4D5E6F7G8H9');
  const keyed = scid.toLowerCase().replace(/1/g, 'i').replace(/0/g, 'o').replace(/(.{6})/g, '$1-');
  assert.equal(validateScid(keyed).valid, true);
});

test('wrong length is rejected with a clear message', () => {
  const r = validateScid('ABC');
  assert.equal(r.valid, false);
  assert.match(r.error, /18 characters/);
});
