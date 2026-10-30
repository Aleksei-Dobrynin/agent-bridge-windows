'use strict';
// Интеграция Task 10: токен владельца, Origin, авторизация до апгрейда WS, /pair, вход по ott.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { pinnedTlsOptions } = require('../lib/cert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-srv-'));
const port = 18790 + Math.floor(Math.random() * 300) * 3;
let proc;
let pin;
let owner;

// Пиннинговый клиент — только новое соединение (agent: false), см. поправку к задаче 5.
function request(opts, body) {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, agent: false, ...pin, ...opts }, (res) => {
      res.resume();
      resolve(res);
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TEST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  const cer = path.join(home, 'certs', 'bridge.cer');
  assert.ok(await waitFor(() => fs.existsSync(path.join(home, 'owner.token')) && fs.existsSync(cer)),
    'bridge created owner.token and certificate in CLAUDE_BRIDGE_HOME');
  owner = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
  const der = fs.readFileSync(cer);
  pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(),
    crypto.createHash('sha256').update(der).digest('hex'));
  assert.ok(await waitFor(async () => !!(await request({ path: '/health' }))), 'bridge listens');
});

test.after(() => {
  if (proc && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  fs.rmSync(home, { recursive: true, force: true });
});

function wsOpen(headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers });
    ws.on('message', (d) => { finish({ ok: true, msg: JSON.parse(d) }); ws.close(); });
    ws.on('unexpected-response', (req, res) => { finish({ ok: false, status: res.statusCode }); req.destroy(); });
    ws.on('error', () => finish({ ok: false, status: 'error' }));
  });
}

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
  const res = await request({ path: '/health', headers: { Authorization: 'Bearer ' + owner, Origin: 'https://evil.example' } });
  assert.strictEqual(res.statusCode, 403);
});

test('POST /pair with null or non-string code does not crash the bridge (M-2)', async () => {
  for (const body of ['null', '{"code":null}', '{"code":{"toUpperCase":1}}', '[]', 'not json']) {
    const res = await request({ path: '/pair', method: 'POST' }, body);
    assert.ok(res, 'response for ' + body);
    assert.strictEqual(res.statusCode, 400, body);
  }
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true, 'bridge still alive');
});

test('malformed ws messages do not crash the bridge (P-10)', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers: { Authorization: 'Bearer ' + owner } });
    ws.on('error', reject);
    ws.on('open', () => {
      for (const m of ['null', '[]', '1', '{"type":1}', '{"type":"attach","id":{"x":1}}',
        '{"type":"input","id":"s1-abcdef","data":{"x":1}}', '{"type":"registerNode","nodeId":5}',
        '{"type":"revokeDevice","id":{}}', '{"type":"resize","id":"s1-abcdef","cols":"x","rows":-1}']) ws.send(m);
      ws.send(JSON.stringify({ type: 'list' }));
    });
    let n = 0; // приветственный sessions + ответ на list (обработан последним)
    ws.on('message', (d) => { if (JSON.parse(d).type === 'sessions' && ++n === 2) { ws.close(); resolve(); } });
    ws.on('close', () => { if (n < 2) reject(new Error('connection dropped')); });
  });
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true, 'bridge still alive');
});

test('/hook without session hook token is refused', async () => {
  const res = await request({ path: '/hook', method: 'POST', headers: { 'X-Bridge-Session': 's1-abcdef', Authorization: 'Bearer ' + owner } }, '{}');
  assert.strictEqual(res.statusCode, 403);
});

test('one-time token login sets cookie and redirects; token is single-use', async () => {
  const ott = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers: { Authorization: 'Bearer ' + owner } });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'issueLoginToken' })));
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'loginToken') { resolve(m.token); ws.close(); } });
  });
  const res = await request({ path: '/?ott=' + ott });
  assert.strictEqual(res.statusCode, 302);
  assert.strictEqual(res.headers.location, '/');
  assert.match(String(res.headers['set-cookie']), /bridgeToken=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  const again = await request({ path: '/?ott=' + ott });
  assert.strictEqual(again.statusCode, 401, 'ott is single-use');
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  const page = await request({ path: '/', headers: { Cookie: cookie } });
  assert.strictEqual(page.statusCode, 200, 'cookie authorizes static');
});

test('static without credentials is refused', async () => {
  const res = await request({ path: '/' });
  assert.strictEqual(res.statusCode, 401);
});
