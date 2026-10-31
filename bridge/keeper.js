#!/usr/bin/env node
'use strict';
// Хранитель сессии: отдельный отсоединённый процесс, владеет PTY (ConPTY) и
// переживает перезапуск моста. Канал к мосту — named pipe с рукопожатием (D-11).
// Порядок запуска: сначала listen на pipe, затем PTY (если pipe занят — агент не стартует).
const fs = require('fs');
const net = require('net');
const path = require('path');
const pty = require(path.join(__dirname, 'node_modules', 'node-pty'));
const K = require('./lib/keeper-channel');
const { resolveSpawn } = require('./lib/which');
const W32 = require('./lib/win32-input');

const metaPath = process.argv[2];
const logsDir = path.join(path.dirname(metaPath), '..', 'logs');
let meta = null;
let term = null;

function keeperLogName() {
  const id = (meta && typeof meta.id === 'string' && meta.id) || path.basename(metaPath, '.json');
  return 'keeper-' + id.replace(/[^\w.-]/g, '_') + '.log';
}

// Любая ошибка старта/работы: причина в лог, meta удаляется, процесс завершается.
function die(code, reason) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, keeperLogName()),
      `${new Date().toISOString()} ${reason}\n`);
  } catch { /* лог недоступен */ }
  try { fs.unlinkSync(metaPath); } catch { /* уже удалён */ }
  if (term) { try { term.kill(); } catch { /* уже завершён */ } }
  process.exit(code);
}

try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch (e) {
  die(1, 'не удалось прочитать meta: ' + (e && e.message));
}

const secret = process.env.CLAUDE_BRIDGE_KEEPER_SECRET || meta.secret;
// секрет канала не должен попасть в окружение агента
delete process.env.CLAUDE_BRIDGE_KEEPER_SECRET;
if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) {
  die(2, 'секрет канала отсутствует или неверного формата (нужно 64 hex)');
}

// listen(undefined) открыл бы TCP-порт: допускаем только pipe нашего вида
if (typeof meta.pipe !== 'string' || !/^\\\\\.\\pipe\\claude-bridge-[0-9a-f]{32}$/.test(meta.pipe)) {
  die(1, 'meta.pipe отсутствует или неверного формата');
}

const MAX_AUTHED_CLIENTS = 16;
const LIMIT = meta.scrollbackBytes || 262144;
let buffer = [];
let bytes = 0;
const clients = new Set();

function startPty() {
  const { file, args } = resolveSpawn(meta.cmd, meta.args || []);
  term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: meta.cols || 100,
    rows: meta.rows || 30,
    cwd: meta.cwd,
    env: process.env,
  });
  term.onData((d) => {
    buffer.push(d);
    bytes += Buffer.byteLength(d);
    while (bytes > LIMIT && buffer.length > 1) bytes -= Buffer.byteLength(buffer.shift());
    for (const c of clients) K.send(c, { t: 'out', d });
  });
  term.onExit(({ exitCode }) => {
    for (const c of clients) K.send(c, { t: 'exit', code: exitCode });
    try { fs.unlinkSync(metaPath); } catch { /* уже удалён */ }
    // node-pty держит цикл событий — выходим явно (проверено в P-5)
    setTimeout(() => process.exit(0), 200);
  });
}

const srv = net.createServer((sock) => {
  K.acceptAuthenticated(sock, secret, (c) => {
    if (clients.size >= MAX_AUTHED_CLIENTS) { c.destroy(); return null; }
    clients.add(c);
    c.on('close', () => clients.delete(c));
    K.send(c, K.fitHello({ t: 'hello', cols: term.cols, rows: term.rows, pid: term.pid }, buffer));
    return (m) => {
      // D-23.1: одиночный Esc ConPTY теряет после win32-input-mode-ввода — пишем его в этой кодировке
      if (m.t === 'in' && typeof m.d === 'string') term.write(m.d === '\x1b' ? W32.ESC : m.d);
      else if (m.t === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) &&
        m.cols > 0 && m.rows > 0 && m.cols <= 1000 && m.rows <= 1000) {
        try { term.resize(m.cols, m.rows); } catch { /* PTY уже закрыт */ }
      } else if (m.t === 'kill') {
        try { term.kill(); } catch { /* уже завершён */ }
      }
    };
  });
});
srv.maxConnections = 64; // всего сокетов; аутентифицированных — не более MAX_AUTHED_CLIENTS
srv.on('error', (e) => die(1, 'pipe: ' + (e && e.stack || e)));
srv.listen(meta.pipe, () => {
  try { startPty(); } catch (e) { die(1, 'запуск агента: ' + (e && e.message)); }
});
