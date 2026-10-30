'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/validate');

test('wsMessage: only objects with string type', () => {
  assert.strictEqual(V.wsMessage(null), null);
  assert.strictEqual(V.wsMessage(5), null);
  assert.strictEqual(V.wsMessage({ type: 1 }), null);
  assert.deepStrictEqual(V.wsMessage({ type: 'list' }), { type: 'list' });
});

test('str / int / sessionId / nodeId', () => {
  assert.strictEqual(V.str(5), null);
  assert.strictEqual(V.str('a'.repeat(10), 5), null);
  assert.strictEqual(V.str('abc', 5), 'abc');
  assert.strictEqual(V.int('5', 1, 10), null);
  assert.strictEqual(V.int(5, 1, 10), 5);
  assert.strictEqual(V.int(50, 1, 10), null);
  assert.strictEqual(V.sessionId('s12-a1b2c3'), 's12-a1b2c3');
  assert.strictEqual(V.sessionId('../x'), null);
  assert.strictEqual(V.nodeId('A'.repeat(64)), 'a'.repeat(64));
  assert.strictEqual(V.nodeId(7), null);
});

test('cleanTitle strips control chars and limits length', () => {
  assert.strictEqual(V.cleanTitle('\x1b[2Jhi\x07'), '[2Jhi');
  assert.strictEqual(V.cleanTitle(5), null);
  assert.strictEqual(V.cleanTitle('x'.repeat(200)).length, 120);
});

test('pairBody', () => {
  assert.strictEqual(V.pairBody(null), null);
  assert.strictEqual(V.pairBody({ code: 1 }), null);
  assert.deepStrictEqual(V.pairBody({ code: 'ab12', name: 'Phone' }), { code: 'AB12', name: 'Phone' });
});

test('cookieToken accepts only 64/48 hex', () => {
  assert.strictEqual(V.cookieToken('x;Domain=evil'), null);
  assert.strictEqual(V.cookieToken('a'.repeat(48)), 'a'.repeat(48));
});
