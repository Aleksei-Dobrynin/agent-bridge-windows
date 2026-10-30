'use strict';
// Интеграция Task 11: сессия через keeper по named pipe переживает перезапуск моста;
// cwd канонизируется (D-7); restoreSessions не верит meta с чужим pipe/секретом (ревью M-3).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { pinnedTlsOptions } = require('../lib/cert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sess-'));
const port = 19790 + Math.floor(Math.random() * 300) * 3;
const env = { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TEST: '1' };
let proc, pin, owner;

function startBridge() {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore', windowsHide: true });
  const p = proc;
  p.exited = new Promise((r) => p.on('exit', r));
}
function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers: { Authorization: 'Bearer ' + owner } });
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.on('error', () => resolve(null));
  });
}
const lastSessions = (c) => (c.msgs.filter((m) => m.type === 'sessions').pop() || { sessions: [] }).sessions;
const screen = (c, id) => c.msgs
  .filter((m) => m.id === id && (m.type === 'output' || m.type === 'scrollback'))
  .map((m) => m.data).join('');

// keeper'ы отсоединены и переживают мост: ищем их по каталогу данных теста в командной строке
function keeperPids() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:CB_TEST_HOME) -and ' +
    "$_.CommandLine.Contains('keeper.js') } | ForEach-Object { $_.ProcessId }"],
  { env: { ...process.env, CB_TEST_HOME: home }, encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter((x) => /^\d+$/.test(x));
}

test.before(async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', claudeCommand: process.execPath,
    claudeArgs: ['-e', "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
    defaultCwd: home, projects: [home], env: {}, scrollbackBytes: 65536,
  }));
  startBridge();
  const cer = path.join(home, 'certs', 'bridge.cer');
  assert.ok(await waitFor(() => fs.existsSync(path.join(home, 'owner.token')) && fs.existsSync(cer), 60000),
    'bridge created owner.token and certificate');
  owner = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
  const der = fs.readFileSync(cer);
  pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), crypto.createHash('sha256').update(der).digest('hex'));
});

test.after(async () => {
  if (proc && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  for (const pid of keeperPids()) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
  await waitFor(() => keeperPids().length === 0, 10000);
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(home, { recursive: true, force: true }); break; } catch { await sleep(200); }
  }
});

test('session survives bridge restart; restore ignores forged meta', { timeout: 120000 }, async () => {
  let c = null;
  assert.ok(await waitFor(async () => (c = await connect())), 'connected to bridge');
  c.send({ type: 'create', cwd: home.toUpperCase(), args: [] });
  assert.ok(await waitFor(() => c.msgs.some((m) => m.type === 'created')), 'created');
  const id = c.msgs.find((m) => m.type === 'created').id;

  // meta на диске: pipe/secret/hookToken есть, но env агента сюда не пишется
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'sessions', id + '.json'), 'utf8'));
  assert.match(meta.pipe, /^\\\\\.\\pipe\\claude-bridge-[0-9a-f]{32}$/);
  assert.match(meta.secret, /^[0-9a-f]{64}$/);
  assert.match(meta.hookToken, /^[0-9a-f]{64}$/);
  assert.strictEqual(meta.env, undefined);

  // keeper ответил на рукопожатие: hello -> pid в списке сессий
  assert.ok(await waitFor(() => { const s = lastSessions(c).find((x) => x.id === id); return s && s.pid; }),
    'keeper connected (hello)');
  c.send({ type: 'attach', id, cols: 80, rows: 24 });
  c.send({ type: 'input', id, data: 'one\r' });
  assert.ok(await waitFor(() => screen(c, id).includes('ECHO:one')), 'echo before restart');
  const listed = lastSessions(c).find((s) => s.id === id);
  assert.strictEqual(listed.cwd, fs.realpathSync.native(home), 'cwd canonicalized (D-7)');
  c.ws.close();

  // мост падает; keeper (detached) живёт
  const old = proc;
  old.kill();
  await old.exited;

  // поддельные meta: UNC-pipe (SMB/NTLM, ревью M-3) и неверный секрет — мост не должен им верить
  const forgedPipe = path.join(home, 'sessions', 's900-aaaaaa.json');
  fs.writeFileSync(forgedPipe, JSON.stringify({
    id: 's900-aaaaaa', pipe: '\\\\127.0.0.1\\pipe\\claude-bridge-' + '0'.repeat(32),
    secret: 'a'.repeat(64), cwd: home, title: 'forged', createdAt: Date.now(),
  }));
  fs.writeFileSync(path.join(home, 'sessions', 's901-bbbbbb.json'), JSON.stringify({
    id: 's901-bbbbbb', pipe: '\\\\.\\pipe\\claude-bridge-' + '1'.repeat(32),
    secret: 'not-hex', cwd: home, title: 'forged', createdAt: Date.now(),
  }));

  startBridge();
  c = null;
  assert.ok(await waitFor(async () => (c = await connect()), 30000), 'reconnected after restart');
  const first = lastSessions(c);
  assert.ok(!first.some((s) => s.id === 's900-aaaaaa' || s.id === 's901-bbbbbb'), 'forged meta not restored');
  assert.ok(await waitFor(() => { const s = lastSessions(c).find((x) => x.id === id); return s && s.alive && s.pid; }),
    'session restored after restart');
  c.send({ type: 'attach', id, cols: 80, rows: 24 });
  assert.ok(await waitFor(() => screen(c, id).includes('ECHO:one')), 'scrollback kept by keeper');
  c.send({ type: 'input', id, data: 'two\r' });
  assert.ok(await waitFor(() => screen(c, id).includes('ECHO:two')), 'echo after restart');

  c.send({ type: 'kill', id });
  assert.ok(await waitFor(() => c.msgs.some((m) => m.type === 'exit' && m.id === id)), 'exit after kill');
  assert.ok(await waitFor(() => !fs.existsSync(path.join(home, 'sessions', id + '.json'))), 'meta removed by keeper');

  // Отрицательная проверка (ограниченное ожидание неизбежно): мост, поверивший поддельному
  // meta, пошёл бы по pipe и после неудачных повторов (~1-2 с) удалил бы файл и разослал exit.
  assert.strictEqual(await waitFor(() => !fs.existsSync(forgedPipe), 4000), false,
    'bridge never acted on forged UNC meta');
  assert.ok(!c.msgs.some((m) => m.id === 's900-aaaaaa' || m.id === 's901-bbbbbb'), 'no events for forged sessions');
  assert.ok(!c.msgs.some((m) => m.type === 'sessions' &&
    m.sessions.some((s) => s.id === 's900-aaaaaa' || s.id === 's901-bbbbbb')), 'forged sessions never listed');
  c.ws.close();
});
