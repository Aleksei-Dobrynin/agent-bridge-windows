'use strict';
// D-29: ноутбук сопрягается как устройство — сверка отпечатка до отправки кода,
// на диске только хэш токена на стороне моста, профиль и токен — на стороне клиента.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./helpers/bridge');
const { pairDevice, loadProfile } = require('../lib/pair-client');

let b;
test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-pc-', config: { host: H.TEST_LAN_HOST } });
});
test.after(() => b && b.stop());

let owner = null;
/** Свежий код сопряжения (одноразовый). Один owner-WS на весь файл. */
async function ticket() {
  if (!owner) owner = await b.connect(b.owner);
  const at = owner.mark();
  owner.send({ type: 'pairinfo', confirmed: true });
  const p = await owner.wait((m) => m.type === 'pairinfo', 5000, at);
  return JSON.stringify({ cb: 1, host: p.host, port: p.port, code: p.code, fp: p.fp });
}

// ВАЖНО: успешное сопряжение ставит phoneRequired — после него pairinfo требует телефон.
// Поэтому все проверки отказов идут ДО успешного сопряжения.
test('мусор в QR — понятная ошибка', async () => {
  const root1 = H.tempHome('cb-lap-');
  try {
    await assert.rejects(pairDevice({ ticket: '{"cb":1}', name: 'x', root: root1 }), /QR/);
  } finally { fs.rmSync(root1, { recursive: true, force: true }); }
  const root2 = H.tempHome('cb-lap-');
  try {
    await assert.rejects(pairDevice({ ticket: 'not json', name: 'x', root: root2 }), /JSON/);
  } finally { fs.rmSync(root2, { recursive: true, force: true }); }
});

test('неверный отпечаток в QR — отказ до /pair, ничего не сохранено', async () => {
  const root = H.tempHome('cb-lap-');
  try {
    const t = JSON.parse(await ticket());
    t.fp = 'cd'.repeat(32);
    await assert.rejects(pairDevice({ ticket: JSON.stringify(t), name: 'x', root }), /отпечаток/i);
    assert.ok(!fs.existsSync(path.join(root, 'remote', 'device.token')));
    assert.ok(!fs.existsSync(path.join(root, 'remote', 'profile.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('просроченный/неверный код — ошибка моста без профиля', async () => {
  const root = H.tempHome('cb-lap-');
  try {
    const t = JSON.parse(await ticket());
    t.code = '0000000000';
    await assert.rejects(pairDevice({ ticket: JSON.stringify(t), name: 'x', root }), /код сопряжения/i);
    assert.ok(!fs.existsSync(path.join(root, 'remote', 'profile.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pairDevice: профиль, сертификат и токен на диске', async () => {
  const root = H.tempHome('cb-lap-');
  try {
    const t = await ticket();
    const r = await pairDevice({ ticket: t, name: 'home laptop', root });
    assert.strictEqual(r.host, H.TEST_LAN_HOST);
    assert.match(r.token, /^[0-9a-f]{48}$/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'remote', 'device.token'), 'utf8').trim(), r.token);
    const der = fs.readFileSync(path.join(root, 'remote', 'bridge.cer'));
    assert.strictEqual(crypto.createHash('sha256').update(der).digest('hex'), r.fingerprint);
    const prof = loadProfile(root);
    assert.strictEqual(prof.fingerprint, r.fingerprint);
    assert.strictEqual(prof.host, H.TEST_LAN_HOST);
    assert.strictEqual(prof.port, b.port);
    // на стороне моста — только хэш
    const raw = fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8');
    assert.ok(!raw.includes(r.token));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
