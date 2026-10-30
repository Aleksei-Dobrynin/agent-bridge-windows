'use strict';
// Task 13: сеть офиса (P-7) — маяк без hostname, слушаем LAN + loopback, а не 0.0.0.0;
// туннель (P-4) в тестовом режиме не запускается; ревью I-3 — нет сети при старте.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { spawnSync } = require('child_process');
const H = require('./helpers/bridge');
const { pickLanAddress } = require('../lib/lan');

// Реальный адрес этого ПК (bind должен пройти), по возможности НЕ тот, что выбрал бы
// мост сам, — так видно, что мост берёт адаптеры из подставленного списка.
function realAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}
const DEFAULT_PICK = pickLanAddress();
const INJECTED = realAddrs().find((a) => a !== DEFAULT_PICK) || realAddrs()[0] || null;
const ifaces = (addr) => JSON.stringify(addr ? { Ethernet: [{ family: 'IPv4', address: addr, internal: false }] } : {});

const home = H.tempHome('cb-net-');
const port = H.pickPort(23790);
let bridge;
let pin;
let owner;

test.before(async () => {
  fs.writeFileSync(path.join(home, 'internet.json'), JSON.stringify({ enabled: true }));
  bridge = H.startBridge(home, port, INJECTED ? { CLAUDE_BRIDGE_TEST_IFACES: ifaces(INJECTED) } : {});
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

test('host "auto": listens on the (injected) LAN address + loopback, never on 0.0.0.0 (P-7)', async (t) => {
  // LAN-адрес занимается после loopback (onListening) — дождаться
  if (INJECTED) await H.waitFor(() => listenAddrs(port).includes(INJECTED), 10000);
  const addrs = listenAddrs(port);
  assert.ok(addrs.includes('127.0.0.1'), 'owner loopback listener: ' + addrs.join(','));
  assert.ok(!addrs.includes('0.0.0.0') && !addrs.includes('::'), 'not all interfaces: ' + addrs.join(','));
  if (!INJECTED) { t.skip('нет сетевого адаптера с IPv4'); return; }
  assert.deepStrictEqual(addrs, ['127.0.0.1', INJECTED].sort(), 'listens on the injected LAN address');
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

test('auto host, no network at start: loud warning, no 127.0.0.1 QR, LAN picked up later (I-3)', { timeout: 120000 }, async (t) => {
  if (!INJECTED) { t.skip('нет сетевого адаптера с IPv4'); return; }
  const home2 = H.tempHome('cb-nolan-');
  const port2 = H.pickPort(24790);
  const ifFile = path.join(home2, 'ifaces.json');
  fs.writeFileSync(ifFile, ifaces(null));
  const b = H.startBridge(home2, port2, { CLAUDE_BRIDGE_TEST_IFACES: ifFile, CLAUDE_BRIDGE_TEST_REPICK_MS: '300' });
  t.after(() => H.cleanup(home2, [b.proc]));
  const { owner: o2, pin: pin2 } = await H.ownerAndPin(home2);
  assert.ok(await H.waitFor(async () => !!(await H.request(port2, pin2, { path: '/health' }))), 'bridge listens');
  assert.match(b.stderr, /нет LAN-адреса/i, 'loud warning on stderr');
  assert.deepStrictEqual(listenAddrs(port2), ['127.0.0.1'], 'only loopback while offline');

  const c = await H.wsConnect(port2, pin2, { Authorization: 'Bearer ' + o2 });
  c.send({ type: 'pairinfo', confirmed: true });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'error' || m.type === 'pairinfo')));
  assert.ok(!c.msgs.some((m) => m.type === 'pairinfo'), 'no QR with 127.0.0.1');
  assert.match(c.msgs.find((m) => m.type === 'error').message, /нет LAN-адреса/);

  fs.writeFileSync(ifFile, ifaces(INJECTED)); // «сеть поднялась»
  assert.ok(await H.waitFor(() => listenAddrs(port2).includes(INJECTED), 20000), 'listens on LAN once it appears');
  assert.ok(listenAddrs(port2).includes('127.0.0.1'), 'owner loopback listener kept');
  c.send({ type: 'pairinfo', confirmed: true });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'pairinfo')));
  assert.strictEqual(c.msgs.find((m) => m.type === 'pairinfo').host, INJECTED);
  c.ws.close();
});
