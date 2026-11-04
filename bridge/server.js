#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const { ensureDataDirs } = require('./lib/datadir');
const P = require('./lib/paths');
const T = require('./lib/tokens');
const V = require('./lib/validate');
const { originAllowed } = require('./lib/origin');
const { loadOrCreateCert } = require('./lib/cert');
const { installFileLog } = require('./lib/log');
const K = require('./lib/keeper-channel');
const { pickLanAddress } = require('./lib/lan');
const MDNS = require('./lib/mdns');
const { loadAgents, normalizeOptions } = require('./agents');
const generic = require('./agents/generic');
const { findOnPath } = require('./lib/which');
const SE = require('./lib/session-events');
const { Confirmations, confirmView } = require('./lib/confirmations');

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
// M-7: старые ключи (D-9, D-15 п. 4) больше не читаются — сказать, а не молча игнорировать
if (CONFIG.claudeCommand !== undefined || CONFIG.claudeArgs !== undefined) {
  console.error('  Конфиг: claudeCommand/claudeArgs больше не используются — задайте агентов в agents ' +
    '(см. config.example.json); ключи проигнорированы');
}
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

// D-3/D-5: адаптеры агентов из конфига (без ключа agents — claude + opencode, если установлены)
const AGENTS = loadAgents(CONFIG);
console.log('  Агенты: ' + (AGENTS.list().map((a) => a.id).join(', ') || 'нет ни одного доступного'));

/** Ошибка создания сессии, текст которой можно показать клиенту (без внутренних путей). */
function userError(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

/** Адаптер сессии по meta: своя команда владельца или пропавший из конфига агент — generic «только зеркало». */
function adapterFor(meta) {
  const configured = meta.custom === true ? null : AGENTS.get(meta.agent);
  if (configured) return configured;
  const cmd = typeof meta.cmd === 'string' && meta.cmd ? meta.cmd : 'custom';
  return generic.create(typeof meta.agent === 'string' && meta.agent ? meta.agent : 'custom',
    { name: path.basename(cmd), command: cmd });
}

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

// Доверенные устройства. Нет файла — первый запуск. Файл есть, но не читается или имеет неверную
// форму — отказ запуска (fail closed): пустой список с потерянным phoneRequired (D-22.2) снова
// открыл бы консольный путь подтверждения.
let pairings = { devices: [] };
{
  let raw = null;
  try { raw = fs.readFileSync(DATA.pairings, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') raw = e;
  }
  if (raw !== null) {
    let parsed = null;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { /* ниже — отказ */ } }
    const okShape = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.devices) &&
      (parsed.phoneRequired === undefined || typeof parsed.phoneRequired === 'boolean');
    if (!okShape) {
      console.error('  pairings.json повреждён — исправьте или удалите файл при остановленном мосте (' + DATA.pairings + ')' +
        (raw instanceof Error ? ': ' + raw.message : ''));
      process.exit(1);
    }
    pairings = parsed;
  }
}
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

// D-15 п. 7: токен устройства хранится только как SHA-256-хэш (tokenHash) — агент той же учётки,
// прочитав pairings.json, не получит токен телефона (и не подтвердит запрос D-13 «сам себе»).
// Публичный id устройства — первые 12 hex хэша: по нему можно ссылаться, не раскрывая токен.
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
function tokenHashOf(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
{
  // D-9: записи с открытым token (до хэширования) не поддерживаются — отбрасываем и сразу
  // переписываем файл (m-4: открытые токены не остаются на диске); id всегда выводится из хэша
  const ok = pairings.devices.filter((d) => d && typeof d === 'object' && typeof d.tokenHash === 'string' &&
    TOKEN_HASH_RE.test(d.tokenHash));
  const skipped = pairings.devices.length - ok.length;
  for (const d of ok) { delete d.token; d.id = d.tokenHash.slice(0, 12); }
  // D-22.2: после первого успешного сопряжения консольный путь подтверждения закрыт навсегда
  // (флаг phoneRequired); уже сопряжённые устройства в файле — тоже признак сопряжения.
  // Устаревшие записи флаг не ставят: их токены не поддерживаются (D-9).
  pairings = { phoneRequired: pairings.phoneRequired === true || ok.length > 0, devices: ok };
  if (skipped) {
    // console.error после installFileLog — попадает и в файловый лог моста
    console.error(`  pairings.json: отброшено устаревших записей устройств (открытый токен или нет tokenHash): ${skipped} — ` +
      'сопрягите эти устройства заново (claude-mobile --qr)');
    try { savePairings(); } catch (e) { console.error('  pairings.json: не удалось переписать: ' + e.message); }
  }
}

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
/** Найти устройство по токену: сравнение SHA-256-хэшей за постоянное время, без раннего выхода. */
function deviceByToken(t) {
  if (!t) return null;
  const h = tokenHashOf(t);
  let found = null;
  for (const d of pairings.devices) if (T.safeEq(d.tokenHash, h) && !found) found = d;
  return found;
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
  // D-22.2: оставшиеся устройства узнают об отзыве (агент с токеном владельца мог отозвать телефон)
  broadcast({ type: 'notify', id: '', event: 'info', message: `Устройство отозвано: ${name}`,
    title: 'Claude Bridge', at: Date.now() });
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
    status: 'idle', // idle | working | waiting — по событиям адаптера
    cols: meta.cols,
    rows: meta.rows,
    keeperPid: Number.isInteger(meta.keeperPid) && meta.keeperPid > 0 ? meta.keeperPid : null,
    lastInput: null, // клиент, печатавший последним — его размер и держим
    agent: typeof meta.agent === 'string' && meta.agent ? meta.agent : 'custom',
    agentState: meta.agentState && typeof meta.agentState === 'object' && !Array.isArray(meta.agentState)
      ? meta.agentState : {},
    adapter: adapterFor(meta),
    runtime: {},          // состояние адаптера в памяти (не сохраняется)
    pending: new Map(),   // requestId -> ожидающий запрос разрешения (D-4)
    unsubscribe: null,    // отписка от событий SSE (opencode)
  };
}

/** Сообщение keeper'у; false — канала нет (keeper переподключается), сообщение не ушло. */
function keeperSend(session, obj) {
  const ch = session.channel;
  if (!session.alive || !ch || !ch.socket || ch.socket.destroyed || !ch.socket.writable) return false;
  ch.send(obj);
  return true;
}

/** Ввод в PTY для адаптера (reply): false — канала к keeper'у нет, клавиша не дойдёт (D-19 п. 6). */
function keeperWrite(session, data) {
  return keeperSend(session, { t: 'in', d: data });
}

/** Вызов адаптера: исключение адаптера не роняет мост и не ломает сессию (контракт P-2). */
function adapterCall(session, what, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    console.error(`  Сессия ${session.id}: адаптер ${session.agent}.${what}: ${e && e.message}`);
    return fallback;
  }
}

/** События адаптера (P-2) -> состояние сессии и рассылка (D-4). */
function emitEvents(session, events) {
  if (sessions.get(session.id) !== session || !Array.isArray(events) || !events.length) return;
  const r = SE.applyEvents(session, events);
  for (const msg of r.messages) broadcast(msg);
  if (r.sessionsChanged) broadcastSessions();
}

/** M-6: состояние адаптера (agentState) изменилось — переписать его в meta, чтобы оно пережило
 *  рестарт моста. Только существующий meta (keeper удаляет его при выходе агента); tmp + rename. */
function persistAgentState(session) {
  const file = path.join(SESS_DIR, session.id + '.json');
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.agentState = session.agentState;
    fs.writeFileSync(file + '.tmp', JSON.stringify(meta));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    try { fs.unlinkSync(file + '.tmp'); } catch { /* не создан */ }
    if (e.code !== 'ENOENT') console.error(`  Сессия ${session.id}: не удалось сохранить состояние агента: ${e.message}`);
  }
}

function startAgentEvents(session) {
  if (session.adapter.events !== 'sse' || session.unsubscribe) return;
  const unsubscribe = adapterCall(session, 'subscribe',
    () => session.adapter.subscribe(session, (events) => emitEvents(session, events)), null);
  session.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
}

function stopAgentEvents(session) {
  if (!session.unsubscribe) return;
  try { session.unsubscribe(); } catch { /* уже отписаны */ }
  session.unsubscribe = null;
}

function dropSession(session, exitCode) {
  if (!sessions.has(session.id)) return;
  session.alive = false;
  stopAgentEvents(session);
  for (const msg of SE.closeAllRequests(session)) broadcast(msg);
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

async function createSession({ cwd, agentId, options, rawArgs, command, title, local, force }) {
  // Произвольную КОМАНДУ и сырые аргументы задаёт только владелец (P-3); устройство —
  // только id агента и id его опций (D-5): командную строку мост строит сам.
  // КАТАЛОГ устройства ограничен разрешёнными проектами (D-7) — после P-3 это граница
  // (D-16 п. 2); путь канонический (иначе --resume не найдёт беседы при другом регистре/8.3/junction).
  let adapter;
  let custom = false;
  if (local && command) {
    if (!findOnPath(command)) throw userError('команда не найдена: ' + command);
    adapter = generic.create('custom', { name: path.basename(command), command, args: [] });
    custom = true;
  } else if (agentId === undefined) {
    // агент не указан — агент по умолчанию (D-5)
    if (!AGENTS.defaultId) throw userError('нет доступных агентов');
    adapter = AGENTS.get(AGENTS.defaultId);
  } else {
    // M-2: указан, но не строка / слишком длинный / неизвестный — отказ, а не тихое умолчание
    // (agentId === null здесь — недопустимое значение из WS, а не «не указан», см. обработчик create)
    adapter = typeof agentId === 'string' ? AGENTS.get(agentId) : null;
    if (!adapter) throw userError('неизвестный агент');
  }
  const fallback = P.canonicalDir(CONFIG.defaultCwd) || CONFIG.defaultCwd;
  const dir = local
    ? P.resolveLocalCwd(cwd, fallback)
    : P.resolveRemoteCwd(cwd, CONFIG.projects, fallback);
  const opts = normalizeOptions(adapter, options);
  const extra = local ? (rawArgs || []) : [];
  // D-7: resume рядом с живой сессией того же агента в этом каталоге — решает пользователь
  // (resume открытой беседы создаёт её копию); пути сравнивает мост, клиент получает готовый
  // признак createConflict и повторяет create с force:true (D-15 п. 2)
  if (force !== true && adapter.isResumeLike({ options: opts, rawArgs: extra })) {
    const live = [...sessions.values()].filter((x) => x.alive && x.agent === adapter.id && P.samePath(x.cwd, dir));
    if (live.length) return { conflict: { cwd: dir, live: live.map((x) => ({ id: x.id, title: x.title })) } };
  }
  const finalTitle = title || `${path.basename(dir) || dir} · ${adapter.name}`;
  // opencode создаёт сессию в своём сервисе (D-12) — асинхронно
  const spec = await adapter.spawnSpec({ cwd: dir, title: finalTitle, options: opts, rawArgs: extra });
  // M-1: если создание ниже не удастся (предел сессий, запись meta, запуск keeper'а), сессия,
  // уже созданная адаптером во внешнем сервисе (opencode), остаётся там без TUI — принято
  // (D-15 п. 11: сессии opencode мост не удаляет, это история пользователя).
  if (sessions.size >= MAX_SESSIONS) throw userError('достигнут предел числа сессий');
  const id = 's' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');

  // Секрет канала keeper<->мост и токен хука сессии (P-1): у каждой сессии свои.
  const secret = crypto.randomBytes(32).toString('hex');
  const hookToken = T.newToken();
  const meta = {
    id,
    cmd: spec.command,
    args: spec.args,
    cwd: dir,
    title: finalTitle,
    agent: adapter.id,
    ...(custom ? { custom: true } : {}),
    agentState: spec.state || {},
    createdAt: Date.now(),
    cols: 100,
    rows: 30,
    scrollbackBytes: CONFIG.scrollbackBytes || 262144,
    pipe: K.pipeName(),
    secret,
    hookToken,
  };
  // env НЕ пишем в meta-файл: process.env и env адаптера (OPENCODE_PASSWORD, D-12) содержат
  // секреты, а файл остаётся на диске. Окружение передаётся хранителю через сам процесс;
  // CLAUDE_BRIDGE_KEEPER_SECRET keeper удаляет до запуска агента.
  const extraEnv = (CONFIG.env && typeof CONFIG.env === 'object' && !Array.isArray(CONFIG.env)) ? CONFIG.env : {};
  const agentEnv = (spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)) ? spec.env : {};
  const baseEnv = { ...process.env };
  // настройки самого моста агенту не передаются (M-11): иначе мост, запущенный
  // из сессии, унаследовал бы чужой каталог данных/порт/тестовый режим
  for (const k of BRIDGE_OWN_ENV) delete baseEnv[k];
  const childEnv = {
    ...baseEnv, ...extraEnv, ...agentEnv,
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
  startAgentEvents(session);
  broadcastSessions();
  return { session };
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
      // D-23.4: адаптер знает, что диалог мог открыться до рестарта моста и мосту не известен
      session.restored = true;
      sessions.set(meta.id, session);
      connectKeeper(session, 3);
      startAgentEvents(session);
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
    agent: s.agent,
    agentName: s.adapter.name,
    scroll: s.adapter.scroll, // D-10
  }));
}

function sessionsMsg() {
  return {
    type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [],
    agents: AGENTS.list(), defaultAgent: AGENTS.defaultId,
  };
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

let tunnelStarting = false; // идёт гашение бесхозных туннелей перед запуском

function startTunnel() {
  if (tunnel || tunnelStarting || !inet.enabled) return;
  // Тесты: сайдкар не запускаем — он ушёл бы в интернет (iroh relay), а taskkill
  // ниже погасил бы туннель настоящего моста пользователя.
  if (TEST_MODE) return;
  if (!fs.existsSync(TUNNEL_BIN)) {
    console.error('  Интернет-доступ включён, но bridge/bin/claude-tunnel.exe не собран');
    return;
  }
  // Бесхозные туннели прошлых запусков (у них тот же ключ/NodeId) — убрать; без шелла
  // (путь установки не интерпретируется как команда) и асинхронно: цикл событий моста
  // не блокируется, новый туннель стартует после завершения taskkill.
  tunnelStarting = true;
  let done = false;
  let killer = null;
  const proceed = () => {
    if (done) return;
    done = true;
    clearTimeout(guard);
    tunnelStarting = false;
    spawnTunnel();
  };
  const guard = setTimeout(() => { try { if (killer) killer.kill(); } catch { /* */ } proceed(); }, 10000);
  try {
    killer = spawn('taskkill', ['/IM', 'claude-tunnel.exe', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', proceed);
    killer.on('exit', proceed);
  } catch { proceed(); }
}

function spawnTunnel() {
  if (tunnel || !inet.enabled) return; // пока гасили старые, доступ могли выключить
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
      // токен уходит телефону один раз (ответ ниже); на диске — только хэш (D-15 п. 7)
      const token = crypto.randomBytes(24).toString('hex');
      const tokenHash = tokenHashOf(token);
      // Имя устройства уже очищено V.pairBody: управляющие, bidi и zero-width
      // символы вырезаны, длина <= 64 (F13, M-6). Одно значение — для хранения и лога.
      const safeName = p.name || 'устройство';
      pairings.devices.push({
        id: tokenHash.slice(0, 12),
        tokenHash,
        name: safeName,
        addedAt: new Date().toISOString(),
      });
      pairings.phoneRequired = true; // D-22.2: дальше — только подтверждение на телефоне
      savePairings();
      console.log(`\n  Сопряжено новое устройство: ${safeName}`);
      // уже сопряжённые устройства узнают о новом (D-15 п. 6); формат notify — D-15 п. 1
      broadcast({
        type: 'notify', id: '', event: 'info', message: `Сопряжено новое устройство: ${safeName}`,
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
      // статус, запросы и уведомления — по правилам адаптера агента этой сессии. Событие
      // применяется ДО ответа хуку (поправка 8): Claude Code ждёт окончания хука, поэтому
      // PermissionRequest, пришедший следом за PreToolUse, не обгонит его.
      if (s.adapter.events === 'hook' && sessions.get(s.id) === s) {
        const stateBefore = JSON.stringify(s.agentState);
        emitEvents(s, adapterCall(s, 'onHook', () => s.adapter.onHook(s, payload), []));
        if (JSON.stringify(s.agentState) !== stateBefore) persistAgentState(s);
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
// из прочих сетей ПК (VPN, виртуальные адаптеры).
//  - host "auto" (по умолчанию): loopback владельца слушается всегда; LAN-адрес
//    выбирается lib/lan.js и перепроверяется каждые 15 с (ревью I-3: при автозапуске
//    сеть может ещё не подняться, а адрес — смениться по DHCP / при смене Wi-Fi);
//  - явный host: слушаем его, плюс loopback владельца, если это конкретный адрес.
// Владелец подключается к 127.0.0.1; isOwner проверяет localPort === CONFIG.port, поэтому
// loopback-сервер на том же номере порта проходит как основной порт.
const AUTO_HOST = !CONFIG.host || CONFIG.host === 'auto';
const LAN_REPICK_MS = (TEST_MODE && parseInt(process.env.CLAUDE_BRIDGE_TEST_REPICK_MS, 10) > 0)
  ? parseInt(process.env.CLAUDE_BRIDGE_TEST_REPICK_MS, 10) : 15000;
const FIXED_HOSTS = AUTO_HOST ? ['127.0.0.1']
  : (CONFIG.host === '0.0.0.0' || CONFIG.host === '127.0.0.1') ? [CONFIG.host] : [CONFIG.host, '127.0.0.1'];

function makeHttpsServer() {
  const srv = https.createServer(TLS, httpHandler);
  // M-10: медленные/зависшие клиенты не держат ресурсы бесконечно.
  // requestTimeout 120 с: голосовые записи до 20 МБ по медленной мобильной сети.
  srv.headersTimeout = 10000;
  srv.requestTimeout = 120000;
  srv.maxConnections = 256;
  srv.on('upgrade', handleUpgrade);
  return srv;
}

// Постоянные слушатели: ошибка — выход (порт занят — уже запущен мост?).
const fixedServers = FIXED_HOSTS.map((host) => {
  const srv = makeHttpsServer();
  srv.on('error', (e) => {
    console.error(`  Не удалось слушать порт ${host}:${CONFIG.port} (${e.code || e.message}) — ` +
      'порт занят другим процессом (уже запущен мост?) или недоступен');
    process.exit(1);
  });
  return { srv, host };
});
// Отдельный локальный порт для интернет-туннеля: isOwner() отличает его по localPort.
const tunnelServer = makeHttpsServer();
tunnelServer.on('error', (e) => {
  console.error(`  Порт туннеля 127.0.0.1:${TUNNEL_PORT} недоступен (${e.code || e.message}) — ` +
    'доступ через интернет отключён до перезапуска моста');
  tunnelListening = false;
  inet.enabled = false; // только в памяти: при следующем старте попробуем снова
  stopTunnel();
});

// ---- LAN-адрес в режиме auto (ревью I-3)
let lanServer = null; // сервер на LAN-адресе
let lanHost = null; // адрес, который он слушает (null — LAN-адреса нет)
let lanBusy = false; // идёт listen
let lanLastError = '';

/** Адрес для QR/mDNS: тот, что реально слушаем в LAN; null — только этот ПК. */
function advertisedHost() {
  if (AUTO_HOST) return lanHost;
  if (CONFIG.host === '127.0.0.1') return null;
  if (CONFIG.host === '0.0.0.0') { const a = lanAddress(); return a === '127.0.0.1' ? null : a; }
  return CONFIG.host;
}

function warnNoLan() {
  console.error('  ВНИМАНИЕ: нет LAN-адреса (сеть ещё не поднялась?) — мост доступен только с этого ПК; ' +
    `сопряжение недоступно. Повторная проверка каждые ${Math.round(LAN_REPICK_MS / 1000)} с.`);
}

function lanListen(addr) {
  const srv = makeHttpsServer();
  lanBusy = true;
  const onError = (e) => {
    lanBusy = false;
    try { srv.close(); } catch { /* не слушал */ }
    const key = addr + ':' + (e.code || e.message);
    if (key !== lanLastError) { // не засорять лог одной и той же ошибкой каждые 15 с
      lanLastError = key;
      console.error(`  Не удалось слушать LAN-адрес ${addr}:${CONFIG.port} (${e.code || e.message}) — ` +
        `повтор через ${Math.round(LAN_REPICK_MS / 1000)} с`);
    }
  };
  srv.once('error', onError);
  srv.once('listening', () => {
    srv.removeListener('error', onError);
    srv.on('error', (e) => console.error('  LAN-сервер:', e.message));
    lanBusy = false;
    lanLastError = '';
    lanServer = srv;
    lanHost = addr;
    console.log(`  Слушаю LAN: ${addr}:${CONFIG.port}`);
    announceMdns();
  });
  srv.listen(CONFIG.port, addr);
}

function repickLan() {
  if (lanBusy) return;
  const want = lanAddress();
  const wantHost = want === '127.0.0.1' ? null : want;
  if (wantHost === lanHost) return;
  if (lanServer) {
    // адрес пропал или сменился: соединения по старому адресу всё равно мертвы
    try { lanServer.close(); } catch { /* уже закрыт */ }
    console.log(`  LAN-адрес изменился: ${lanHost} -> ${wantHost || 'нет'}`);
    lanServer = null;
    lanHost = null;
    announceMdns();
    if (!wantHost) warnNoLan();
  }
  if (wantHost) lanListen(wantHost);
}

// ---- mDNS (P-7, ревью I-1): без имени ПК, A-запись — только адрес, который слушаем
let bonjour = null;
function announceMdns() {
  if (TEST_MODE) return;
  if (bonjour) {
    const old = bonjour;
    bonjour = null;
    try { old.unpublishAll(() => { try { old.destroy(); } catch { /* */ } }); } catch { /* */ }
  }
  const host = AUTO_HOST ? lanHost : CONFIG.host;
  if (!MDNS.shouldPublish(host)) return;
  try {
    bonjour = MDNS.publish({
      listenHost: host, name: CONFIG.mdnsName, port: CONFIG.port, fingerprint: FINGERPRINT,
      onError: (e) => console.error('mDNS (не критично):', e && e.message),
    });
  } catch (e) {
    console.error('mDNS publish failed (не критично):', e.message);
  }
}

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
  // Origin WebView допустим только для устройства (m-1): предварительно пропускаем его,
  // чтобы неизвестный/отозванный токен получил 401 (телефон по нему распознаёт отзыв, I-1)
  if (!originAllowed(req.headers.origin, CONFIG.port, { device: true })) return reject(403);
  const who = principal(req);
  if (!who) return reject(401);
  if (!originAllowed(req.headers.origin, CONFIG.port, { device: who !== 'owner' })) return reject(403);
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
const allClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of allClients) if (ws.readyState === 1) ws.send(msg);
}
function wsSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcastSessions() {
  broadcast(sessionsMsg());
}
function devicesMsg(ws) {
  return {
    type: 'devices',
    self: ws.deviceId,
    devices: pairings.devices.map((d) => ({ id: d.id, name: d.name, addedAt: d.addedAt })),
  };
}

// ---------------------------------------------------------------- подтверждения D-13

// тесты (только CLAUDE_BRIDGE_TEST) укорачивают паузу после отказа (D-22.3)
const TEST_COOLDOWN_MS = TEST_MODE ? parseInt(process.env.CLAUDE_BRIDGE_TEST_COOLDOWN_MS, 10) : NaN;
const confirmations = new Confirmations(TEST_COOLDOWN_MS > 0 ? { cooldownMs: TEST_COOLDOWN_MS, maxCooldownMs: TEST_COOLDOWN_MS * 15 } : {});
const PHONE_REQUIRED_MSG = 'нужен сопряжённый телефон; сброс — удалить pairings.json при остановленном мосте';

function broadcastToDevices(obj) {
  const msg = JSON.stringify(obj);
  for (const c of allClients) if (c.deviceId && c.deviceId !== 'local' && c.readyState === 1) c.send(msg);
}

function finishConfirmation(e, allow, reason) {
  confirmations.noteOutcome(e.action, allow); // D-22.3: отказ/истечение — пауза, одобрение — сброс
  broadcastToDevices({ type: 'confirmClosed', confirmId: e.confirmId });
  wsSend(e.requester, { type: 'confirmResult', confirmId: e.confirmId, action: e.action, allow, reason });
  if (allow) e.run();
}

setInterval(() => {
  for (const e of confirmations.sweep()) finishConfirmation(e, false, 'timeout');
}, 5000).unref();

/** Операция владельца: без сопряжённых устройств — флаг интерактивной консоли (P-9),
 *  иначе — только подтверждение на телефоне (D-13); флаг консоли тогда игнорируется. */
function ownerConfirmed(ws, m, action, run) {
  if (pairings.devices.length === 0) {
    // D-22.2: после первого сопряжения консольный путь закрыт, даже если телефоны отозваны
    if (pairings.phoneRequired) { wsSend(ws, { type: 'error', message: PHONE_REQUIRED_MSG }); return; }
    if (m.confirmed === true) run();
    else wsSend(ws, { type: 'confirmRequired', action });
    return;
  }
  // D-22.3: после отказа/истечения — пауза для этого действия, телефон не беспокоим
  const wait = confirmations.cooldownMs(action);
  if (wait > 0) {
    wsSend(ws, { type: 'confirmResult', action, ok: false, allow: false, reason: 'cooldown',
      retryAfterSec: Math.ceil(wait / 1000) });
    return;
  }
  const e = confirmations.request(action, ws, run);
  if (!e) {
    wsSend(ws, { type: 'error', message: 'Подтверждение этой операции уже ожидается на телефоне' });
    return;
  }
  wsSend(ws, { type: 'confirmPending', confirmId: e.confirmId, action, checkCode: e.checkCode,
    message: 'Подтвердите операцию на сопряжённом телефоне (2 минуты)…' });
  broadcastToDevices(confirmView(e));
}

/** D-18 п. 3: QR с 127.0.0.1 телефону бесполезен — без LAN-адреса код не выпускаем. */
function noLanError(ws) {
  wsSend(ws, { type: 'error', message: 'нет LAN-адреса — проверьте сеть' });
}

function sendPairinfo(ws) {
  if (!ws || ws.readyState !== 1) return; // запросивший ушёл — код не выпускаем
  const host = advertisedHost(); // адрес, который реально слушаем в LAN (мог пропасть, пока ждали телефон)
  if (!host) { noLanError(ws); return; }
  const p = regenPairCode();
  wsSend(ws, {
    type: 'pairinfo',
    host,
    port: CONFIG.port,
    code: p.code,
    ttlMin: Math.round(PAIR_TTL_MS / 60000),
    fp: FINGERPRINT,
    internet: internetMsg(),
  });
}

wss.on('connection', (ws, req, who) => {
  ws.on('error', () => { /* необработанная ошибка ws (напр. maxPayload) не должна ронять мост */ });
  // 'local' — имя роли владельца (в этом подплане остальные проверки не меняются)
  ws.deviceId = who === 'owner' ? 'local' : who.id;
  allClients.add(ws);
  ws.attached = null;
  ws.send(JSON.stringify(sessionsMsg()));
  // D-20: ожидающие запросы разрешений — новому клиенту (переподключившийся телефон,
  // запрос из ресинхронизации после рестарта моста), иначе у него нет кнопок ответа
  for (const s of sessions.values()) {
    for (const p of s.pending.values()) {
      wsSend(ws, { type: 'notify', id: s.id, event: 'request', requestId: p.requestId,
        choices: p.choices, message: p.message, title: s.title, at: p.at });
    }
  }
  // D-13: устройство, подключившееся после запроса, тоже видит ожидающие подтверждения
  if (ws.deviceId !== 'local') for (const e of confirmations.list()) wsSend(ws, confirmView(e));

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
            wsSend(ws, { type: 'error', message: 'Достигнут предел числа сессий' });
            break;
          }
          if (!rateAllowCreate(ws.deviceId)) {
            wsSend(ws, { type: 'error', message: 'Слишком часто — подождите немного' });
            break;
          }
          const local = ws.deviceId === 'local';
          createSession({
            cwd: V.str(m.cwd, 1024),
            title: V.cleanTitle(m.title), // L-8
            // D-22.4: undefined и null — агент не указан (умолчание); M-2: иначе строка до 32 символов,
            // прочее (не строка, длиннее) — null, т.е. отказ «неизвестный агент»
            agentId: m.agent === undefined || m.agent === null ? undefined : V.str(m.agent, 32),
            options: m.options,
            // P-3: сырые аргументы и своя команда — только владельцу; от устройства игнорируются
            rawArgs: local && Array.isArray(m.args) && m.args.length <= 64 &&
              m.args.every((a) => typeof a === 'string' && a.length <= 4096) ? m.args : [],
            command: local ? V.str(m.command, 1024) : null,
            local,
            force: m.force === true,
          }).then((r) => {
            if (r.conflict) wsSend(ws, { type: 'createConflict', reason: 'resumeLive', ...r.conflict });
            else wsSend(ws, { type: 'created', id: r.session.id });
          })
            .catch((e) => {
              console.error('  Не удалось создать сессию:', e && e.message);
              wsSend(ws, { type: 'error',
                message: 'Не удалось создать сессию' + (e && e.userMessage ? ': ' + e.userMessage : '') });
            });
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
            // ввод в PTY с любого клиента может ответить на диалог агента: запрос больше не
            // актуален (D-15 п. 9); только для input — не для scroll и не для клавиш reply.
            // M-9: только если ввод действительно ушёл keeper'у — иначе диалог не отвечен
            if (d !== null && keeperSend(s, { t: 'in', d })) {
              emitEvents(s, adapterCall(s, 'onInput', () => s.adapter.onInput(s, d), []));
            }
          }
          break;
        case 'reply': {
          // D-4: семантический ответ на запрос разрешения; мост проверяет, что запрос ещё ждёт
          const requestId = V.str(m.requestId, 128);
          const pend = s && s.alive && requestId ? s.pending.get(requestId) : null;
          // M-4: запрос закрыт или на него уже отвечают (второй телефон / двойное нажатие) — stale
          if (!pend || pend.replying) {
            wsSend(ws, { type: 'replyResult', id: sid, requestId, ok: false, error: 'stale' });
            break;
          }
          // M-5: решение, которого не было в choices запроса, — ошибка клиента, запрос остаётся открытым
          const decision = SE.DECISIONS.includes(m.decision) ? m.decision : null;
          if (!decision || !pend.choices.some((ch) => ch.id === decision)) {
            wsSend(ws, { type: 'replyResult', id: s.id, requestId, ok: false, error: 'failed' });
            break;
          }
          pend.replying = true;
          Promise.resolve()
            .then(() => s.adapter.reply(s, pend, decision, { write: (data) => keeperWrite(s, data) }))
            .then((r) => {
              const res = r && typeof r === 'object' ? r : { ok: false };
              emitEvents(s, res.events);
              wsSend(ws, { type: 'replyResult', id: s.id, requestId, ok: res.ok === true,
                ...(res.ok === true ? {} : { error: res.stale ? 'stale' : 'failed' }) });
            })
            .catch((e) => {
              console.error(`  Сессия ${s.id}: ответ на запрос ${requestId}: ${e && e.message}`);
              wsSend(ws, { type: 'replyResult', id: s.id, requestId, ok: false, error: 'failed' });
            })
            .finally(() => { pend.replying = false; }); // неудачный ответ можно повторить
          break;
        }
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
        case 'list':
          ws.send(JSON.stringify(sessionsMsg()));
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
            // D-29: ПК-клиент сопрягается по LAN и должен знать, что узел принят
            wsSend(ws, { type: 'nodeRegistered', nodeId: nid, ok: true });
          } else {
            wsSend(ws, { type: 'nodeRegistered', nodeId: nid, ok: false });
          }
          break;
        }
        case 'setInternet':
          // только с самого ПК (claude-mobile --device); выключение безопасно — без подтверждения;
          // включение — подтверждение на сопряжённом телефоне, без устройств — в консоли (D-13, P-9)
          if (ws.deviceId !== 'local') break;
          if (m.enabled !== true) { setInternet(false); broadcastInternet(); break; }
          ownerConfirmed(ws, m, 'setInternet', () => { setInternet(true); broadcastInternet(); });
          break;
        case 'pairinfo':
          // код сопряжения — только локальным клиентам (claude-mobile --qr) после подтверждения
          // (D-13, P-9); подтверждение выпуска кода = подтверждение сопряжения (D-15 п. 6);
          // каждый выпуск — свежий код на 10 минут
          if (ws.deviceId !== 'local') break;
          if (!advertisedHost()) { noLanError(ws); break; } // телефон не беспокоим зря (D-18 п. 3)
          ownerConfirmed(ws, m, 'pairinfo', () => sendPairinfo(ws));
          break;
        case 'confirm':
          // подтверждает только сопряжённое устройство, не владелец (D-13); m-1: соединение открыто
          // и устройство не отозвано (сообщение могло прийти в момент отзыва)
          if (ws.deviceId && ws.deviceId !== 'local' && ws.readyState === 1 &&
              pairings.devices.some((d) => d.id === ws.deviceId)) {
            const e = confirmations.resolve(V.str(m.confirmId, 64));
            if (e) finishConfirmation(e, m.allow === true, m.allow === true ? 'allowed' : 'denied');
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
    // I-2: запросивший ушёл — его ожидающие подтверждения снимаются (телефон больше не видит запрос)
    // и это не одобрение — пауза, как после отказа: цикл «запрос + отключение» не спамит телефон
    for (const e of confirmations.cancelByRequester(ws)) {
      confirmations.noteOutcome(e.action, false);
      broadcastToDevices({ type: 'confirmClosed', confirmId: e.confirmId });
    }
    if (ws.attached) { const s = sessions.get(ws.attached); if (s) s.clients.delete(ws); }
  });
});

// ---------------------------------------------------------------- start

/** Сетевые интерфейсы ПК. Тесты (только CLAUDE_BRIDGE_TEST) подставляют свои через
 *  CLAUDE_BRIDGE_TEST_IFACES: JSON или путь к JSON-файлу (перечитывается при каждом вызове). */
function networkInterfaces() {
  const v = TEST_MODE ? process.env.CLAUDE_BRIDGE_TEST_IFACES : '';
  if (!v) return os.networkInterfaces();
  try { return JSON.parse(v.trim().startsWith('{') ? v : fs.readFileSync(v, 'utf8')); } catch { return {}; }
}

/** Адрес основного LAN-интерфейса (P-7): частный адрес физического адаптера, см. lib/lan.js. */
function lanAddress() {
  return pickLanAddress(networkInterfaces());
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
let pendingListens = fixedServers.length;
for (const { srv, host } of fixedServers) {
  srv.listen(CONFIG.port, host, () => { if (--pendingListens === 0) onListening(); });
}

function onListening() {
  beacon.bind(CONFIG.port + 1);
  // порт для трафика из интернет-туннеля — только loopback
  if (inet.enabled) { listenTunnelServer(); startTunnel(); }

  let lanNote;
  if (AUTO_HOST) {
    const first = lanAddress();
    if (first === '127.0.0.1') { lanNote = 'LAN: нет'; warnNoLan(); } else { lanNote = 'LAN: ' + first; lanListen(first); }
    setInterval(repickLan, LAN_REPICK_MS).unref();
  } else {
    lanNote = 'host из конфига';
    announceMdns();
  }

  restoreSessions();

  console.log('');
  console.log('  Claude Bridge запущен (HTTPS/WSS, ' +
    FIXED_HOSTS.map((h) => h + ':' + CONFIG.port).join(' и ') + '; ' + lanNote + ')');
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
