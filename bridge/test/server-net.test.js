'use strict';
// Task 13: сеть офиса (P-7) — маяк без hostname, слушаем LAN + loopback, а не 0.0.0.0;
// туннель (P-4) в тестовом режиме не запускается.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawnSync } = require('child_process');
const H = require('./helpers/bridge');

const home = H.tempHome('cb-net-');
const port = H.pickPort(23790);
let bridge;
let pin;
let owner;

test.before(async () => {
  fs.writeFileSync(path.join(home, 'internet.json'), JSON.stringify({ enabled: true }));
  bridge = H.startBridge(home, port);
  ({ owner, pin } = await H.ownerAndPin(home));
  assert.ok(await H.waitFor(async () => !!(await H.request(port, pin, { path: '/health' }))), 'bridge listens');
});

test.after(() => H.cleanup(home, [bridge && bridge.proc]));

function listenAddrs(p) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -State Listen -LocalPort ${p} -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }`],
  { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter(Boolean).sort();
}

test('config.example.json is Windows-flavoured (host auto, py launcher)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.host, 'auto');
  assert.strictEqual(cfg.sttPython, 'py');
  assert.deepStrictEqual(cfg.sttPythonArgs, ['-3.11']);
});

test('host "auto": listens on LAN address + loopback, never on 0.0.0.0 (P-7)', () => {
  const addrs = listenAddrs(port);
  assert.ok(addrs.includes('127.0.0.1'), 'owner loopback listener: ' + addrs.join(','));
  assert.ok(!addrs.includes('0.0.0.0') && !addrs.includes('::'), 'not all interfaces: ' + addrs.join(','));
});

test('owner works via loopback listener', async () => {
  const res = await H.request(port, pin, { path: '/health', headers: { Authorization: 'Bearer ' + owner } });
  assert.strictEqual(res.statusCode, 200);
});

test('UDP beacon reply has port and fingerprint but no hostname (P-7)', async () => {
  const sock = dgram.createSocket('udp4');
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    sock.on('message', (msg) => { clearTimeout(timer); resolve(JSON.parse(msg.toString())); });
    sock.send('CLAUDE_BRIDGE?', port + 1, '127.0.0.1');
  });
  sock.close();
  assert.ok(reply, 'beacon replied');
  assert.strictEqual(reply.claudeBridge, true);
  assert.strictEqual(reply.port, port);
  assert.match(reply.fp, /^[0-9a-f]{64}$/);
  assert.ok(!('host' in reply) && !JSON.stringify(reply).includes(os.hostname()), 'no hostname in beacon');
});

test('test mode: internet enabled, but no claude-tunnel is spawned', () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='claude-tunnel.exe'\" | " +
    'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:CB_TEST_HOME) } | ForEach-Object { $_.ProcessId }'],
  { env: { ...process.env, CB_TEST_HOME: home }, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(String(r.stdout || '').trim(), '');
  assert.ok(!fs.existsSync(path.join(home, 'certs', 'iroh.key')), 'tunnel did not create its key');
});
