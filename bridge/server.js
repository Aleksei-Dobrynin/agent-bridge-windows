#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { Bonjour } = require('bonjour-service');

const { ensureDataDirs } = require('./lib/datadir');
const P = require('./lib/paths');
const T = require('./lib/tokens');
const V = require('./lib/validate');
const { originAllowed } = require('./lib/origin');
const { loadOrCreateCert } = require('./lib/cert');
const { installFileLog } = require('./lib/log');
const K = require('./lib/keeper-channel');
const { pickLanAddress } = require('./lib/lan');

const TEST_MODE = !!process.env.CLAUDE_BRIDGE_TEST; // тесты: без mDNS, QR и файлового лога
const DATA = ensureDataDirs();
if (!TEST_MODE) installFileLog(DATA.logs);

// Конфиг живёт в каталоге данных (D-9: без миграции старого bridge/config.json).
// config.json.env целиком попадает в окружение сессий; каталог данных — в профиле
// пользователя, закрытом ACL от других учётных записей (D-8).
if (!fs.existsSync(DATA.config)) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), DATA.config);
  console.log('  Создан ' + DATA.config + ' — отредактируйте его при необходимости');
}
const CONFIG = JSON.parse(fs.readFileSync(DATA.config, 'utf8'));
// Переопределение порта моста — CLAUDE_BRIDGE_LISTEN_PORT. CLAUDE_BRIDGE_PORT мост
// НЕ читает: это имя экспортируется агенту для хука (M-11).
// Порт: целое 1..65533 (port+1 — маяк, port+2 — туннель); числовая строка приводится (M-7).
function parsePort(v) {
  const n = (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 && n <= 65533 ? n : null;
}
{
  const fromEnv = process.env.CLAUDE_BRIDGE_LISTEN_PORT;
  const raw = fromEnv !== undefined && fromEnv !== '' ? fromEnv : CONFIG.port;
  const port = parsePort(raw);
  if (port === null) {
    console.error(`  Неверный порт моста: ${JSON.stringify(raw)} ` +
      `(${fromEnv ? 'CLAUDE_BRIDGE_LISTEN_PORT' : 'port в ' + DATA.config}) — нужно целое 1..65533`);
    process.exit(1);
  }
  CONFIG.port = port;
}
// expandConfigPath -> null для относительных путей и «голой» буквы диска: такие отбрасываем
CONFIG.projects = (Array.isArray(CONFIG.projects) ? CONFIG.projects : []).map(P.expandConfigPath).filter(Boolean);
CONFIG.defaultCwd = P.expandConfigPath(CONFIG.defaultCwd || '') || os.homedir();

const WEB_DIR = path.join(__dirname, 'web');
const VENDOR = {
  '/vendor/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
// Заголовки безопасности для статики: CSP как HTTP-заголовок (frame-ancestors
// в <meta> игнорируется), плюс защита от кликджекинга и MIME-sniffing.
const SEC_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- tls + auth

// Самоподписанный сертификат (P-4, PowerShell): телефон пиннит его отпечаток.
const CERT = loadOrCreateCert(DATA.certs);
const TLS = CERT.tls;
const FINGERPRINT = CERT.fingerprint;

// Токен владельца (P-1): полные локальные права. Файл в профиле пользователя (D-8).
let OWNER_TOKEN = T.loadOrCreateOwnerToken(DATA.ownerToken);
const loginTokens = new T.OneTimeTokens(60000);
// Токен браузера владельца (M-1): только в памяти, в cookie после входа по ott.
// Токен владельца в cookie не попадает; новый при каждом старте и при ротации.
let BROWSER_TOKEN = T.newToken();

// Доверенные устройства.
let pairings = { devices: [] };
try { pairings = JSON.parse(fs.readFileSync(DATA.pairings, 'utf8')); } catch { /* первый запуск */ }
if (!pairings || !Array.isArray(pairings.devices)) pairings = { devices: [] };
// Код сопряжения живёт 10 минут. Защита от перебора: 5 неверных попыток с адреса ->
// блокировка /pair на 15 минут; плюс общий предел попыток на текущий код (F11/F14).
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairGuard = new Map(); // ip -> { fails, blockedUntil }
let pairFailTotal = 0;
const PAIR_FAIL_TOTAL_MAX = 50;
// Код сопряжения НЕ выпускается при старте: только по запросу владельца (P-9).
let pairState = { code: '', expiresAt: 0 };
function regenPairCode() {
  pairFailTotal = 0;
  pairState = {
    // 5 байт = 40 бит энтропии: вместе с общим лимитом попыток перебор за окно неосуществим (F14)
    code: crypto.randomBytes(5).toString('hex').toUpperCase(),
    expiresAt: Date.now() + PAIR_TTL_MS,
  };
  return pairState;
}

// Публичный id устройства — хэш токена: по нему можно ссылаться, не раскрывая токен
function deviceIdOf(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}
for (const d of pairings.devices) if (!d.id) d.id = deviceIdOf(d.token);

function savePairings() {
  fs.writeFileSync(DATA.pairings, JSON.stringify(pairings, null, 2));
}

function bearer(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' && h.match(/^Bearer ([0-9a-f]{48,64})$/);
  return m ? m[1] : null;
}
function cookieTokenOf(req) {
  const c = req.headers.cookie;
  const m = typeof c === 'string' && c.match(/(?:^|;\s*)bridgeToken=([0-9a-f]+)/);
  return m ? V.cookieToken(m[1]) : null;
}
function requestToken(req) {
  return bearer(req) || cookieTokenOf(req);
}
/** Найти устройство по токену за постоянное время (без ранней утечки по '==='). */
function deviceByToken(t) {
  if (!t) return null;
  for (const d of pairings.devices) if (T.safeEq(d.token, t)) return d;
  return null;
}
/** Соединение с самого ПК на основной порт (трафик туннеля приходит на другой порт). */
function ownerSocket(req) {
  const a = req.socket.remoteAddress;
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return loopback && req.socket.localPort === CONFIG.port;
}
/** Владелец: loopback + основной порт + (Bearer-токен владельца | cookie с токеном браузера). */
function isOwner(req) {
  if (!ownerSocket(req)) return false;
  const b = bearer(req);
  if (b && T.safeEq(b, OWNER_TOKEN)) return true;
  const c = cookieTokenOf(req);
  return !!c && T.safeEq(c, BROWSER_TOKEN);
}
/** Кто это: 'owner' | устройство | null. Origin проверяется отдельно. */
function principal(req) {
  if (isOwner(req)) return 'owner';
  return deviceByToken(requestToken(req));
}
/** Отозвать устройство и немедленно разорвать его соединения. */
function revokeDeviceById(id) {
  const idx = pairings.devices.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  const name = pairings.devices[idx].name;
  pairings.devices.splice(idx, 1);
  savePairings();
  writeAllowFile(); // отозванный NodeId больше не в allowlist туннеля
  console.log(`\n  Устройство отозвано: ${name}`);
  for (const c of allClients) {
    if (c.deviceId === id) { try { c.close(4401, 'revoked'); } catch { /* закрыт */ } }
  }
  // Живое iroh-соединение отозванного узла не рвётся само: перезапуск туннеля
  // сбрасывает все p2p-соединения, легитимные устройства переподключатся.
  if (tunnel && inet.enabled) { stopTunnel(); startTunnel(); }
  return true;
}

// ---------------------------------------------------------------- sessions
// Каждая сессия живёт в отдельном процессе-хранителе (keeper.js) и общается с
// мостом через named pipe с взаимной HMAC-проверкой (D-11): перезапуск моста не
// убивает агента, а pipe без секрета сессии бесполезен (в т.ч. по SMB).

const SESS_DIR = DATA.sessions;
// Допустимые значения из meta-файла: только локальный pipe нашего вида (UNC в
// meta.pipe заставил бы мост пойти по SMB и отдать NTLM — ревью M-3) и секрет 64 hex.
const PIPE_RE = /^\\\\\.\\pipe\\claude-bridge-[0-9a-f]{32}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

const sessions = new Map(); // id -> session
let seq = 0;

// Защита от исчерпания ресурсов: потолок живых сессий и частоты их создания
// (каждая сессия — отдельный процесс-хранитель + PTY-ребёнок).
const MAX_SESSIONS = CONFIG.maxSessions || 24;
const createTimes = new Map(); // deviceId -> [timestamps]
function rateAllowCreate(deviceId) {
  const now = Date.now();
  const key = deviceId || 'anon';
  const arr = (createTimes.get(key) || []).filter((t) => now - t < 60000);
  createTimes.set(key, arr);
  if (arr.length >= 10) return false; // не более 10 создания сессий в минуту
  arr.push(now);
  return true;
}

function makeSession(meta) {
  return {
    id: meta.id,
    title: typeof meta.title === 'string' ? meta.title : meta.id,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
    command: meta.cmd,
    pid: null,
    createdAt: meta.createdAt,
    pipe: meta.pipe,
    secret: meta.secret,
    hookToken: typeof meta.hookToken === 'string' ? meta.hookToken : null,
    channel: null,
    buffer: [],
    bufferBytes: 0,
    clients: new Set(),
    alive: true,
    lastNotify: null,
    status: 'idle', // idle | working | waiting — по hooks
    cols: meta.cols,
    rows: meta.rows,
    keeperPid: Number.isInteger(meta.keeperPid) && meta.keeperPid > 0 ? meta.keeperPid : null,
    lastInput: null, // клиент, печатавший последним — его размер и держим
  };
}

function keeperSend(session, obj) {
  if (session.channel) session.channel.send(obj);
}

function dropSession(session, exitCode) {
  if (!sessions.has(session.id)) return;
  session.alive = false;
  broadcast({ type: 'exit', id: session.id, exitCode: exitCode == null ? -1 : exitCode });
  sessions.delete(session.id);
  broadcastSessions();
}

/** Жив ли процесс (signal 0 только проверяет). EPERM — процесс есть, но чужой. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const KEEPER_ALIVE_RETRY_MS = 30000;

// retries — быстрые повторы (keeper ещё поднимается); затем, пока процесс хранителя
// жив, — повторы с нарастающей паузой до KEEPER_ALIVE_RETRY_MS (M-6).
function connectKeeper(session, retries, state = { deadline: 0, delay: 500 }) {
  K.connectAuthenticated(session.pipe, session.secret).then((ch) => {
    // сессию успели убрать, пока шло рукопожатие — канал не нужен
    if (sessions.get(session.id) !== session) { ch.socket.destroy(); return; }
    session.channel = ch;
    ch.socket.on('error', () => { /* обрыв канала обработает 'close' */ });
    ch.socket.on('close', () => {
      if (session.channel === ch) { session.channel = null; dropSession(session, -1); }
    });
    ch.onMessage((m) => {
      if (m.t === 'hello') {
        session.pid = Number.isInteger(m.pid) ? m.pid : null;
        if (Number.isInteger(m.cols)) session.cols = m.cols;
        if (Number.isInteger(m.rows)) session.rows = m.rows;
        const buf = typeof m.buffer === 'string' ? m.buffer : '';
        session.buffer = [buf];
        session.bufferBytes = Buffer.byteLength(buf);
        // Клиент-создатель attach'ится РАНЬШЕ, чем мост дозвонится до хранителя
        // (created уходит сразу, hello — спустя ретраи). Всё, что агент успел
        // нарисовать до hello (напр. trust-промпт), есть только в этом буфере —
        // досылаем, иначе у клиента пустой экран до первого нажатия клавиши.
        if (buf) {
          const shot = JSON.stringify({
            type: 'scrollback', id: session.id, data: buf,
            alive: session.alive, cols: session.cols, rows: session.rows,
          });
          for (const ws of session.clients) if (ws.readyState === 1) ws.send(shot);
        }
        broadcastSessions();
      } else if (m.t === 'out' && typeof m.d === 'string') {
        session.buffer.push(m.d);
        session.bufferBytes += Buffer.byteLength(m.d);
        while (session.bufferBytes > (CONFIG.scrollbackBytes || 262144) && session.buffer.length > 1) {
          session.bufferBytes -= Buffer.byteLength(session.buffer.shift());
        }
        const msg = JSON.stringify({ type: 'output', id: session.id, data: m.d });
        for (const ws of session.clients) if (ws.readyState === 1) ws.send(msg);
      } else if (m.t === 'exit') {
        dropSession(session, Number.isInteger(m.code) ? m.code : -1);
      }
    });
  }).catch(() => {
    if (sessions.get(session.id) !== session) return; // сессия уже убрана
    if (retries > 0) { setTimeout(() => connectKeeper(session, retries - 1, state), 300); return; }
    if (pidAlive(session.keeperPid)) {
      if (!state.deadline) state.deadline = Date.now() + KEEPER_ALIVE_RETRY_MS;
      if (Date.now() < state.deadline) {
        const delay = state.delay;
        state.delay = Math.min(delay * 2, 4000);
        setTimeout(() => connectKeeper(session, 0, state), delay);
        return;
      }
      // процесс жив, но не отвечает: meta НЕ трогаем (следующий старт моста попробует снова)
      console.log(`  Сессия ${session.id}: хранитель (pid ${session.keeperPid}) жив, но не отвечает — сессия скрыта`);
      dropSession(session, -1);
      return;
    }
    // Хранитель мёртв: не поднялся или умер нечисто (краш, перезагрузка ПК)
    // и не убрал meta. Убираем сами — иначе мост при каждом старте будет
    // «восстанавливать» зомби-сессию.
    try { fs.unlinkSync(path.join(SESS_DIR, session.id + '.json')); } catch { /* уже удалён */ }
    console.log(`  Сессия ${session.id}: хранитель не отвечает — meta убран`);
    dropSession(session, -1);
  });
}

const BRIDGE_OWN_ENV = ['CLAUDE_BRIDGE_HOME', 'CLAUDE_BRIDGE_LISTEN_PORT', 'CLAUDE_BRIDGE_TEST'];

function createSession({ cwd, command, args, title, local }) {
  const id = 's' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
  // Произвольную КОМАНДУ выбирают только локальные клиенты (владелец): телефон
  // всегда запускает настроенный агент. Аргументы телефон задаёт сам — это его
  // штатные опции запуска, а сопряжённое устройство и так управляет PTY.
  // КАТАЛОГ телефона ограничен разрешёнными проектами (D-7), путь — канонический
  // (иначе --resume не найдёт беседы при другом регистре/8.3/junction).
  const cmd = (local && command) ? command : CONFIG.claudeCommand;
  const cmdArgs = (args && args.length) ? args : (CONFIG.claudeArgs || []);
  const fallback = P.canonicalDir(CONFIG.defaultCwd) || CONFIG.defaultCwd;
  const dir = local
    ? P.resolveLocalCwd(cwd, fallback)
    : P.resolveRemoteCwd(cwd, CONFIG.projects, fallback);

  // Секрет канала keeper<->мост и токен хука сессии (P-1): у каждой сессии свои.
  const secret = crypto.randomBytes(32).toString('hex');
  const hookToken = T.newToken();
  const meta = {
    id,
    cmd,
    args: cmdArgs,
    cwd: dir,
    title: title || `${path.basename(dir)} · ${path.basename(String(cmd))}`,
    createdAt: Date.now(),
    cols: 100,
    rows: 30,
    scrollbackBytes: CONFIG.scrollbackBytes || 262144,
    pipe: K.pipeName(),
    secret,
    hookToken,
  };
  // env НЕ пишем в meta-файл: process.env может содержать секреты, а файл
  // остаётся на диске. Окружение передаётся хранителю через сам процесс;
  // CLAUDE_BRIDGE_KEEPER_SECRET keeper удаляет до запуска агента.
  const extraEnv = (CONFIG.env && typeof CONFIG.env === 'object' && !Array.isArray(CONFIG.env)) ? CONFIG.env : {};
  const baseEnv = { ...process.env };
  // настройки самого моста агенту не передаются (M-11): иначе мост, запущенный
  // из сессии, унаследовал бы чужой каталог данных/порт/тестовый режим
  for (const k of BRIDGE_OWN_ENV) delete baseEnv[k];
  const childEnv = {
    ...baseEnv, ...extraEnv,
    CLAUDE_BRIDGE_SESSION: id,
    CLAUDE_BRIDGE_HOOK_TOKEN: hookToken,
    CLAUDE_BRIDGE_PORT: String(CONFIG.port),
    CLAUDE_BRIDGE_CERT_FP: FINGERPRINT,
    CLAUDE_BRIDGE_KEEPER_SECRET: secret,
    FORCE_COLOR: '3',
  };
  const metaPath = path.join(SESS_DIR, id + '.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, 'keeper.js'), metaPath], {
      detached: true, windowsHide: true, stdio: 'ignore', env: childEnv,
    });
  } catch (e) {
    try { fs.unlinkSync(metaPath); } catch { /* */ }
    throw e;
  }
  child.on('error', (e) => console.error(`  Сессия ${id}: не удалось запустить хранитель:`, e.message));
  child.unref();
  // M-6: pid хранителя — в meta: после перезапуска моста по нему видно, жив ли он.
  // Перезапись сразу после spawn — до того, как keeper успеет прочитать meta;
  // через временный файл + rename, чтобы keeper не увидел половину файла.
  if (Number.isInteger(child.pid)) {
    meta.keeperPid = child.pid;
    try {
      fs.writeFileSync(metaPath + '.tmp', JSON.stringify(meta));
      fs.renameSync(metaPath + '.tmp', metaPath);
    } catch { try { fs.unlinkSync(metaPath + '.tmp'); } catch { /* */ } }
  }

  const session = makeSession(meta);
  sessions.set(id, session);
  connectKeeper(session, 20);
  broadcastSessions();
  return session;
}

// Восстановление живых сессий после перезапуска моста: meta-файл + рукопожатие по pipe.
function restoreSessions() {
  let restored = 0;
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      if (!meta || typeof meta !== 'object' || !V.sessionId(meta.id) || f !== meta.id + '.json') continue;
      if (typeof meta.pipe !== 'string' || !PIPE_RE.test(meta.pipe)) continue;
      if (typeof meta.secret !== 'string' || !SECRET_RE.test(meta.secret)) continue;
      const n = parseInt(meta.id.slice(1), 10);
      if (n > seq) seq = n;
      const session = makeSession(meta);
      sessions.set(meta.id, session);
      connectKeeper(session, 3);
      restored++;
    } catch { /* битый meta — пропускаем */ }
  }
  if (restored) console.log(`  Восстановлено сессий: ${restored}`);
}

// Политика размера PTY: «размер следует за тем, кто печатает».
// Подключение зрителя размер не меняет.
function resizePty(session, cols, rows) {
  if (!session.alive || !(cols > 0) || !(rows > 0)) return;
  if (session.cols === cols && session.rows === rows) return;
  keeperSend(session, { t: 'resize', cols, rows });
  session.cols = cols;
  session.rows = rows;
  const msg = JSON.stringify({ type: 'resized', id: session.id, cols, rows });
  for (const ws of session.clients) if (ws.readyState === 1) ws.send(msg);
}

function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    pid: s.pid,
    alive: s.alive,
    status: s.status,
    createdAt: s.createdAt,
    lastNotify: s.lastNotify,
  }));
}

// ---------------------------------------------------------------- stt
// Постоянный python-воркер с faster-whisper: модель грузится один раз.

let sttProc = null;
let sttQueue = [];

function failStt(proc, reason) {
  if (sttProc !== proc) return; // уже обработано ('error' и 'exit' могут прийти оба)
  sttProc = null;
  for (const j of sttQueue) j.reject(new Error(reason));
  sttQueue = [];
}

// Python на Windows — через лаунчер `py` с выбором версии (`-3.11`), см. config.example.json.
const STT_PYTHON = (typeof CONFIG.sttPython === 'string' && CONFIG.sttPython) || 'py';
const STT_PYTHON_ARGS = Array.isArray(CONFIG.sttPythonArgs) &&
  CONFIG.sttPythonArgs.every((a) => typeof a === 'string') ? CONFIG.sttPythonArgs : [];

function ensureStt() {
  if (sttProc) return;
  const proc = spawn(STT_PYTHON, [...STT_PYTHON_ARGS, path.join(__dirname, 'stt.py')], {
    env: {
      ...process.env,
      STT_MODEL: CONFIG.sttModel || 'large-v3',
      ...(CONFIG.sttPrompt ? { STT_PROMPT: CONFIG.sttPrompt } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  sttProc = proc;
  // I-1: без обработчика 'error' отсутствующий python (ENOENT) ронял весь мост
  proc.on('error', (e) => {
    console.error('[stt] не удалось запустить воркер (' + STT_PYTHON + '):', e.message);
    failStt(proc, 'STT-воркер не запустился');
  });
  proc.stdin.on('error', () => { /* воркер не запустился/умер — ответят 'error'/'exit' */ });
  let acc = '';
  proc.stdout.on('data', (d) => {
    acc += d.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { console.log('  STT-модель загружена'); continue; }
      const job = sttQueue.shift();
      if (job) (m.error ? job.reject(new Error(m.error)) : job.resolve(m.text || ''));
    }
  });
  proc.stderr.on('data', (d) => process.stderr.write('[stt] ' + d));
  proc.on('exit', () => failStt(proc, 'STT-воркер завершился'));
}

function transcribe(file) {
  ensureStt();
  return new Promise((resolve, reject) => {
    sttQueue.push({ resolve, reject });
    sttProc.stdin.write(JSON.stringify({ file, language: CONFIG.sttLanguage || 'ru' }) + '\n');
  });
}

// ---------------------------------------------------------------- internet (p2p iroh)
// Опциональный доступ через интернет: сайдкар claude-tunnel (Rust + iroh)
// принимает p2p-соединения и пробрасывает их на локальный порт туннеля.
// Включается только явно: claude-mobile --device -> «i».

const INET_FILE = DATA.internet;
const TUNNEL_BIN = path.join(__dirname, 'bin', 'claude-tunnel.exe');
const TUNNEL_PORT = CONFIG.port + 2; // локальный порт для трафика из туннеля
// allowlist iroh-узлов: телефон регистрирует свой NodeId (по LAN, через
// защищённый WS), сюда пишутся id всех сопряжённых устройств. Туннель
// перечитывает файл на каждое соединение и пускает только известные узлы.
const ALLOW_FILE = path.join(DATA.certs, 'tunnel-allow.txt');

function writeAllowFile() {
  const ids = pairings.devices
    .map((d) => (d.nodeId || '').trim().toLowerCase())
    .filter((x) => /^[0-9a-f]{64}$/.test(x));
  // каталог данных в профиле пользователя закрыт ACL (D-8): mode 0o600 на Windows не нужен
  try { fs.writeFileSync(ALLOW_FILE, ids.join('\n') + (ids.length ? '\n' : '')); } catch {}
}

let inet = { enabled: false };
try { inet = { ...inet, ...JSON.parse(fs.readFileSync(INET_FILE, 'utf8')) }; } catch { /* дефолт */ }

let tunnel = null; // процесс claude-tunnel
let tunnelInfo = { ticket: null, nodeId: null };
const tunnelPeers = new Map(); // id соединения -> { remote, path, addr, rttMs }
let tunnelRestartTimer = null;

function internetMsg() {
  return {
    type: 'internet',
    enabled: inet.enabled,
    available: fs.existsSync(TUNNEL_BIN),
    ticket: tunnelInfo.ticket,
    nodeId: tunnelInfo.nodeId,
    peers: [...tunnelPeers.values()],
  };
}
function broadcastInternet() { broadcast(internetMsg()); }

function startTunnel() {
  if (tunnel || !inet.enabled) return;
  // Тесты: сайдкар не запускаем — он ушёл бы в интернет (iroh relay), а taskkill
  // ниже погасил бы туннель настоящего моста пользователя.
  if (TEST_MODE) return;
  if (!fs.existsSync(TUNNEL_BIN)) {
    console.error('  Интернет-доступ включён, но bridge/bin/claude-tunnel.exe не собран');
    return;
  }
  // бесхозные туннели прошлых запусков (у них тот же ключ/NodeId) — убрать;
  // без шелла: путь установки не интерпретируется как команда
  try {
    spawnSync('taskkill', ['/IM', 'claude-tunnel.exe', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } catch { /* нет прав/нет процессов */ }
  writeAllowFile(); // актуальный allowlist к моменту старта туннеля
  const child = spawn(TUNNEL_BIN, [
    'listen',
    '--target', '127.0.0.1:' + TUNNEL_PORT,
    '--secret-file', path.join(DATA.certs, 'iroh.key'),
    '--allow-file', ALLOW_FILE,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  tunnel = child;
  child.on('error', (e) => console.error('  claude-tunnel не запустился:', e.message)); // затем 'exit'
  let acc = '';
  child.stdout.on('data', (d) => {
    acc += d.toString('utf8');
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event === 'ready') {
        tunnelInfo = { ticket: m.ticket, nodeId: m.node_id };
        console.log('  Интернет-доступ (iroh) активен, node: ' + (m.node_id || '').slice(0, 12) + '…');
      } else if (m.event === 'conn') {
        tunnelPeers.set(m.id, { remote: m.remote, path: null, addr: null, rttMs: null });
      } else if (m.event === 'path') {
        const peer = tunnelPeers.get(m.id) || {};
        tunnelPeers.set(m.id, { ...peer, path: m.path, addr: m.addr, rttMs: m.rtt_ms });
      } else if (m.event === 'close') {
        tunnelPeers.delete(m.id);
      }
      broadcastInternet();
    }
  });
  child.stderr.on('data', () => { /* отладка сайдкара не нужна в логе моста */ });
  child.on('exit', () => {
    if (tunnel !== child) return;
    tunnel = null;
    tunnelInfo = { ticket: null, nodeId: null };
    tunnelPeers.clear();
    broadcastInternet();
    if (inet.enabled) tunnelRestartTimer = setTimeout(startTunnel, 3000);
  });
}

function stopTunnel() {
  clearTimeout(tunnelRestartTimer);
  if (tunnel) { try { tunnel.kill(); } catch { } tunnel = null; }
  tunnelInfo = { ticket: null, nodeId: null };
  tunnelPeers.clear();
  broadcastInternet();
}

// Локальный порт туннеля слушается только при включённом интернет-доступе (I-2):
// занятый port+2 или порт из исключённого диапазона Windows не должен ронять мост.
let tunnelListening = false;
function listenTunnelServer() {
  if (tunnelListening) return;
  tunnelListening = true;
  tunnelServer.listen(TUNNEL_PORT, '127.0.0.1');
}
function closeTunnelServer() {
  if (!tunnelListening) return;
  tunnelListening = false;
  try { tunnelServer.close(); } catch { /* уже закрыт */ }
}

function setInternet(enabled) {
  inet.enabled = !!enabled;
  fs.writeFileSync(INET_FILE, JSON.stringify(inet, null, 2));
  console.log('\n  Доступ через интернет: ' + (inet.enabled ? 'ВКЛЮЧЁН' : 'выключен'));
  if (inet.enabled) { listenTunnelServer(); startTunnel(); } else { stopTunnel(); closeTunnelServer(); }
}

// ---------------------------------------------------------------- http

const HOOK_STATUS = new Map([
  ['UserPromptSubmit', 'working'], ['PostToolUse', 'working'], ['Notification', 'waiting'], ['Stop', 'idle'],
]);

function httpHandler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); res.end(); return; }
  // Второй слой против CSWSH/CSRF (H-1): браузер с чужой страницы шлёт свой Origin.
  if (!originAllowed(req.headers.origin, CONFIG.port)) {
    res.writeHead(403); res.end(); return;
  }

  // Сопряжение нового устройства: одноразовый код -> постоянный токен
  if (req.method === 'POST' && url.pathname === '/pair') {
    // только по основному порту (LAN/локально): туннель поднимается уже ПОСЛЕ
    // сопряжения, а пускать интернет-пиров к /pair (и давать им забивать
    // блокировку перебора для всех) незачем
    if (req.socket.localPort !== CONFIG.port) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let raw = null;
      try { raw = JSON.parse(body || 'null'); } catch { /* невалидный JSON */ }
      const p = V.pairBody(raw); // M-2: null / не-строка в code больше не роняют мост
      if (!p) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"неверный запрос"}');
        return;
      }
      const ip = req.socket.remoteAddress || 'unknown';
      // Бэкстоп роста карты: удаляем ТОЛЬКО адреса без активной блокировки —
      // иначе атакующий сбрасывал бы свою блокировку, раздув карту (F11).
      if (pairGuard.size > 4096) {
        const now = Date.now();
        for (const [k, v] of pairGuard) if (v.blockedUntil < now) pairGuard.delete(k);
      }
      // Общий предел неверных попыток для текущего кода (перебор с многих
      // адресов упирается сюда; сбрасывается только новым кодом) (F11/F14).
      if (pairFailTotal >= PAIR_FAIL_TOTAL_MAX) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":"слишком много неверных попыток — обновите код: claude-mobile --qr"}');
        return;
      }
      const g = pairGuard.get(ip) || { fails: 0, blockedUntil: 0 };
      if (Date.now() < g.blockedUntil) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":"слишком много попыток — сопряжение с этого адреса заблокировано на 15 минут"}');
        return;
      }
      if (Date.now() > pairState.expiresAt) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"код истёк — выполните claude-mobile --qr на ПК"}');
        return;
      }
      if (!pairState.code || !p.code || !T.safeEq(p.code, pairState.code)) {
        g.fails++;
        pairFailTotal++; // общий счётчик для текущего кода (F11)
        if (g.fails >= 5) {
          g.blockedUntil = Date.now() + 15 * 60 * 1000;
          g.fails = 0;
          console.log('\n  Сопряжение с ' + ip + ' заблокировано на 15 минут (перебор кода)');
        }
        pairGuard.set(ip, g);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"неверный код сопряжения"}');
        return;
      }
      pairGuard.delete(ip);
      // Код одноразовый: гасим его сразу, чтобы одним подсмотренным кодом нельзя
      // было сопрячь несколько устройств (и повторно — после отзыва) за 10 минут.
      pairState.expiresAt = 0;
      const token = crypto.randomBytes(24).toString('hex');
      // Имя устройства уже очищено V.pairBody: управляющие, bidi и zero-width
      // символы вырезаны, длина <= 64 (F13, M-6). Одно значение — для хранения и лога.
      const safeName = p.name || 'устройство';
      pairings.devices.push({
        id: deviceIdOf(token),
        token,
        name: safeName,
        addedAt: new Date().toISOString(),
      });
      savePairings();
      console.log(`\n  Сопряжено новое устройство: ${safeName}`);
      // уже сопряжённые устройства узнают о новом (D-15 п. 6; запрет — D-13, подплан 2)
      broadcast({
        type: 'notify', id: '', event: 'DevicePaired', message: `Сопряжено новое устройство: ${safeName}`,
        title: 'Claude Bridge', at: Date.now(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        token, fingerprint: FINGERPRINT, port: CONFIG.port, hostname: os.hostname(),
        nodeTicket: tunnelInfo.ticket, internet: inet.enabled,
      }));
    });
    return;
  }

  // Распознавание надиктованного аудио (телефон шлёт m4a, отвечаем текстом)
  if (req.method === 'POST' && url.pathname === '/stt') {
    if (!principal(req)) { res.writeHead(401); res.end(); return; }
    // Ограничение очереди: один воркер обрабатывает записи по одной — не даём
    // авторизованному клиенту забить память/очередь потоком загрузок.
    if (sttQueue.length >= (CONFIG.sttMaxQueue || 4)) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"очередь распознавания переполнена, повторите позже"}');
      return;
    }
    const tmp = path.join(os.tmpdir(), 'cb-stt-' + crypto.randomBytes(6).toString('hex') + '.m4a');
    // %TEMP% — в профиле пользователя, закрыт ACL от других учётных записей (D-8)
    const out = fs.createWriteStream(tmp);
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
    let size = 0;
    let overflow = false;
    // Пишем загрузку сразу на диск, а не в память: 20 МБ × N параллельных
    // запросов в RAM — вектор исчерпания памяти.
    req.on('data', (c) => {
      size += c.length;
      if (size > 20e6 && !overflow) {
        overflow = true;
        try { res.writeHead(413); res.end(); } catch {}
        req.destroy(); out.destroy(); cleanup();
      }
    });
    // обрыв загрузки клиентом: transcribe не запустится ('finish' не наступит),
    // поэтому временный файл надо удалить здесь, иначе он утечёт на диск
    req.on('error', () => { try { out.destroy(); } catch {} cleanup(); });
    out.on('error', () => { cleanup(); try { res.writeHead(500); res.end(); } catch {} });
    req.pipe(out);
    out.on('finish', async () => {
      if (overflow) return; // ответ уже отправлен, файл удалён
      try {
        const text = await Promise.race([
          transcribe(tmp),
          new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут распознавания')), 180000)),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      } catch (e) {
        // деталь — только в лог ПК; клиенту общий текст (без внутренних путей)
        console.error('[stt] ошибка распознавания:', e.message);
        try { res.writeHead(500, { 'Content-Type': 'application/json' }); } catch {}
        res.end(JSON.stringify({ error: 'не удалось распознать запись' }));
      } finally {
        cleanup();
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/hook') {
    // Авторизация — токен хука сессии (выдаётся агенту сессии через окружение).
    const sid = V.sessionId(req.headers['x-bridge-session']);
    const s = sid ? sessions.get(sid) : null;
    const tok = bearer(req);
    if (!s || !tok || !T.safeEq(tok, s.hookToken || '')) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body || 'null'); } catch { /* невалидный JSON */ }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { res.writeHead(400); res.end(); return; }
      const event = V.str(payload.hook_event_name, 64) || 'Notification';
      const message = V.str(payload.message, 2000) || V.str(payload.notification, 2000) ||
        (event === 'Stop' ? 'Claude завершил ответ' : 'Событие Claude Code');
      // статус сессии для вкладок: работает / ждёт ответа / свободна.
      // PostToolUse — ответ на запрос разрешения дан (в т.ч. на ПК): Claude снова работает.
      const status = HOOK_STATUS.get(event); // Map: ключи прототипа ('__proto__' и т.п.) не находятся (M-3)
      if (status && s.status !== status) {
        broadcast({ type: 'status', id: sid, status });
        s.status = status;
        broadcastSessions();
      }
      // push-уведомления — только для событий, требующих внимания
      if (event === 'Notification' || event === 'Stop') {
        s.lastNotify = { event, message, at: Date.now() };
        broadcast({ type: 'notify', id: sid, event, message, title: s.title, at: Date.now() });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (url.pathname === '/health') {
    if (!principal(req)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, host: os.hostname() }));
    return;
  }

  // Вход браузера владельца по одноразовому токену (L-9): cookie + redirect,
  // постоянный токен не попадает в URL/историю браузера.
  const ott = url.searchParams.get('ott');
  if (ott !== null) {
    // только браузер на самом ПК: GET, loopback, основной порт (не туннель); иначе 404,
    // токен при этом НЕ расходуется
    if (req.method !== 'GET' || !ownerSocket(req)) { res.writeHead(404); res.end(); return; }
    if (!loginTokens.consume(ott)) { res.writeHead(401); res.end(); return; }
    res.writeHead(302, {
      Location: '/',
      // токен браузера (M-1), не токен владельца: живёт до ротации/перезапуска моста
      'Set-Cookie': `bridgeToken=${BROWSER_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      ...SEC_HEADERS,
    });
    res.end();
    return;
  }
  // static: vendor libs from node_modules, everything else from web/
  if (!principal(req)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('401: нет доступа');
    return;
  }
  let file;
  if (VENDOR[url.pathname]) {
    file = VENDOR[url.pathname];
  } else {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    file = path.join(WEB_DIR, path.normalize(rel));
    // разделитель обязателен: без него сосед вида .../web-secret прошёл бы
    // проверку startsWith(WEB_DIR) (префиксный баг)
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      ...SEC_HEADERS,
    });
    res.end(data);
  });
}

// Интерфейс по умолчанию — адрес в LAN, а не 0.0.0.0 (P-7, L-11): мост не виден
// из прочих сетей ПК (VPN, виртуальные адаптеры). "auto" определяется при старте.
const LISTEN_HOST = (!CONFIG.host || CONFIG.host === 'auto') ? lanAddress() : CONFIG.host;
// Владелец подключается к 127.0.0.1: если основной сервер слушает только LAN-адрес,
// loopback обслуживает отдельный сервер на ТОМ ЖЕ номере порта (isOwner проверяет
// localPort === CONFIG.port, поэтому он проходит как основной порт).
const NEED_OWNER_LISTENER = LISTEN_HOST !== '0.0.0.0' && LISTEN_HOST !== '127.0.0.1';

// Основной сервер (LAN), loopback-сервер владельца и отдельный локальный порт
// для интернет-туннеля: isOwner() различает их по localPort.
const server = https.createServer(TLS, httpHandler);
const ownerServer = https.createServer(TLS, httpHandler);
const tunnelServer = https.createServer(TLS, httpHandler);
// M-10: медленные/зависшие клиенты не держат ресурсы бесконечно.
// requestTimeout 120 с: голосовые записи до 20 МБ по медленной мобильной сети.
for (const srv of [server, ownerServer, tunnelServer]) {
  srv.headersTimeout = 10000;
  srv.requestTimeout = 120000;
  srv.maxConnections = 256;
}
for (const [srv, host] of [[server, LISTEN_HOST], [ownerServer, '127.0.0.1']]) {
  srv.on('error', (e) => {
    console.error(`  Не удалось слушать порт ${host}:${CONFIG.port} (${e.code || e.message}) — ` +
      'порт занят другим процессом (уже запущен мост?) или недоступен');
    process.exit(1);
  });
}
tunnelServer.on('error', (e) => {
  console.error(`  Порт туннеля 127.0.0.1:${TUNNEL_PORT} недоступен (${e.code || e.message}) — ` +
    'доступ через интернет отключён до перезапуска моста');
  tunnelListening = false;
  inet.enabled = false; // только в памяти: при следующем старте попробуем снова
  stopTunnel();
});

// ---------------------------------------------------------------- websocket

// Авторизация и лимиты — ДО апгрейда (M-3, H-1): неавторизованный клиент не
// получает WebSocket вовсе, а не открытое соединение с последующим close.
const MAX_WS_CLIENTS = 64;
let pendingUpgrades = 0;
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
function handleUpgrade(req, sock, head) {
  sock.on('error', () => { /* обрыв клиента не должен ронять мост */ });
  const reject = (code) => {
    // как abortHandshake в ws: сначала дописать ответ, потом закрыть сокет
    try {
      sock.once('finish', () => sock.destroy());
      sock.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || 'Error'}\r\n` +
        'Connection: close\r\nContent-Length: 0\r\n\r\n');
    } catch { sock.destroy(); }
  };
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return reject(400); }
  if (url.pathname !== '/ws') return reject(404);
  if (!originAllowed(req.headers.origin, CONFIG.port)) return reject(403);
  const who = principal(req);
  if (!who) return reject(401);
  if (allClients.size + pendingUpgrades >= MAX_WS_CLIENTS) return reject(503);
  // незавершённые апгрейды тоже занимают место (M-9)
  pendingUpgrades++;
  let counted = true;
  const release = () => { if (counted) { counted = false; pendingUpgrades--; } };
  sock.once('close', release);
  wss.handleUpgrade(req, sock, head, (ws) => {
    release();
    sock.removeListener('close', release);
    wss.emit('connection', ws, req, who);
  });
}
server.on('upgrade', handleUpgrade);
ownerServer.on('upgrade', handleUpgrade);
tunnelServer.on('upgrade', handleUpgrade);
const allClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of allClients) if (ws.readyState === 1) ws.send(msg);
}
function broadcastSessions() {
  broadcast({ type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [] });
}
function devicesMsg(ws) {
  return {
    type: 'devices',
    self: ws.deviceId,
    devices: pairings.devices.map((d) => ({ id: d.id, name: d.name, addedAt: d.addedAt })),
  };
}

wss.on('connection', (ws, req, who) => {
  ws.on('error', () => { /* необработанная ошибка ws (напр. maxPayload) не должна ронять мост */ });
  // 'local' — имя роли владельца (в этом подплане остальные проверки не меняются)
  ws.deviceId = who === 'owner' ? 'local' : who.id;
  allClients.add(ws);
  ws.attached = null;
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [] }));

  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    const m = V.wsMessage(parsed); // P-10: только объект со строковым type
    if (!m) return;
    const sid = V.sessionId(m.id);
    const s = sid ? sessions.get(sid) : null;

    try {
      switch (m.type) {
        case 'create': {
          if (sessions.size >= MAX_SESSIONS) {
            ws.send(JSON.stringify({ type: 'error', message: 'Достигнут предел числа сессий' }));
            break;
          }
          if (!rateAllowCreate(ws.deviceId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Слишком часто — подождите немного' }));
            break;
          }
          let created;
          try {
            created = createSession({
              cwd: V.str(m.cwd, 1024),
              command: V.str(m.command, 1024),
              args: Array.isArray(m.args) && m.args.length <= 64 &&
                m.args.every((a) => typeof a === 'string' && a.length <= 4096) ? m.args : [],
              title: V.cleanTitle(m.title),
              local: ws.deviceId === 'local',
            });
          } catch (e) {
            console.error('  Не удалось создать сессию:', e && e.message);
            ws.send(JSON.stringify({ type: 'error', message: 'не удалось создать сессию' }));
            break;
          }
          ws.send(JSON.stringify({ type: 'created', id: created.id }));
          break;
        }
        case 'attach': {
          if (!s) return;
          if (ws.attached) { const old = sessions.get(ws.attached); if (old) old.clients.delete(ws); }
          ws.attached = s.id;
          s.clients.add(ws);
          {
            const cols = V.int(m.cols, 1, 1000);
            const rows = V.int(m.rows, 1, 1000);
            if (cols && rows) ws.desired = { cols, rows };
          }
          // зритель размер не меняет — только единственный клиент
          if (ws.desired && s.clients.size === 1) resizePty(s, ws.desired.cols, ws.desired.rows);
          ws.send(JSON.stringify({
            type: 'scrollback', id: s.id, data: s.buffer.join(''),
            alive: s.alive, cols: s.cols, rows: s.rows,
          }));
          break;
        }
        case 'input':
          if (s && s.alive) {
            if (s.lastInput !== ws) {
              s.lastInput = ws; // клиент начал печатать — PTY подстраивается под него
              if (ws.desired) resizePty(s, ws.desired.cols, ws.desired.rows);
            }
            const d = V.str(m.data, 65536);
            if (d !== null) keeperSend(s, { t: 'in', d });
          }
          break;
        case 'scroll':
          // прокрутка — не набор текста: не трогаем «владельца размера» PTY
          if (s && s.alive) {
            const d = V.str(m.data, 65536);
            if (d !== null) keeperSend(s, { t: 'in', d });
          }
          break;
        case 'resize': {
          if (!s) break;
          const cols = V.int(m.cols, 1, 1000);
          const rows = V.int(m.rows, 1, 1000);
          if (cols && rows) ws.desired = { cols, rows };
          if (ws.desired && (s.clients.size === 1 || s.lastInput === ws)) {
            resizePty(s, ws.desired.cols, ws.desired.rows);
          }
          break;
        }
        case 'kill':
          if (s && s.alive) keeperSend(s, { t: 'kill' });
          break;
        case 'remove':
          if (s && !s.alive) { sessions.delete(s.id); broadcastSessions(); }
          break;
        case 'list':
          ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [] }));
          break;
        case 'devices':
          // список устройств — только локальным клиентам (десктоп-браузер,
          // claude-mobile); телефон управляет ПК через нативное меню, не этим
          if (ws.deviceId === 'local') ws.send(JSON.stringify(devicesMsg(ws)));
          break;
        case 'internet':
          // статус интернет-доступа: телефон запоминает ticket на будущее
          ws.send(JSON.stringify(internetMsg()));
          break;
        case 'registerNode': {
          // телефон сообщает свой постоянный iroh-NodeId (по LAN, через
          // защищённый WS) — добавляем в allowlist туннеля этого устройства
          const nid = V.nodeId(m.nodeId) || '';
          if (nid && ws.deviceId && ws.deviceId !== 'local') {
            const dev = pairings.devices.find((d) => d.id === ws.deviceId);
            if (dev && dev.nodeId !== nid) {
              dev.nodeId = nid;
              savePairings();
              writeAllowFile();
              console.log(`  Зарегистрирован p2p-узел устройства «${dev.name}»`);
            }
          }
          break;
        }
        case 'setInternet':
          // включение/выключение — только с самого ПК (claude-mobile --device) и только
          // после подтверждения человеком в консоли (P-9: confirmed). Флаг шлёт сам
          // клиент, поэтому от агента с токеном владельца это не защищает — по D-13
          // подтверждение переедет на сопряжённый телефон (подплан 2).
          if (ws.deviceId === 'local' && m.confirmed === true) {
            setInternet(m.enabled === true);
            broadcastInternet();
          }
          break;
        case 'pairinfo':
          // данные сопряжения — только локальным клиентам (claude-mobile --qr) после
          // подтверждения в консоли (P-9: confirmed; ограничение и D-13 — см. setInternet);
          // каждый запрос выдаёт свежий код на 10 минут
          if (ws.deviceId === 'local' && m.confirmed === true) {
            const p = regenPairCode();
            ws.send(JSON.stringify({
              type: 'pairinfo',
              host: LISTEN_HOST === '0.0.0.0' ? lanAddress() : LISTEN_HOST, // адрес, который реально слушаем
              port: CONFIG.port,
              code: p.code,
              ttlMin: Math.round(PAIR_TTL_MS / 60000),
              fp: FINGERPRINT,
              internet: internetMsg(),
            }));
          }
          break;
        case 'revokeDevice':
          // отзыв устройств — только с самого ПК (claude-mobile --device / десктоп),
          // иначе сопряжённый телефон мог бы отозвать все остальные устройства.
          // Список устройств тоже отдаём ТОЛЬКО локальному клиенту: удалённое
          // устройство иначе прочитало бы id/имена/даты всех остальных (F12).
          if (ws.deviceId === 'local') {
            const devId = V.str(m.id, 64);
            if (devId) revokeDeviceById(devId);
            ws.send(JSON.stringify(devicesMsg(ws)));
          }
          break;
        case 'issueLoginToken':
          // одноразовый токен входа браузера владельца (L-9): /?ott=<token> -> cookie
          if (ws.deviceId === 'local') {
            ws.send(JSON.stringify({ type: 'loginToken', token: loginTokens.issue(), port: CONFIG.port }));
          }
          break;
        case 'rotateOwnerToken':
          // смена токена владельца: все соединения владельца разрываются
          if (ws.deviceId === 'local') {
            OWNER_TOKEN = T.rotateOwnerToken(DATA.ownerToken);
            BROWSER_TOKEN = T.newToken(); // cookie браузеров недействительны
            loginTokens.clear(); // выданные, но не использованные ott — тоже (M-2)
            for (const c of allClients) {
              if (c.deviceId === 'local') { try { c.close(4401, 'owner token rotated'); } catch { /* закрыт */ } }
            }
          }
          break;
      }
    } catch (e) {
      // ошибка обработки одного сообщения не должна ронять мост
      console.error('[ws] ошибка обработки сообщения:', e && e.message);
    }
  });

  ws.on('close', () => {
    allClients.delete(ws);
    if (ws.attached) { const s = sessions.get(ws.attached); if (s) s.clients.delete(ws); }
  });
});

// ---------------------------------------------------------------- start

/** Адрес основного LAN-интерфейса (P-7): частный адрес физического адаптера, см. lib/lan.js. */
function lanAddress() {
  return pickLanAddress();
}

// UDP-обнаружение: телефон шлёт broadcast "CLAUDE_BRIDGE?" на 8791,
// мост отвечает unicast'ом с адресом. Надёжнее mDNS в замусоренных сетях.
const dgram = require('dgram');

// Отвечаем только запросам из локальных сетей (RFC1918 / link-local / loopback):
// маяк не должен раскрывать hostname+отпечаток и служить рефлектором наружу.
function isPrivateAddr(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const p = v4.split('.').map(Number);
  if (p.length === 4 && p.every((n) => n >= 0 && n <= 255)) {
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local
    return false;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd');
}

// Без reuseAddr (P-7): второй процесс не может тихо занять тот же UDP-порт и
// перехватывать запросы обнаружения.
const beacon = dgram.createSocket({ type: 'udp4' });
beacon.on('message', (msg, rinfo) => {
  if (msg.toString().trim() === 'CLAUDE_BRIDGE?' && isPrivateAddr(rinfo.address)) {
    // fp — публичный отпечаток сертификата: телефон по нему понимает,
    // КАКОЙ из его сопряжённых компьютеров ответил. Имя ПК не раскрываем (P-7):
    // в офисной сети его видел бы любой, кто шлёт broadcast.
    const reply = JSON.stringify({ claudeBridge: true, port: CONFIG.port, fp: FINGERPRINT });
    beacon.send(reply, rinfo.port, rinfo.address);
  }
});
beacon.on('error', (e) => console.error('UDP beacon error (не критично):', e.message));

// Всё, что затрагивает внешний мир (маяк, туннель с taskkill, mDNS, хранители сессий), —
// только когда ВСЕ порты моста заняты нами: повторный запуск при работающем мосте
// (start-bridge.js из Планировщика) выходит по EADDRINUSE, не тронув туннель и
// хранителей работающего экземпляра.
let pendingListens = NEED_OWNER_LISTENER ? 2 : 1;
const listened = () => { if (--pendingListens === 0) onListening(); };
if (NEED_OWNER_LISTENER) ownerServer.listen(CONFIG.port, '127.0.0.1', listened);
server.listen(CONFIG.port, LISTEN_HOST, listened);

function onListening() {
  beacon.bind(CONFIG.port + 1);
  // порт для трафика из интернет-туннеля — только loopback
  if (inet.enabled) { listenTunnelServer(); startTunnel(); }

  if (!TEST_MODE) {
    try {
      const bonjour = new Bonjour();
      bonjour.publish({
        name: CONFIG.mdnsName || 'claude-bridge',
        type: 'claude-bridge',
        port: CONFIG.port,
        txt: { path: '/', fp: FINGERPRINT },
      });
    } catch (e) {
      console.error('mDNS publish failed (не критично):', e.message);
    }
  }

  restoreSessions();

  console.log('');
  console.log('  Claude Bridge запущен (HTTPS/WSS, ' + LISTEN_HOST + ':' + CONFIG.port +
    (NEED_OWNER_LISTENER ? ' и 127.0.0.1:' + CONFIG.port : '') + ')');
  console.log(`  Доверенных устройств: ${pairings.devices.length}` +
    (pairings.devices.length ? ' — подключатся сами' : ''));
  console.log('  Доступ через интернет: ' +
    (inet.enabled ? 'включён (p2p iroh)' : 'выключен (включить: claude-mobile --device)'));
  // Код сопряжения при старте не выпускается (P-9) — QR/код только по запросу владельца.
  console.log('  Добавить устройство: claude-mobile --qr');
  console.log(`  Отпечаток сертификата: ${FINGERPRINT.slice(0, 16)}…`);
}

// Перезапуск моста НЕ убивает сессии: они живут в отдельных хранителях.
// А вот интернет-туннель — часть моста: его при выходе гасим, иначе при
// KillMode=process он переживёт рестарт и задвоит iroh-endpoint.
process.on('exit', () => { if (tunnel) { try { tunnel.kill(); } catch { } } });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
