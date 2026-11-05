'use strict';
// D-30: повторное сопряжение того же p2p-узла перевыпускает токен, а не плодит устройства.
const test = require('node:test');
const assert = require('node:assert');
const { upsertDevice } = require('../lib/pairings');

const at = '2026-11-05T10:00:00.000Z';
const hash = (c) => c.repeat(64);

test('новое устройство добавляется', () => {
  const devices = [];
  const r = upsertDevice(devices, { tokenHash: hash('a'), name: 'home laptop', nodeId: 'b'.repeat(64), at });
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].nodeId, 'b'.repeat(64));
  assert.strictEqual(devices[0].id, hash('a').slice(0, 12));
});

test('тот же nodeId — перевыпуск токена без дубликата', () => {
  const devices = [];
  const nid = 'b'.repeat(64);
  upsertDevice(devices, { tokenHash: hash('a'), name: 'home laptop', nodeId: nid, at });
  const r = upsertDevice(devices, { tokenHash: hash('c'), name: 'home laptop', nodeId: nid, at });
  assert.strictEqual(r.replaced, true);
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].tokenHash, hash('c'));
  assert.strictEqual(devices[0].nodeId, nid);
});

test('без nodeId устройства не схлопываются', () => {
  const devices = [];
  upsertDevice(devices, { tokenHash: hash('a'), name: 'phone', at });
  upsertDevice(devices, { tokenHash: hash('b'), name: 'phone', at });
  assert.strictEqual(devices.length, 2);
});
