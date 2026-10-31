'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Confirmations, confirmView } = require('../lib/confirmations');

test('request / resolve / one pending per action', () => {
  let t = 1000;
  const c = new Confirmations({ ttlMs: 100, now: () => t });
  const runs = [];
  const e = c.request('pairinfo', 'WS', () => runs.push('p'));
  assert.match(e.confirmId, /^cf_[0-9a-f]{16}$/);
  assert.strictEqual(e.requester, 'WS');
  assert.match(e.message, /код сопряжения/);
  assert.strictEqual(c.request('pairinfo', 'WS2', () => {}), null, 'already pending');
  assert.ok(c.request('setInternet', 'WS', () => {}), 'other action independent');
  assert.strictEqual(c.resolve('cf_nope'), null);
  assert.strictEqual(c.resolve(42), null);
  const got = c.resolve(e.confirmId);
  got.run();
  assert.deepStrictEqual(runs, ['p']);
  assert.strictEqual(c.resolve(e.confirmId), null, 'single use');
  assert.throws(() => c.request('rm-rf', 'WS', () => {}), /unknown/);
});

test('expiry: sweep returns expired, resolve ignores them', () => {
  let t = 0;
  const c = new Confirmations({ ttlMs: 100, now: () => t });
  const e = c.request('setInternet', 'WS', () => {});
  t = 150;
  assert.strictEqual(c.resolve(e.confirmId), null);
  assert.deepStrictEqual(c.sweep().map((x) => x.confirmId), [e.confirmId]);
  assert.deepStrictEqual(c.list(), []);
  assert.ok(c.request('setInternet', 'WS', () => {}), 'new request after expiry');
});

test('confirmView exposes no requester or run', () => {
  const c = new Confirmations({ ttlMs: 100, now: () => 5 });
  const e = c.request('pairinfo', 'WS', () => {});
  assert.deepStrictEqual(confirmView(e), {
    type: 'confirmRequest', confirmId: e.confirmId, action: 'pairinfo', message: e.message, checkCode: e.checkCode,
    at: 5, expiresAt: 105,
  });
});

test('D-22.3: random 4-digit check code per request', () => {
  const c = new Confirmations({ ttlMs: 100, now: () => 0 });
  const codes = new Set();
  for (let i = 0; i < 40; i++) {
    const e = c.request('pairinfo', 'WS', () => {});
    assert.match(e.checkCode, /^\d{4}$/);
    codes.add(e.checkCode);
    c.resolve(e.confirmId);
  }
  assert.ok(codes.size > 1, 'codes vary');
});

test('D-22.3: cooldown after reject/expiry — 1 min doubling to 15 min, reset after approval, per action', () => {
  let t = 0;
  const c = new Confirmations({ ttlMs: 100, now: () => t });
  assert.strictEqual(c.cooldownMs('pairinfo'), 0);
  c.noteOutcome('pairinfo', false);
  assert.strictEqual(c.cooldownMs('pairinfo'), 60000);
  assert.strictEqual(c.cooldownMs('setInternet'), 0, 'other action independent');
  t += 30000;
  assert.strictEqual(c.cooldownMs('pairinfo'), 30000);
  t += 30000;
  assert.strictEqual(c.cooldownMs('pairinfo'), 0);
  const steps = [];
  for (let i = 0; i < 6; i++) { c.noteOutcome('pairinfo', false); steps.push(c.cooldownMs('pairinfo')); t += steps[i]; }
  assert.deepStrictEqual(steps, [120000, 240000, 480000, 900000, 900000, 900000]);
  c.noteOutcome('pairinfo', true);
  assert.strictEqual(c.cooldownMs('pairinfo'), 0);
  c.noteOutcome('pairinfo', false);
  assert.strictEqual(c.cooldownMs('pairinfo'), 60000, 'reset to 1 min after approval');
  const short = new Confirmations({ cooldownMs: 10, maxCooldownMs: 25, now: () => t });
  short.noteOutcome('x', false); short.noteOutcome('x', false); short.noteOutcome('x', false);
  assert.strictEqual(short.cooldownMs('x'), 25);
});

test('I-2: cancelByRequester removes only the requester’s pending confirmations', () => {
  const c = new Confirmations({ ttlMs: 100, now: () => 0 });
  const a = {};
  const b = {};
  const e1 = c.request('pairinfo', a, () => {});
  const e2 = c.request('setInternet', b, () => {});
  assert.deepStrictEqual(c.cancelByRequester(a).map((x) => x.confirmId), [e1.confirmId]);
  assert.deepStrictEqual(c.list().map((x) => x.confirmId), [e2.confirmId]);
  assert.strictEqual(c.resolve(e1.confirmId), null);
  assert.deepStrictEqual(c.cancelByRequester(a), []);
  assert.ok(c.request('pairinfo', b, () => {}), 'slot free again');
});
