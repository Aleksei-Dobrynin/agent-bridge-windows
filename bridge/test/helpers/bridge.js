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

/** Порт из диапазона [base, base+900), шаг 3: port, port+1 (маяк), port+2 (туннель). */
function pickPort(base) {
  return base + Math.floor(Math.random() * 300) * 3;
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

module.exports = {
  sleep, waitFor, pickPort, tempHome, startBridge, ownerAndPin, request, wsConnect, keeperPids, killTree, cleanup,
};
