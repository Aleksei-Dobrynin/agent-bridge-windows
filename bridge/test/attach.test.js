'use strict';
// Task 14: claude-mobile (attach.js) против тестового моста — токен владельца, пиннинг,
// --open, --rotate-token, подтверждения P-9 только в интерактивной консоли.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./helpers/bridge');

const ATTACH = path.join(__dirname, '..', 'attach.js');
const home = H.tempHome('cb-attach-');
const port = H.pickPort(26790);
let bridge;
let pin;
let owner;

test.before(async () => {
  bridge = H.startBridge(home, port);
  ({ owner, pin } = await H.ownerAndPin(home));
  assert.ok(await H.waitFor(async () => !!(await H.request(port, pin, { path: '/health' }))), 'bridge listens');
});

test.after(() => H.cleanup(home, [bridge && bridge.proc]));

/** Запустить claude-mobile с каталогом данных теста; stdin — pipe (не TTY). */
function runAttach(args, { env = {}, input = null, keepStdin = false } = {}) {
  const p = spawn(process.execPath, [ATTACH, ...args], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_LISTEN_PORT: String(port), ...env },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const r = { proc: p, out: '', err: '' };
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', (d) => { r.out += d; });
  p.stderr.on('data', (d) => { r.err += d; });
  if (input !== null) p.stdin.end(input);
  else if (!keepStdin) p.stdin.end();
  r.exited = new Promise((resolve) => p.on('exit', (code) => resolve(code)));
  const t = setTimeout(() => H.killTree(p.pid), 20000);
  r.exited.then(() => clearTimeout(t));
  return r;
}

test('-l against a running bridge prints "Сессий нет."', async () => {
  const r = runAttach(['-l']);
  assert.strictEqual(await r.exited, 0, r.err);
  assert.match(r.out, /Сессий нет\./);
});

test('--qr with non-TTY stdin refuses (P-9), no pairing code is printed', async () => {
  const r = runAttach(['--qr'], { input: 'y\n' });
  assert.strictEqual(await r.exited, 1);
  assert.match(r.err, /Эта операция требует подтверждения в интерактивной консоли\./);
  assert.doesNotMatch(r.out, /Код для ручного ввода/);
});

test('--open with CB_NO_BROWSER=1 prints a working one-time login URL', async () => {
  const r = runAttach(['--open'], { env: { CB_NO_BROWSER: '1' } });
  assert.strictEqual(await r.exited, 0, r.err);
  const m = r.out.match(/https:\/\/127\.0\.0\.1:(\d+)\/\?ott=([0-9a-f]{64})/);
  assert.ok(m, 'URL printed: ' + r.out);
  assert.strictEqual(Number(m[1]), port);
  const res = await H.request(port, pin, { path: '/?ott=' + m[2] });
  assert.strictEqual(res.statusCode, 302);
  assert.match(String(res.headers['set-cookie']), /bridgeToken=[0-9a-f]{64}/);
});

test('server: pairinfo / setInternet from owner need confirmed:true (P-9)', async () => {
  const c = await H.wsConnect(port, pin, { Authorization: 'Bearer ' + owner });
  assert.ok(c);
  c.send({ type: 'pairinfo' });
  c.send({ type: 'setInternet', enabled: true });
  c.send({ type: 'list' }); // маркер: ответ на list приходит после обработки предыдущих
  assert.ok(await H.waitFor(() => c.msgs.filter((m) => m.type === 'sessions').length >= 2));
  assert.ok(!c.msgs.some((m) => m.type === 'pairinfo'), 'no pairinfo without confirmation');
  assert.ok(!fs.existsSync(path.join(home, 'internet.json')), 'internet not toggled without confirmation');
  c.send({ type: 'pairinfo', confirmed: true });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'pairinfo')));
  const p = c.msgs.find((m) => m.type === 'pairinfo');
  assert.match(p.code, /^[0-9A-F]{10}$/);
  // после сопряжения подключённые клиенты получают уведомление (D-15 п. 6)
  const res = await H.request(port, pin, { path: '/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ code: p.code, name: 'тест-телефон' }));
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'notify' && m.event === 'DevicePaired')));
  assert.match(c.msgs.find((m) => m.event === 'DevicePaired').message, /тест-телефон/);
  c.ws.close();
});

test('bridge down -> clear error, exit 1', async () => {
  const r = runAttach(['-l'], { env: { CLAUDE_BRIDGE_LISTEN_PORT: String(port + 900) } });
  assert.strictEqual(await r.exited, 1);
  assert.match(r.err, /Мост недоступен/);
});

test('owner connection closed with 4401 -> clear message, exit 1', async () => {
  const r = runAttach(['--device'], { keepStdin: true }); // ждёт ответа в меню
  assert.ok(await H.waitFor(() => /Доверенные устройства/.test(r.out)), r.out + r.err);
  const c = await H.wsConnect(port, pin, { Authorization: 'Bearer ' + owner });
  c.send({ type: 'rotateOwnerToken' });
  assert.strictEqual(await r.exited, 1);
  assert.match(r.err, /Токен владельца перевыпущен/);
  owner = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
});

test('--rotate-token rotates the owner token; the old one stops working', async () => {
  const before = owner;
  const r = runAttach(['--rotate-token']);
  assert.strictEqual(await r.exited, 0, r.err);
  assert.match(r.out, /Токен владельца перевыпущен/);
  owner = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
  assert.notStrictEqual(owner, before);
  const old = await H.request(port, pin, { path: '/health', headers: { Authorization: 'Bearer ' + before } });
  assert.strictEqual(old.statusCode, 401);
  const r2 = runAttach(['-l']);
  assert.strictEqual(await r2.exited, 0, r2.err);
});
