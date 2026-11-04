'use strict';
// D-29: клиент берёт локальный порт туннеля только из ready; ошибки — fail-closed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startTunnel, readNodeId } = require('../lib/remote-tunnel');

const FAKE = path.join(__dirname, 'fixtures', 'fake-tunnel.js');

test('ready{port} → порт и живой процесс', async () => {
  const t = await startTunnel({ ticket: 'x', secretFile: 'k', exePath: FAKE,
    env: { ...process.env, CB_FAKE_TUNNEL_PORT: '45678' } });
  try {
    assert.strictEqual(t.port, 45678);
    assert.strictEqual(t.child.exitCode, null);
  } finally { t.stop(); }
});

test('error из туннеля → отказ', async () => {
  await assert.rejects(startTunnel({ ticket: 'x', secretFile: 'k', exePath: FAKE,
    env: { ...process.env, CB_FAKE_TUNNEL_MODE: 'error' } }), /no relay/);
});

test('нет ready за таймаут → отказ', async () => {
  await assert.rejects(startTunnel({ ticket: 'x', secretFile: 'k', exePath: FAKE,
    env: { ...process.env, CB_FAKE_TUNNEL_MODE: 'hang' }, timeoutMs: 300 }), /не поднялся/);
});

test('readNodeId: разбор id', () => {
  const id = readNodeId({ exePath: FAKE,
    secretFile: 'k', env: { ...process.env, CB_FAKE_NODE_ID: 'b'.repeat(64) } });
  assert.strictEqual(id, 'b'.repeat(64));
});
