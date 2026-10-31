'use strict';
// Задача 15 (D-13): выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже
// сопряжённом телефоне; без сопряжённых устройств — флаг интерактивной консоли (P-9).
// pairinfo без LAN-адреса — ошибка (D-18 п. 3), телефон при этом не беспокоим.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/bridge');

const { sleep, DEVICE, TEST_LAN_HOST } = H;

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
  const b = await H.startTestBridge({ prefix: 'cb-cf1-', devices: [DEVICE], config: { host: TEST_LAN_HOST } });
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
