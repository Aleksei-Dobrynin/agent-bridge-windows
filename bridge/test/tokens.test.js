'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/tokens');
const { originAllowed } = require('../lib/origin');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'owner.token');
}

test('owner token: created once, stable, rotatable', (t) => {
  const f = tmpFile(t);
  const a = T.loadOrCreateOwnerToken(f);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(T.loadOrCreateOwnerToken(f), a);
  const b = T.rotateOwnerToken(f);
  assert.notStrictEqual(a, b);
  assert.strictEqual(T.loadOrCreateOwnerToken(f), b);
});

test('owner token: garbage in file is replaced', (t) => {
  const f = tmpFile(t);
  fs.writeFileSync(f, 'not-a-token');
  assert.match(T.loadOrCreateOwnerToken(f), /^[0-9a-f]{64}$/);
});

test('owner token: uppercase hex is normalized, not rotated', (t) => {
  const f = tmpFile(t);
  const up = 'AB'.repeat(32);
  fs.writeFileSync(f, up + '\n');
  assert.strictEqual(T.loadOrCreateOwnerToken(f), up.toLowerCase());
});

test('owner token: non-ENOENT read errors are rethrown, not rotated', (t) => {
  const f = tmpFile(t);
  fs.mkdirSync(f); // чтение каталога как файла -> EISDIR
  assert.throws(() => T.loadOrCreateOwnerToken(f), (e) => e.code === 'EISDIR');
});

test('safeEq', () => {
  assert.ok(T.safeEq('abc', 'abc'));
  assert.strictEqual(T.safeEq('abc', 'abd'), false);
  assert.strictEqual(T.safeEq('abc', 'abcd'), false);
  assert.strictEqual(T.safeEq(undefined, 'x'), false);
});

test('one-time tokens: single use and expiry (injected clock)', () => {
  let now = 1000;
  const o = new T.OneTimeTokens(50, () => now);
  const t = o.issue();
  assert.ok(o.consume(t));
  assert.strictEqual(o.consume(t), false);
  const t2 = o.issue();
  now += 80;
  assert.strictEqual(o.consume(t2), false);
  assert.strictEqual(o.consume(123), false);
});

test('one-time tokens: several issued, a non-first one is consumable; issue purges expired', () => {
  let now = 0;
  const o = new T.OneTimeTokens(100, () => now);
  const a = o.issue(); const b = o.issue(); const c = o.issue();
  assert.ok(o.consume(b));
  assert.ok(o.consume(c));
  assert.ok(o.consume(a));
  const old = o.issue();
  now += 500;
  o.issue();
  assert.strictEqual(o.map.size, 1, 'expired entry purged on issue');
  assert.strictEqual(o.consume(old), false);
});

test('origin allowlist', () => {
  assert.ok(originAllowed(undefined, 8790));
  assert.ok(originAllowed('https://127.0.0.1:8790', 8790));
  assert.ok(originAllowed('https://localhost:8790', 8790));
  assert.ok(originAllowed('http://127.0.0.1:38471', 8790));
  for (const bad of ['null', 'https://evil.example', 'https://127.0.0.1:8791', 'http://127.0.0.1:8790', '']) {
    assert.strictEqual(originAllowed(bad, 8790), false, bad);
  }
});
