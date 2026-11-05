'use strict';
// Задача 14a (D-15 п. 7): токены устройств хранятся в pairings.json только как SHA-256-хэш;
// /pair отдаёт токен один раз; вход по токену сравнивает хэш; deviceId — первые 12 hex хэша;
// старые записи с открытым token не поддерживаются (D-9). Уведомление о сопряжении — event:'info'.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge');

const LEGACY = 'e'.repeat(48);
let b;
let token; // токен нового устройства — есть только у «телефона» (ответ /pair)
test.before(async () => {
  // явный host на loopback-адресе, отличном от 127.0.0.1: pairinfo выдаёт код без реальной LAN
  b = await H.startTestBridge({ prefix: 'cb-pair-', config: { host: H.TEST_LAN_HOST }, rawPairings: { devices: [
    { id: 'legacy000001', token: LEGACY, name: 'old phone', addedAt: '2026-01-01T00:00:00.000Z' },
  ] } });
});
test.after(() => b && b.stop());

test('legacy plaintext pairing entry is not accepted (D-9)', async () => {
  assert.strictEqual(await H.wsConnect(b.port, b.pin, { Authorization: 'Bearer ' + LEGACY }), null);
  assert.match(b.logs(), /открыт/);
  // m-4: файл переписан сразу при старте — открытого токена на диске больше нет; флаг D-22.2 не ставится
  const raw = fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8');
  assert.ok(!raw.includes(LEGACY), 'legacy plaintext token removed from disk at startup');
  assert.deepStrictEqual(JSON.parse(raw), { phoneRequired: false, devices: [] });
});

test('/pair stores only the token hash; login with the token works; info notify', { timeout: 60000 }, async () => {
  const o = await b.connect(b.owner);
  let at = o.mark();
  o.send({ type: 'pairinfo', confirmed: true }); // устройств нет — подтверждение консоли (P-9)
  const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
  const res = await H.request(b.port, b.pin, { path: '/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ code: p.code, name: 'new phone' }));
  assert.strictEqual(res.statusCode, 200, res.body);
  ({ token } = JSON.parse(res.body));
  assert.match(token, /^[0-9a-f]{48}$/);

  const n = await o.wait((m) => m.type === 'notify' && /new phone/.test(m.message || ''), 5000, at);
  assert.strictEqual(n.event, 'info', 'D-15 п. 1: notify.event ∈ request|done|info');

  const raw = fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8');
  assert.ok(!raw.includes(token), 'token is not stored');
  assert.ok(!raw.includes(LEGACY), 'legacy plaintext entry is not written back');
  const devs = JSON.parse(raw).devices;
  assert.strictEqual(devs.length, 1);
  assert.strictEqual(devs[0].token, undefined);
  assert.strictEqual(devs[0].tokenHash, H.sha256(token));
  assert.strictEqual(devs[0].id, H.sha256(token).slice(0, 12));
  assert.strictEqual(devs[0].name, 'new phone');
  assert.strictEqual(JSON.parse(raw).phoneRequired, true, 'D-22.2: set by the first successful pairing');

  const d = await b.connect(token);
  await d.wait((m) => m.type === 'sessions');
  at = o.mark();
  o.send({ type: 'devices' });
  const list = await o.wait((m) => m.type === 'devices', 5000, at);
  assert.deepStrictEqual(list.devices.map((x) => x.id), [devs[0].id]);
  assert.ok(!JSON.stringify(list).includes('tokenHash'), 'hash is not sent to clients');

  // неверный токен той же длины — отказ
  assert.strictEqual(await H.wsConnect(b.port, b.pin, { Authorization: 'Bearer ' + 'f'.repeat(48) }), null);
});

test('after a bridge restart the paired device still logs in (hash read from file)', { timeout: 60000 }, async () => {
  await b.restart();
  const d = await b.connect(token);
  await d.wait((m) => m.type === 'sessions');
});

test('registerNode: устройство получает подтверждение, NodeId в allowlist (D-29)', { timeout: 60000 }, async () => {
  const d = await b.connect(token);
  await d.wait((m) => m.type === 'sessions');
  const at = d.mark();
  const nodeId = 'a'.repeat(64);
  d.send({ type: 'registerNode', nodeId });
  const ack = await d.wait((m) => m.type === 'nodeRegistered', 5000, at);
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.nodeId, nodeId);
  const raw = JSON.parse(fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8'));
  assert.strictEqual(raw.devices[0].nodeId, nodeId);
  const allow = fs.readFileSync(path.join(b.home, 'certs', 'tunnel-allow.txt'), 'utf8');
  assert.ok(allow.includes(nodeId), 'NodeId попал в allowlist туннеля');
});

test('/pair с nodeId: allowlist сразу, без registerNode (D-30)', { timeout: 60000 }, async () => {
  const o = await b.connect(b.owner);
  const at = o.mark();
  o.send({ type: 'pairinfo' });
  // устройства уже есть → нужен подтверждающий телефон; в этом файле это `token`
  const d = await b.connect(token);
  // позиция в msgs самого `d`, а не владельца `o`: индексы у клиентов свои
  const dat = d.mark();
  await d.wait((m) => m.type === 'sessions', 10000, dat);
  const req = await d.wait((m) => m.type === 'confirmRequest', 5000, dat);
  d.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
  const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
  const nodeId = 'b'.repeat(64);
  const res = await H.request(b.port, b.pin, { path: '/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ code: p.code, name: 'home laptop', nodeId }));
  assert.strictEqual(res.statusCode, 200, res.body);
  const devs = JSON.parse(fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8')).devices;
  assert.strictEqual(devs.filter((x) => x.nodeId === nodeId).length, 1, 'дубликата устройства нет');
  const dev = devs.find((x) => x.nodeId === nodeId);
  assert.ok(dev, 'устройство сохранено с NodeId');
  assert.strictEqual(dev.name, 'home laptop');
  const allow = fs.readFileSync(path.join(b.home, 'certs', 'tunnel-allow.txt'), 'utf8');
  assert.ok(allow.includes(nodeId), 'NodeId в allowlist без отдельного registerNode');
});
