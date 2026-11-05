'use strict';
// D-30: политика подключения ПК-клиента как у телефона — порядок путей, обновление
// ticket по LAN, отзыв без ретраев, поиск моста по UDP-маяку.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { createSession, discoverBridge, updateProfile, broadcastTargets } = require('../lib/client-session');

const TOKEN = 'a'.repeat(48);
const PIN = { ca: 'x', rejectUnauthorized: true };
const FP = 'ab'.repeat(32);

function profile(over = {}) {
  return {
    host: '10.0.0.5', port: 8790, fingerprint: FP, ticket: 'old-ticket',
    paths: { secret: path.join(os.tmpdir(), 'cb-x', 'iroh.key') },
    ...over,
  };
}
const fakeWs = () => ({ close() { }, sent: [] });

test('LAN доступен: туннель не поднимается, ticket сохраняется', async () => {
  const saved = [];
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { throw new Error('туннель не должен запускаться'); },
    saveProfile: (p) => saved.push(p),
    probe: async () => ({ ok: true, ticket: 'new-ticket' }),
    openWs: async () => fakeWs(),
  });
  const { ws, via } = await s.connect();
  assert.ok(ws);
  assert.strictEqual(via, 'lan');
  assert.ok(saved.some((p) => p.ticket === 'new-ticket'), 'ticket сохранён в профиль');
  s.stop();
});

test('LAN недоступен: поднимается туннель с ticket из профиля', async () => {
  const calls = [];
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async (o) => { calls.push(o.ticket); return { port: 5555, stop() { } }; },
    probe: async () => ({ ok: false, reason: 'timeout' }),
    discover: async () => null,
    openWs: async (host, port) => { calls.push(host + ':' + port); return fakeWs(); },
  });
  const { via } = await s.connect();
  assert.strictEqual(via, 'tunnel');
  assert.deepStrictEqual(calls, ['old-ticket', '127.0.0.1:5555']);
  s.stop();
});

test('нет LAN и нет ticket — понятная ошибка без запуска туннеля', async () => {
  const s = createSession({
    profile: profile({ ticket: null }), token: TOKEN, pin: PIN,
    startTunnel: async () => { throw new Error('не должен'); },
    probe: async () => ({ ok: false, reason: 'timeout' }),
    discover: async () => null,
    openWs: async () => fakeWs(),
  });
  await assert.rejects(s.connect(), /ticket/);
});

test('отзыв устройства: ошибка помечена revoked, туннель не пробуется', async () => {
  let tunnelCalls = 0;
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { tunnelCalls++; return { port: 1, stop() { } }; },
    probe: async () => ({ ok: false, revoked: true, reason: 'HTTP 401' }),
    discover: async () => null,
    openWs: async () => fakeWs(),
  });
  await assert.rejects(s.connect(), (e) => e.revoked === true);
  assert.strictEqual(tunnelCalls, 0);
});

test('lastVia=tunnel: сначала туннель, LAN не пробуется', async () => {
  let probed = 0;
  const s = createSession({
    profile: profile({ lastVia: 'tunnel' }), token: TOKEN, pin: PIN,
    startTunnel: async () => ({ port: 5555, stop() { } }),
    probe: async () => { probed++; return { ok: true, ticket: 'x' }; },
    openWs: async () => fakeWs(),
  });
  const { via } = await s.connect();
  assert.strictEqual(via, 'tunnel');
  assert.strictEqual(probed, 0);
  s.stop();
});

test('адрес сменился: мост найден маяком, новый host сохранён', async () => {
  const saved = [];
  let calls = 0;
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { throw new Error('не должен'); },
    saveProfile: (p) => saved.push(p),
    probe: async ({ host }) => {
      calls++;
      return host === '10.0.0.9' ? { ok: true, ticket: 'new-ticket' } : { ok: false, reason: 'timeout' };
    },
    discover: async () => ({ host: '10.0.0.9', port: 8790 }),
    openWs: async () => fakeWs(),
  });
  const { via } = await s.connect();
  assert.strictEqual(via, 'lan');
  assert.strictEqual(calls, 2);
  assert.ok(saved.some((p) => p.host === '10.0.0.9'), 'новый адрес сохранён');
});

test('отзыв на новом адресе после маяка не уходит в туннель', async () => {
  let tunnelCalls = 0;
  const probed = [];
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { tunnelCalls++; return { port: 1, stop() { } }; },
    probe: async ({ host }) => {
      probed.push(host);
      return host === '10.0.0.9'
        ? { ok: false, revoked: true, reason: 'HTTP 401' }
        : { ok: false, reason: 'timeout' };
    },
    discover: async () => ({ host: '10.0.0.9', port: 8790 }),
    openWs: async () => fakeWs(),
  });
  await assert.rejects(s.connect(), (e) => e.revoked === true);
  assert.deepStrictEqual(probed, ['10.0.0.5', '10.0.0.9'], 'оба адреса проверены probe');
  assert.strictEqual(tunnelCalls, 0, 'отозванный токен не уходит в туннель');
});

test('повторный connect останавливает прежний туннель', async () => {
  let stops = 0;
  let created = 0;
  const s = createSession({
    profile: profile({ lastVia: 'tunnel' }), token: TOKEN, pin: PIN,
    startTunnel: async () => { created++; return { port: 5555, stop() { stops++; } }; },
    probe: async () => ({ ok: false, reason: 'timeout' }),
    discover: async () => null,
    openWs: async () => fakeWs(),
  });
  await s.connect();
  assert.strictEqual(stops, 0, 'первый connect нечего останавливать');
  await s.connect();
  assert.strictEqual(stops, 1, 'прежний туннель остановлен');
  assert.strictEqual(created, 2, 'новый туннель создан');
  s.stop();
});

test('updateProfile: точечное обновление и атомарная запись', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prof-'));
  const file = path.join(dir, 'profile.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ host: 'a', port: 1, ticket: null }));
    updateProfile(file, { ticket: 't', lastVia: 'lan' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { host: 'a', port: 1, ticket: 't', lastVia: 'lan' });
    assert.ok(!fs.existsSync(file + '.tmp'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discoverBridge: отвечает только маяк с нашим отпечатком', async () => {
  const srv = dgram.createSocket({ type: 'udp4' });
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  const port = srv.address().port;
  srv.on('message', (msg, rinfo) => {
    if (msg.toString().trim() !== 'CLAUDE_BRIDGE?') return;
    srv.send(JSON.stringify({ claudeBridge: true, port: 8790, fp: FP }), rinfo.port, rinfo.address);
  });
  try {
    const found = await discoverBridge({ fingerprint: FP, port: port - 1, targets: ['127.0.0.1'], timeoutMs: 2000 });
    assert.deepStrictEqual(found, { host: '127.0.0.1', port: 8790 });
    const none = await discoverBridge({ fingerprint: 'cd'.repeat(32), port: port - 1, targets: ['127.0.0.1'], timeoutMs: 300 });
    assert.strictEqual(none, null);
  } finally { srv.close(); }
});

test('broadcastTargets: глобальный адрес и направленные broadcast', () => {
  const list = broadcastTargets(() => ({
    Wi_Fi: [{ family: 4, address: '192.168.1.10', netmask: '255.255.255.0', internal: false }],
    lo: [{ family: 4, address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  }));
  assert.ok(list.includes('255.255.255.255'));
  assert.ok(list.includes('192.168.1.255'));
  assert.ok(!list.includes('127.255.255.255'));
});
