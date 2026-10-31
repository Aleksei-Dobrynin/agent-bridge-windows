'use strict';
// Общие помощники интеграционных тестов моста (не *.test.js — сам по себе не запускается).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { pinnedTlsOptions } = require('../../lib/cert');

const SERVER = path.join(__dirname, '..', '..', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

/** Диапазоны портов, зарезервированные Windows (Hyper-V/WSL/winnat): bind туда даёт EACCES. */
let excluded = null;
function excludedRanges() {
  if (excluded) return excluded;
  excluded = [];
  for (const proto of ['tcp', 'udp']) {
    const r = spawnSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', `protocol=${proto}`],
      { encoding: 'utf8', windowsHide: true });
    for (const m of String(r.stdout || '').matchAll(/^\s*(\d+)\s+(\d+)/gm)) excluded.push([+m[1], +m[2]]);
  }
  return excluded;
}

/** Порт из диапазона [base, base+900), шаг 3: port, port+1 (маяк), port+2 (туннель);
 *  тройка не пересекается с зарезервированными Windows диапазонами. */
function pickPort(base) {
  for (let i = 0; i < 1000; i++) {
    const p = base + Math.floor(Math.random() * 300) * 3;
    if (!excludedRanges().some(([lo, hi]) => p + 2 >= lo && p <= hi)) return p;
  }
  throw new Error('no free port triple near ' + base);
}

function tempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Запустить мост; stderr копится в b.stderr, b.exited — промис кода выхода. */
function startBridge(home, port, extraEnv = {}) {
  const env = {
    ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_LISTEN_PORT: String(port),
    CLAUDE_BRIDGE_TEST: '1', ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]; // extraEnv {X: undefined} — убрать X
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const b = { proc, stderr: '' };
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { b.stderr += d; });
  b.exited = new Promise((r) => proc.on('exit', (code) => r(code)));
  return b;
}

/** Дождаться owner.token и сертификата; вернуть { owner, pin }. */
async function ownerAndPin(home) {
  const cer = path.join(home, 'certs', 'bridge.cer');
  const tok = path.join(home, 'owner.token');
  if (!await waitFor(() => fs.existsSync(tok) && fs.existsSync(cer), 60000)) {
    throw new Error('bridge did not create owner.token/certificate');
  }
  const der = fs.readFileSync(cer);
  return {
    owner: fs.readFileSync(tok, 'utf8').trim(),
    pin: pinnedTlsOptions(new crypto.X509Certificate(der).toString(),
      crypto.createHash('sha256').update(der).digest('hex')),
  };
}

/** HTTPS-запрос с пиннингом; новое соединение на каждый запрос (agent:false). null при ошибке. */
function request(port, pin, opts, body) {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, agent: false, ...pin, ...opts }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { res.body = data; resolve(res); });
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/** Открыть WS; resolve { ws, msgs, send } или null. */
function wsConnect(port, pin, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers });
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.on('error', () => resolve(null));
    ws.on('unexpected-response', (req) => { req.destroy(); resolve(null); });
  });
}

/** PID процессов node, в командной строке которых есть каталог данных теста (keeper'ы). */
function keeperPids(home) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:CB_TEST_HOME) -and ' +
    "$_.CommandLine.Contains('keeper.js') } | ForEach-Object { $_.ProcessId }"],
  { env: { ...process.env, CB_TEST_HOME: home }, encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').split(/\s+/).filter((x) => /^\d+$/.test(x));
}

function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** Убить мосты, keeper'ы этого каталога и удалить каталог. */
async function cleanup(home, procs = []) {
  for (const p of procs) if (p && p.pid) killTree(p.pid);
  for (const pid of keeperPids(home)) killTree(pid);
  await waitFor(() => keeperPids(home).length === 0, 10000);
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(home, { recursive: true, force: true }); return; } catch { await sleep(200); }
  }
}

// ---------------------------------------------------------------- стенд подплана 2
// Мост в изолированном каталоге с конфигом агентов, клиенты с ожиданием сообщений и вывода.

const FAKE_AGENT = path.join(__dirname, '..', 'fixtures', 'fake-agent.js');
const DEVICE = { id: 'devtest00001', token: 'd'.repeat(48), name: 'Test phone', addedAt: '2026-10-31T00:00:00.000Z' };

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '');
}

/** WS-клиент: msgs, mark() — позиция для wait(…, since), вывод сессий без ANSI. */
async function connectClient(port, pin, token) {
  const c = await wsConnect(port, pin, { Authorization: 'Bearer ' + token });
  if (!c) throw new Error('WS не подключился');
  const out = {};
  c.ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'scrollback') out[m.id] = m.data;
    else if (m.type === 'output') out[m.id] = (out[m.id] || '') + m.data;
  });
  return Object.assign(c, {
    mark: () => c.msgs.length,
    async wait(pred, timeoutMs = 10000, since = 0) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        for (let i = since; i < c.msgs.length; i++) if (pred(c.msgs[i])) return c.msgs[i];
        if (Date.now() > end) throw new Error('не дождались сообщения');
        await sleep(50);
      }
    },
    async waitOutput(id, re, timeoutMs = 15000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const m = stripAnsi(out[id] || '').match(re);
        if (m) return m;
        if (Date.now() > end) throw new Error(`не дождались вывода ${re}; хвост: ${JSON.stringify(stripAnsi(out[id] || '').slice(-300))}`);
        await sleep(100);
      }
    },
    output: (id) => stripAnsi(out[id] || ''),
    close: () => { try { c.ws.close(); } catch { /* закрыт */ } },
  });
}

/** create + attach; resolve: сообщение created | error | createConflict. */
async function createAndAttach(c, msg) {
  const at = c.mark();
  c.send({ type: 'create', ...msg });
  const r = await c.wait((m) => m.type === 'created' || m.type === 'error' || m.type === 'createConflict', 20000, at);
  if (r.type === 'created') c.send({ type: 'attach', id: r.id, cols: 120, rows: 30 });
  return r;
}

/** Мост с заданным конфигом и сопряжёнными устройствами; stop() гасит мост, keeper'ы и каталог. */
async function startTestBridge({ config = {}, devices = [], prefix = 'cb-it-' } = {}) {
  const home = tempHome(prefix);
  const cwd = fs.realpathSync.native(home);
  const port = pickPort(22000);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', defaultCwd: cwd, projects: [cwd], env: {}, scrollbackBytes: 65536, ...config,
  }));
  if (devices.length) fs.writeFileSync(path.join(home, 'pairings.json'), JSON.stringify({ devices }));
  const bridge = startBridge(home, port);
  const clients = [];
  let pin;
  let owner;
  try {
    ({ owner, pin } = await ownerAndPin(home));
  } catch (e) {
    await cleanup(home, [bridge.proc]);
    throw new Error(e.message + '; stderr: ' + bridge.stderr);
  }
  return {
    home, cwd, port, owner, pin, bridge,
    async connect(token) {
      let c = null;
      if (!await waitFor(async () => { try { c = await connectClient(port, pin, token); return true; } catch { return false; } }, 30000)) {
        throw new Error('WS не подключился; stderr: ' + bridge.stderr);
      }
      clients.push(c);
      return c;
    },
    postHook(sid, token, payload) {
      return request(port, pin, {
        path: '/hook', method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Bridge-Session': sid },
      }, JSON.stringify(payload)).then((r) => (r ? r.statusCode : 'error'));
    },
    async stop() {
      for (const c of clients) c.close();
      await cleanup(home, [bridge.proc]);
    },
  };
}

module.exports = {
  sleep, waitFor, pickPort, tempHome, startBridge, ownerAndPin, request, wsConnect, keeperPids, killTree, cleanup,
  FAKE_AGENT, DEVICE, stripAnsi, connectClient, createAndAttach, startTestBridge,
};
