'use strict';
// Интеграция: токен владельца, Origin, авторизация до апгрейда WS, /pair, вход браузера по ott.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const H = require('./helpers/bridge');

const home = H.tempHome('cb-srv-');
const port = H.pickPort(18790);
let bridge;
let pin;
let owner;

const req = (opts, body) => H.request(port, pin, opts, body);

test.before(async () => {
  // интернет-доступ включён: локальный порт туннеля (port+2) слушается
  // (в тестовом режиме сайдкар claude-tunnel не запускается — это не мешает)
  fs.writeFileSync(path.join(home, 'internet.json'), JSON.stringify({ enabled: true }));
  bridge = H.startBridge(home, port);
  ({ owner, pin } = await H.ownerAndPin(home));
  assert.ok(await H.waitFor(async () => !!(await req({ path: '/health' }))), 'bridge listens');
});

test.after(() => H.cleanup(home, [bridge && bridge.proc]));

function wsOpen(headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers });
    ws.on('message', (d) => { finish({ ok: true, msg: JSON.parse(d) }); ws.close(); });
    ws.on('unexpected-response', (r, res) => { finish({ ok: false, status: res.statusCode }); r.destroy(); });
    ws.on('error', () => finish({ ok: false, status: 'error' }));
  });
}

async function ownerWs(token = owner) {
  const c = await H.wsConnect(port, pin, { Authorization: 'Bearer ' + token });
  assert.ok(c, 'owner ws connected');
  return c;
}

async function issueOtt() {
  const c = await ownerWs();
  c.send({ type: 'issueLoginToken' });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'loginToken')), 'loginToken');
  c.ws.close();
  return c.msgs.find((m) => m.type === 'loginToken').token;
}

test('bridge listens on CLAUDE_BRIDGE_LISTEN_PORT (M-11)', async () => {
  const res = await req({ path: '/health', headers: { Authorization: 'Bearer ' + owner } });
  assert.strictEqual(res.statusCode, 200);
});

test('ws without token is refused before upgrade', async () => {
  const r = await wsOpen({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
});

test('ws with owner token works', async () => {
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.msg.type, 'sessions');
});

test('ws with owner token but foreign Origin is refused (H-1)', async () => {
  const r = await wsOpen({ Authorization: 'Bearer ' + owner, Origin: 'https://evil.example' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
});

test('http with foreign Origin is refused', async () => {
  const res = await req({ path: '/health', headers: { Authorization: 'Bearer ' + owner, Origin: 'https://evil.example' } });
  assert.strictEqual(res.statusCode, 403);
});

test('POST /pair with null or non-string code does not crash the bridge (M-2)', async () => {
  for (const body of ['null', '{"code":null}', '{"code":{"toUpperCase":1}}', '[]', 'not json']) {
    const res = await req({ path: '/pair', method: 'POST' }, body);
    assert.ok(res, 'response for ' + body);
    assert.strictEqual(res.statusCode, 400, body);
  }
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true, 'bridge still alive');
});

test('POST /pair with empty code is refused even while a code is active (M-5)', async () => {
  const c = await ownerWs();
  c.send({ type: 'pairinfo', confirmed: true }); // P-9: подтверждено в консоли
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'pairinfo')), 'pairinfo');
  c.ws.close();
  const res = await req({ path: '/pair', method: 'POST' }, '{"code":""}');
  assert.strictEqual(res.statusCode, 403);
});

test('malformed ws messages do not crash the bridge (P-10)', async () => {
  const c = await ownerWs();
  for (const m of ['null', '[]', '1', '{"type":1}', '{"type":"attach","id":{"x":1}}',
    '{"type":"input","id":"s1-abcdef","data":{"x":1}}', '{"type":"registerNode","nodeId":5}',
    '{"type":"revokeDevice","id":{}}', '{"type":"resize","id":"s1-abcdef","cols":"x","rows":-1}']) c.ws.send(m);
  c.send({ type: 'list' });
  // приветственный sessions + ответ на list (обработан последним)
  assert.ok(await H.waitFor(() => c.msgs.filter((m) => m.type === 'sessions').length >= 2), 'list answered');
  c.ws.close();
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true, 'bridge still alive');
});

test('/hook without session hook token is refused', async () => {
  const res = await req({ path: '/hook', method: 'POST', headers: { 'X-Bridge-Session': 's1-abcdef', Authorization: 'Bearer ' + owner } }, '{}');
  assert.strictEqual(res.statusCode, 403);
});

test('static without credentials is refused', async () => {
  const res = await req({ path: '/' });
  assert.strictEqual(res.statusCode, 401);
});

test('owner token in a cookie is not accepted (M-1: cookie carries only the browser token)', async () => {
  const res = await req({ path: '/', headers: { Cookie: 'bridgeToken=' + owner } });
  assert.strictEqual(res.statusCode, 401);
});

test('ott: only GET on the main loopback port; POST and tunnel port give 404 without consuming', async () => {
  const ott = await issueOtt();
  const post = await req({ path: '/?ott=' + ott, method: 'POST' });
  assert.strictEqual(post.statusCode, 404, 'POST');
  const viaTunnel = await H.request(port + 2, pin, { path: '/?ott=' + ott });
  assert.ok(viaTunnel, 'tunnel port answers');
  assert.strictEqual(viaTunnel.statusCode, 404, 'tunnel port');
  const ok = await req({ path: '/?ott=' + ott });
  assert.strictEqual(ok.statusCode, 302, 'still valid on main port');
});

test('one-time token login sets a browser cookie (not the owner token) and redirects; single-use', async () => {
  const ott = await issueOtt();
  const res = await req({ path: '/?ott=' + ott });
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.location, '/');
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /bridgeToken=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  const value = setCookie.match(/bridgeToken=([0-9a-f]{64})/)[1];
  assert.notStrictEqual(value, fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim(), 'cookie != owner token');
  const again = await req({ path: '/?ott=' + ott });
  assert.strictEqual(again.statusCode, 401, 'ott is single-use');
  const page = await req({ path: '/', headers: { Cookie: 'bridgeToken=' + value } });
  assert.strictEqual(page.statusCode, 200, 'cookie authorizes static');
  const viaTunnel = await H.request(port + 2, pin, { path: '/', headers: { Cookie: 'bridgeToken=' + value } });
  assert.strictEqual(viaTunnel.statusCode, 401, 'browser cookie is owner-only on the main port');
});

// последним: меняет токен владельца
test('rotateOwnerToken invalidates owner token, browser cookie and outstanding ott (M-2)', async () => {
  const ottUsed = await issueOtt();
  const login = await req({ path: '/?ott=' + ottUsed });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const pending = await issueOtt();

  const c = await ownerWs();
  const closed = new Promise((r) => c.ws.on('close', (code) => r(code)));
  c.send({ type: 'rotateOwnerToken' });
  assert.strictEqual(await closed, 4401, 'owner connections closed');

  const fresh = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
  assert.notStrictEqual(fresh, owner);
  assert.strictEqual((await wsOpen({ Authorization: 'Bearer ' + owner })).status, 401, 'old owner token');
  assert.strictEqual((await req({ path: '/', headers: { Cookie: cookie } })).statusCode, 401, 'old browser cookie');
  assert.strictEqual((await req({ path: '/?ott=' + pending })).statusCode, 401, 'outstanding ott');
  assert.strictEqual((await wsOpen({ Authorization: 'Bearer ' + fresh })).ok, true, 'new owner token');
  owner = fresh;
});
