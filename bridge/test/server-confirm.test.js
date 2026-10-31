'use strict';
// Задача 15 (D-13): выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже
// сопряжённом телефоне; без сопряжённых устройств — флаг интерактивной консоли (P-9).
// pairinfo без LAN-адреса — ошибка (D-18 п. 3), телефон при этом не беспокоим.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/bridge');

const fs = require('fs');
const path = require('path');

const { sleep, DEVICE, TEST_LAN_HOST } = H;
const PHONE2 = { token: 'c'.repeat(48), name: 'Phone 2' };
PHONE2.id = H.sha256(PHONE2.token).slice(0, 12);
// пауза после отказа (D-22.3) в тестах — короткая
const FAST = { CLAUDE_BRIDGE_TEST_COOLDOWN_MS: '300' };

test('no paired devices: console confirmation flag is required', { timeout: 90000 }, async () => {
  const b = await H.startTestBridge({ prefix: 'cb-cf0-', config: { host: TEST_LAN_HOST } });
  try {
    const o = await b.connect(b.owner);
    let at = o.mark();
    o.send({ type: 'pairinfo' });
    const r = await o.wait((m) => m.type === 'confirmRequired' || m.type === 'pairinfo', 5000, at);
    assert.deepStrictEqual([r.type, r.action], ['confirmRequired', 'pairinfo']);
    at = o.mark();
    o.send({ type: 'pairinfo', confirmed: true });
    const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
    assert.match(p.code, /^[0-9A-F]{10}$/);
    assert.strictEqual(p.host, TEST_LAN_HOST);
    at = o.mark();
    o.send({ type: 'setInternet', enabled: true });
    const si = await o.wait((m) => m.type === 'confirmRequired', 5000, at);
    assert.strictEqual(si.action, 'setInternet');
  } finally { await b.stop(); }
});

test('paired device: owner operations wait for the phone', { timeout: 90000 }, async () => {
  const b = await H.startTestBridge({ prefix: 'cb-cf1-', devices: [DEVICE], config: { host: TEST_LAN_HOST }, env: FAST });
  try {
    const o = await b.connect(b.owner);
    const d = await b.connect(DEVICE.token);
    let at = o.mark();
    let atD = d.mark();
    o.send({ type: 'pairinfo', confirmed: true });
    const pend = await o.wait((m) => m.type === 'confirmPending', 5000, at);
    const req = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    assert.strictEqual(req.confirmId, pend.confirmId);
    assert.strictEqual(req.action, 'pairinfo');
    assert.match(req.message, /код сопряжения/);
    assert.ok(!o.msgs.slice(at).some((m) => m.type === 'confirmRequest'), 'owner does not get the request');

    o.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
    await sleep(500);
    assert.ok(!o.msgs.slice(at).some((m) => m.type === 'pairinfo'), 'owner cannot confirm itself');

    d.send({ type: 'confirm', confirmId: req.confirmId, allow: false });
    const res = await o.wait((m) => m.type === 'confirmResult', 5000, at);
    assert.deepStrictEqual([res.allow, res.reason], [false, 'denied']);
    await d.wait((m) => m.type === 'confirmClosed' && m.confirmId === req.confirmId, 5000, atD);
    assert.ok(!o.msgs.slice(at).some((m) => m.type === 'pairinfo'));
    await sleep(400); // пауза после отказа (D-22.3)

    at = o.mark();
    atD = d.mark();
    o.send({ type: 'pairinfo' });
    const req2 = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    d.send({ type: 'confirm', confirmId: req2.confirmId, allow: true });
    const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
    assert.match(p.code, /^[0-9A-F]{10}$/);
    assert.strictEqual((await o.wait((m) => m.type === 'confirmResult', 5000, at)).allow, true);
    // подтверждение одноразовое: повтор того же confirmId ничего не выпускает
    d.send({ type: 'confirm', confirmId: req2.confirmId, allow: true });
    await sleep(500);
    assert.strictEqual(o.msgs.slice(at).filter((m) => m.type === 'pairinfo').length, 1);

    at = o.mark();
    o.send({ type: 'setInternet', enabled: false });
    await o.wait((m) => m.type === 'internet' && m.enabled === false, 5000, at);
    o.send({ type: 'setInternet', enabled: true });
    const ip = await o.wait((m) => m.type === 'confirmPending' && m.action === 'setInternet', 5000, at);
    o.send({ type: 'setInternet', enabled: true });
    await o.wait((m) => m.type === 'error' && /уже ожидается/.test(m.message), 5000, at);

    const d2 = await b.connect(DEVICE.token);
    const late = await d2.wait((m) => m.type === 'confirmRequest' && m.confirmId === ip.confirmId, 5000);
    d2.send({ type: 'confirm', confirmId: late.confirmId, allow: false });
    await o.wait((m) => m.type === 'confirmResult' && m.confirmId === ip.confirmId && m.allow === false, 5000, at);
  } finally { await b.stop(); }
});

test('paired device, no LAN address: pairinfo errors at once, the phone is not asked (D-18 п. 3)', { timeout: 90000 }, async () => {
  const b = await H.startTestBridge({ prefix: 'cb-cf2-', devices: [DEVICE] }); // host 127.0.0.1 — LAN нет
  try {
    const o = await b.connect(b.owner);
    const d = await b.connect(DEVICE.token);
    const at = o.mark();
    const atD = d.mark();
    o.send({ type: 'pairinfo', confirmed: true });
    const e = await o.wait((m) => m.type === 'error' || m.type === 'confirmPending', 5000, at);
    assert.strictEqual(e.type, 'error');
    assert.match(e.message, /нет LAN-адреса/);
    await sleep(500);
    assert.ok(!d.msgs.slice(atD).some((m) => m.type === 'confirmRequest'));
  } finally { await b.stop(); }
});

test('C-1 / D-22.2: revoking all phones does not reopen the console path (phoneRequired)', { timeout: 120000 }, async () => {
  const b = await H.startTestBridge({ prefix: 'cb-cf3-', devices: [DEVICE, PHONE2], config: { host: TEST_LAN_HOST } });
  try {
    const o = await b.connect(b.owner); // агент с токеном владельца
    const d = await b.connect(DEVICE.token);
    let atD = d.mark();
    o.send({ type: 'revokeDevice', id: PHONE2.id });
    const n = await d.wait((m) => m.type === 'notify' && m.event === 'info' && /отозвано/.test(m.message), 5000, atD);
    assert.match(n.message, /Устройство отозвано: Phone 2/);
    o.send({ type: 'revokeDevice', id: DEVICE.id });
    await H.waitFor(() => d.ws.readyState !== 1, 5000);
    const NEED = /нужен сопряжённый телефон; сброс — удалить pairings\.json при остановленном мосте/;
    const tryAll = async (client) => {
      for (const msg of [{ type: 'pairinfo', confirmed: true }, { type: 'pairinfo' },
        { type: 'setInternet', enabled: true, confirmed: true }]) {
        const at = client.mark();
        client.send(msg);
        const r = await client.wait((m) => ['error', 'pairinfo', 'confirmRequired', 'confirmPending'].includes(m.type), 5000, at);
        assert.strictEqual(r.type, 'error', JSON.stringify(msg));
        assert.match(r.message, NEED);
      }
    };
    await tryAll(o);
    assert.ok(!fs.existsSync(path.join(b.home, 'internet.json')), 'internet not enabled');
    const saved = JSON.parse(fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8'));
    assert.deepStrictEqual([saved.phoneRequired, saved.devices.length], [true, 0]);
    // флаг переживает рестарт моста
    await b.restart();
    await tryAll(await b.connect(b.owner));
  } finally { await b.stop(); }
});

test('D-22.3: check code in confirmPending and confirmRequest; cooldown after deny', { timeout: 90000 }, async () => {
  const b = await H.startTestBridge({ prefix: 'cb-cf4-', devices: [DEVICE], config: { host: TEST_LAN_HOST },
    env: { CLAUDE_BRIDGE_TEST_COOLDOWN_MS: '1500' } });
  try {
    const o = await b.connect(b.owner);
    const d = await b.connect(DEVICE.token);
    let at = o.mark();
    let atD = d.mark();
    o.send({ type: 'pairinfo' });
    const pend = await o.wait((m) => m.type === 'confirmPending', 5000, at);
    const req = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    assert.match(pend.checkCode, /^\d{4}$/);
    assert.strictEqual(req.checkCode, pend.checkCode);
    d.send({ type: 'confirm', confirmId: req.confirmId, allow: false });
    await o.wait((m) => m.type === 'confirmResult' && m.reason === 'denied', 5000, at);
    // повтор сразу — пауза, телефон не беспокоим
    at = o.mark();
    atD = d.mark();
    o.send({ type: 'pairinfo' });
    const cd = await o.wait((m) => m.type === 'confirmResult', 5000, at);
    assert.deepStrictEqual([cd.ok, cd.allow, cd.reason, cd.action], [false, false, 'cooldown', 'pairinfo']);
    assert.ok(Number.isInteger(cd.retryAfterSec) && cd.retryAfterSec >= 1 && cd.retryAfterSec <= 2, String(cd.retryAfterSec));
    await sleep(300);
    assert.ok(!d.msgs.slice(atD).some((m) => m.type === 'confirmRequest'));
    // другое действие паузой не задето
    o.send({ type: 'setInternet', enabled: true });
    const si = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    assert.strictEqual(si.action, 'setInternet');
    d.send({ type: 'confirm', confirmId: si.confirmId, allow: false });
    await sleep(1600);
    at = o.mark();
    atD = d.mark();
    o.send({ type: 'pairinfo' });
    const again = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    assert.strictEqual(again.action, 'pairinfo', 'after the pause the request goes through');
  } finally { await b.stop(); }
});

test('I-2: requester disconnect cancels its confirmation (confirmClosed) and starts the pause', { timeout: 90000 }, async () => {
  const b = await H.startTestBridge({ prefix: 'cb-cf5-', devices: [DEVICE], config: { host: TEST_LAN_HOST },
    env: { CLAUDE_BRIDGE_TEST_COOLDOWN_MS: '1500' } });
  try {
    const o = await b.connect(b.owner);
    const tmp = await b.connect(b.owner);
    const d = await b.connect(DEVICE.token);
    let atD = d.mark();
    tmp.send({ type: 'pairinfo' });
    const req = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    tmp.close();
    await d.wait((m) => m.type === 'confirmClosed' && m.confirmId === req.confirmId, 5000, atD);
    const at = o.mark();
    d.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
    await sleep(400);
    assert.ok(!o.msgs.slice(at).some((m) => m.type === 'pairinfo' || m.type === 'confirmResult'));
    // отмена отключением — не одобрение: пауза, как после отказа (цикл «запрос+отключение» не спамит телефон)
    atD = d.mark();
    o.send({ type: 'pairinfo' });
    const cd = await o.wait((m) => m.type === 'confirmPending' || m.type === 'error' || m.type === 'confirmResult', 5000, at);
    assert.deepStrictEqual([cd.type, cd.reason], ['confirmResult', 'cooldown']);
    await sleep(300);
    assert.ok(!d.msgs.slice(atD).some((m) => m.type === 'confirmRequest'), 'phone not bothered');
    // после паузы слот свободен
    await sleep(1400);
    const at2 = o.mark();
    o.send({ type: 'pairinfo' });
    const pend = await o.wait((m) => m.type === 'confirmPending' || m.type === 'error' || m.type === 'confirmResult', 5000, at2);
    assert.strictEqual(pend.type, 'confirmPending', 'no "already pending" after the pause');
    await d.wait((m) => m.type === 'confirmRequest' && m.confirmId === pend.confirmId, 5000, atD);
  } finally { await b.stop(); }
});
