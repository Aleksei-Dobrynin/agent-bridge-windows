'use strict';
// Устойчивость моста: STT без python (I-1), занятый порт туннеля (I-2), занятый основной
// порт, проверка порта (M-7), ошибка создания сессии (M-8).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const H = require('./helpers/bridge');

const DEVICE = 'd'.repeat(48);

test('bad port in env override or config: clear error and exit 1 (M-7)', { timeout: 60000 }, async (t) => {
  const home = H.tempHome('cb-rob-');
  const procs = [];
  t.after(() => H.cleanup(home, procs));
  const port = H.pickPort(21790);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, host: '127.0.0.1' }));

  const a = H.startBridge(home, port, { CLAUDE_BRIDGE_LISTEN_PORT: '70000' });
  procs.push(a.proc);
  const codeA = await Promise.race([a.exited, H.sleep(30000).then(() => 'still running')]);
  assert.strictEqual(codeA, 1, 'env 70000');
  assert.match(a.stderr, /порт/i);

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 'abc', host: '127.0.0.1' }));
  const b = H.startBridge(home, port, { CLAUDE_BRIDGE_LISTEN_PORT: undefined });
  procs.push(b.proc);
  const codeB = await Promise.race([b.exited, H.sleep(30000).then(() => 'still running')]);
  assert.strictEqual(codeB, 1, 'config "abc"');
  assert.match(b.stderr, /порт/i);
});

test('stt without python, busy tunnel port, busy main port, failing create', { timeout: 120000 }, async (t) => {
  const home = H.tempHome('cb-rob-');
  const port = H.pickPort(21790);
  const procs = [];
  // I-2: локальный порт туннеля занят чужим процессом ещё до старта моста
  const squatter = net.createServer().listen(port + 2, '127.0.0.1');
  await new Promise((r) => squatter.once('listening', r));
  t.after(async () => { squatter.close(); await H.cleanup(home, procs); });

  // порт в конфиге строкой — приводится к числу (M-7)
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port: String(port), host: '127.0.0.1', sttPython: 'nonexistent-python-xyz',
    defaultAgent: 'idle',
    agents: { idle: { type: 'generic', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } },
    defaultCwd: home, projects: [home], env: {},
  }));
  fs.writeFileSync(path.join(home, 'internet.json'), JSON.stringify({ enabled: true }));
  fs.writeFileSync(path.join(home, 'pairings.json'), JSON.stringify({
    devices: [H.pairingRecord({ token: DEVICE, name: 'test', addedAt: new Date().toISOString() })],
  }));

  const b = H.startBridge(home, port, { CLAUDE_BRIDGE_LISTEN_PORT: undefined });
  procs.push(b.proc);
  const { owner, pin } = await H.ownerAndPin(home);
  const health = async () => {
    const r = await H.request(port, pin, { path: '/health', headers: { Authorization: 'Bearer ' + owner } });
    return r && r.statusCode === 200;
  };
  assert.ok(await H.waitFor(health, 30000), 'bridge serves /health with tunnel port busy (I-2): ' + b.stderr);

  // I-1: python не найден -> 500, мост жив
  const stt = await H.request(port, pin, {
    path: '/stt', method: 'POST', headers: { Authorization: 'Bearer ' + DEVICE, 'Content-Type': 'audio/mp4' },
  }, Buffer.alloc(1024));
  assert.ok(stt, 'stt answered');
  assert.strictEqual(stt.statusCode, 500);
  await H.sleep(300);
  assert.ok(await health(), 'bridge alive after failed stt');

  // M-8: создание сессии падает (каталог сессий подменён файлом) -> ошибка клиенту, мост жив
  fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
  fs.writeFileSync(path.join(home, 'sessions'), 'not a directory');
  const c = await H.wsConnect(port, pin, { Authorization: 'Bearer ' + owner });
  assert.ok(c, 'ws connected');
  c.send({ type: 'create', cwd: home });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'error')), 'error sent to requester');
  assert.ok(!c.msgs.some((m) => m.type === 'created'), 'no created');
  assert.ok(!c.msgs.some((m) => m.type === 'sessions' && m.sessions.length), 'no half-created session listed');
  c.ws.close();
  assert.ok(await health(), 'bridge alive after failed create');

  fs.rmSync(path.join(home, 'sessions'), { force: true });
  fs.mkdirSync(path.join(home, 'sessions'));

  // основной порт занят (первым мостом): понятное сообщение и выход с кодом 1
  const second = H.startBridge(home, port, { CLAUDE_BRIDGE_LISTEN_PORT: undefined });
  procs.push(second.proc);
  const code = await Promise.race([second.exited, H.sleep(30000).then(() => 'still running')]);
  assert.strictEqual(code, 1);
  assert.match(second.stderr, new RegExp(`порт.*${port}`, 'i'));
  assert.ok(await health(), 'first bridge unaffected');
});

test('corrupt pairings.json: clear error and exit 1, not an empty device list (fail closed)', { timeout: 90000 }, async (t) => {
  const home = H.tempHome('cb-rob-pair-');
  const procs = [];
  t.after(() => H.cleanup(home, procs));
  const port = H.pickPort(21790);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, host: '127.0.0.1' }));
  for (const garbage of ['{not json', '[]', '"x"', 'null', '{"devices":5}', '{"devices":[],"phoneRequired":"yes"}']) {
    fs.writeFileSync(path.join(home, 'pairings.json'), garbage);
    const b = H.startBridge(home, port);
    procs.push(b.proc);
    const code = await Promise.race([b.exited, H.sleep(40000).then(() => 'still running')]);
    assert.strictEqual(code, 1, garbage);
    assert.match(b.stderr, /pairings\.json повреждён — исправьте или удалите файл при остановленном мосте/, garbage);
    assert.strictEqual(fs.readFileSync(path.join(home, 'pairings.json'), 'utf8'), garbage, 'file left untouched');
  }
});
