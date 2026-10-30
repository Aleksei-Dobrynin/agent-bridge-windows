'use strict';
// Интеграция: сессия через keeper по named pipe переживает перезапуск моста; cwd канонизируется
// (D-7); restoreSessions не верит meta с чужим pipe/секретом (ревью M-3) и не удаляет meta
// живого keeper'а (M-6); статус хука без прототипных ключей (M-3); окружение агента (M-11).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const K = require('../lib/keeper-channel');
const H = require('./helpers/bridge');

const home = H.tempHome('cb-sess-');
const port = H.pickPort(19790);
const bridges = [];
const extra = [];
let pin, owner;

function startBridge() {
  const b = H.startBridge(home, port);
  bridges.push(b.proc);
  return b;
}
const connect = () => H.wsConnect(port, pin, { Authorization: 'Bearer ' + owner });
const lastSessions = (c) => (c.msgs.filter((m) => m.type === 'sessions').pop() || { sessions: [] }).sessions;
const screen = (c, id) => c.msgs
  .filter((m) => m.id === id && (m.type === 'output' || m.type === 'scrollback'))
  .map((m) => m.data).join('');
const metaFile = (id) => path.join(home, 'sessions', id + '.json');

test.before(async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', claudeCommand: process.execPath,
    claudeArgs: ['-e', "const e=process.env;console.log('ENV:'+[e.CLAUDE_BRIDGE_HOME,e.CLAUDE_BRIDGE_LISTEN_PORT," +
      "e.CLAUDE_BRIDGE_TEST,!!e.CLAUDE_BRIDGE_HOOK_TOKEN,e.CLAUDE_BRIDGE_PORT].join('|'));" +
      "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
    defaultCwd: home, projects: [home], env: {}, scrollbackBytes: 65536,
  }));
  startBridge();
  ({ owner, pin } = await H.ownerAndPin(home));
});

test.after(() => H.cleanup(home, [...bridges, ...extra]));

test('session survives bridge restart; restore ignores forged meta, keeps meta of a live keeper', { timeout: 120000 }, async () => {
  let c = null;
  assert.ok(await H.waitFor(async () => (c = await connect())), 'connected to bridge');
  c.send({ type: 'create', cwd: home.toUpperCase(), args: [] });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'created')), 'created');
  const id = c.msgs.find((m) => m.type === 'created').id;

  // meta на диске: pipe/secret/hookToken/keeperPid есть, env агента сюда не пишется
  const meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
  assert.match(meta.pipe, /^\\\\\.\\pipe\\claude-bridge-[0-9a-f]{32}$/);
  assert.match(meta.secret, /^[0-9a-f]{64}$/);
  assert.match(meta.hookToken, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(meta.keeperPid) && meta.keeperPid > 0, 'keeperPid stored (M-6)');
  assert.strictEqual(meta.env, undefined);

  // keeper ответил на рукопожатие: hello -> pid в списке сессий
  assert.ok(await H.waitFor(() => { const s = lastSessions(c).find((x) => x.id === id); return s && s.pid; }),
    'keeper connected (hello)');
  c.send({ type: 'attach', id, cols: 80, rows: 24 });
  // M-11: агент не видит настроек самого моста, но получает данные для хука
  assert.ok(await H.waitFor(() => screen(c, id).includes(`ENV:|||true|${port}`)), 'agent env: ' + screen(c, id));
  c.send({ type: 'input', id, data: 'one\r' });
  assert.ok(await H.waitFor(() => screen(c, id).includes('ECHO:one')), 'echo before restart');
  const listed = lastSessions(c).find((s) => s.id === id);
  assert.strictEqual(listed.cwd, fs.realpathSync.native(home), 'cwd canonicalized (D-7)');

  // M-3: имя события хука не может быть ключом прототипа
  const hook = (event) => H.request(port, pin, {
    path: '/hook', method: 'POST',
    headers: { 'X-Bridge-Session': id, Authorization: 'Bearer ' + meta.hookToken, 'Content-Type': 'application/json' },
  }, JSON.stringify({ hook_event_name: event }));
  for (const ev of ['__proto__', 'constructor', 'toString', 'UserPromptSubmit']) {
    assert.strictEqual((await hook(ev)).statusCode, 200, ev);
  }
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'status' && m.id === id)), 'status for UserPromptSubmit');
  const statuses = c.msgs.filter((m) => m.type === 'status' && m.id === id).map((m) => m.status);
  assert.deepStrictEqual(statuses, ['working'], 'only the real event changed status');
  assert.ok(await H.waitFor(() => lastSessions(c).find((s) => s.id === id).status === 'working'), 'status in list');
  c.ws.close();

  // мост падает; keeper (detached) живёт
  const old = bridges[bridges.length - 1];
  const oldExited = new Promise((r) => old.on('exit', r));
  old.kill();
  await oldExited;

  // поддельные meta: UNC-pipe (SMB/NTLM, ревью M-3) и неверный секрет — мост не должен им верить
  const forgedPipe = metaFile('s900-aaaaaa');
  fs.writeFileSync(forgedPipe, JSON.stringify({
    id: 's900-aaaaaa', pipe: '\\\\127.0.0.1\\pipe\\claude-bridge-' + '0'.repeat(32),
    secret: 'a'.repeat(64), cwd: home, title: 'forged', createdAt: Date.now(),
  }));
  fs.writeFileSync(metaFile('s901-bbbbbb'), JSON.stringify({
    id: 's901-bbbbbb', pipe: '\\\\.\\pipe\\claude-bridge-' + '1'.repeat(32),
    secret: 'not-hex', cwd: home, title: 'forged', createdAt: Date.now(),
  }));
  // M-6: keeper «жив» (процесс есть), но pipe не отвечает -> meta не удалять;
  // keeper мёртв -> meta удалить
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  extra.push(sleeper);
  const sleeperExited = new Promise((r) => sleeper.on('exit', r));
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => dead.on('exit', r));
  const restorable = (sid, keeperPid) => fs.writeFileSync(metaFile(sid), JSON.stringify({
    id: sid, pipe: K.pipeName(), secret: crypto.randomBytes(32).toString('hex'), keeperPid,
    cwd: home, title: 'stale', createdAt: Date.now(),
  }));
  restorable('s902-cccccc', sleeper.pid);
  restorable('s903-dddddd', dead.pid);

  startBridge();
  c = null;
  assert.ok(await H.waitFor(async () => (c = await connect()), 30000), 'reconnected after restart');
  assert.ok(await H.waitFor(() => { const s = lastSessions(c).find((x) => x.id === id); return s && s.alive && s.pid; }),
    'session restored after restart');
  c.send({ type: 'attach', id, cols: 80, rows: 24 });
  assert.ok(await H.waitFor(() => screen(c, id).includes('ECHO:one')), 'scrollback kept by keeper');
  c.send({ type: 'input', id, data: 'two\r' });
  assert.ok(await H.waitFor(() => screen(c, id).includes('ECHO:two')), 'echo after restart');

  assert.ok(await H.waitFor(() => !fs.existsSync(metaFile('s903-dddddd')), 15000), 'meta of a dead keeper removed');
  // отрицательная проверка (ограниченное ожидание неизбежно): старый мост удалял meta через ~1-2 с
  assert.strictEqual(await H.waitFor(() => !fs.existsSync(metaFile('s902-cccccc')), 4000), false,
    'meta of a live keeper kept while retrying');
  sleeper.kill();
  await sleeperExited;
  assert.ok(await H.waitFor(() => !fs.existsSync(metaFile('s902-cccccc')), 15000), 'meta removed once the keeper is dead');

  c.send({ type: 'kill', id });
  assert.ok(await H.waitFor(() => c.msgs.some((m) => m.type === 'exit' && m.id === id)), 'exit after kill');
  assert.ok(await H.waitFor(() => !fs.existsSync(metaFile(id))), 'meta removed by keeper');

  // мост, поверивший поддельному meta, пошёл бы по pipe и после повторов удалил бы файл
  assert.ok(fs.existsSync(forgedPipe), 'bridge never acted on forged UNC meta');
  assert.ok(!c.msgs.some((m) => m.id === 's900-aaaaaa' || m.id === 's901-bbbbbb'), 'no events for forged sessions');
  assert.ok(!c.msgs.some((m) => m.type === 'sessions' &&
    m.sessions.some((s) => s.id === 's900-aaaaaa' || s.id === 's901-bbbbbb')), 'forged sessions never listed');
  c.ws.close();
});
