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
    type: 'confirmRequest', confirmId: e.confirmId, action: 'pairinfo', message: e.message, at: 5, expiresAt: 105,
  });
});
