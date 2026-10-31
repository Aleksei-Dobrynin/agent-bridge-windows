'use strict';
// m-1 (финальное ревью): Origin WebView (http://127.0.0.1:38471) мост принимает только на
// WS-апгрейде устройства (LocalGateway телефона); владельцу (WS и HTTP) и HTTP вообще — 403.
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const H = require('./helpers/bridge');

const WV = 'http://127.0.0.1:38471';
let tb;

test.before(async () => { tb = await H.startTestBridge({ devices: [H.DEVICE], prefix: 'cb-origin-' }); });
test.after(async () => { if (tb) await tb.stop(); });

function wsOpen(headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ws = new WebSocket(`wss://127.0.0.1:${tb.port}/ws`, { ...tb.pin, headers });
    ws.on('message', () => { finish({ ok: true }); ws.close(); });
    ws.on('unexpected-response', (r, res) => { finish({ ok: false, status: res.statusCode }); r.destroy(); });
    ws.on('error', () => finish({ ok: false, status: 'error' }));
  });
}
const get = (headers) => H.request(tb.port, tb.pin, { path: '/health', headers }).then((r) => r && r.statusCode);

test('device WS upgrade with the WebView Origin is accepted (cookie, as LocalGateway sends it)', async () => {
  assert.deepStrictEqual(await wsOpen({ Cookie: 'bridgeToken=' + H.DEVICE.token, Origin: WV }), { ok: true });
  assert.deepStrictEqual(await wsOpen({ Authorization: 'Bearer ' + H.DEVICE.token, Origin: WV }), { ok: true });
});

test('owner WS upgrade with the WebView Origin is refused', async () => {
  assert.deepStrictEqual(await wsOpen({ Authorization: 'Bearer ' + tb.owner, Origin: WV }), { ok: false, status: 403 });
});

test('unknown token with the WebView Origin gets 401, not 403 (phone detects revocation, I-1)', async () => {
  assert.deepStrictEqual(await wsOpen({ Cookie: 'bridgeToken=' + 'e'.repeat(48), Origin: WV }), { ok: false, status: 401 });
});

test('HTTP with the WebView Origin is refused for owner and device', async () => {
  assert.strictEqual(await get({ Authorization: 'Bearer ' + tb.owner }), 200, 'owner without Origin');
  assert.strictEqual(await get({ Authorization: 'Bearer ' + tb.owner, Origin: WV }), 403, 'owner');
  assert.strictEqual(await get({ Authorization: 'Bearer ' + H.DEVICE.token, Origin: WV }), 403, 'device');
});
