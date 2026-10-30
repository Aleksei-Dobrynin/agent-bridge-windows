'use strict';
// D-11: канал мост<->keeper. Named pipe доступен по SMB (проверено в P-5),
// поэтому keeper ничего не отдаёт без HMAC-доказательства знания секрета сессии,
// а мост в ответ проверяет, что говорит с настоящим keeper'ом.
const net = require('net');
const crypto = require('crypto');

const HANDSHAKE_TIMEOUT_MS = 2000;
const MAX_LINE_BUFFER = 8 * 1024 * 1024;
const MAX_PREAUTH_LINE = 4 * 1024; // до рукопожатия строки короткие
const HELLO_MAX_BYTES = 6 * 1024 * 1024; // запас под лимит строки моста
const HEX64 = /^[0-9a-f]{64}$/;

const isHex64 = (x) => typeof x === 'string' && HEX64.test(x);

function pipeName() {
  return '\\\\.\\pipe\\claude-bridge-' + crypto.randomBytes(16).toString('hex');
}

function mac(secret, label, nonce) {
  const key = Buffer.from(typeof secret === 'string' ? secret : '', 'hex');
  if (key.length !== 32) throw new Error('keeper-channel: секрет должен быть 32 байта (64 hex)');
  return crypto.createHmac('sha256', key).update(label + '|' + nonce).digest('hex');
}

function eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function send(socket, obj) {
  try { socket.write(JSON.stringify(obj) + '\n'); } catch { /* сокет закрыт */ }
}

// Возвращает { setLimit(n) }: до рукопожатия лимит строки мал, после — MAX_LINE_BUFFER.
function readLines(socket, onLine, initialLimit = MAX_LINE_BUFFER) {
  let acc = '';
  let limit = initialLimit;
  socket.setEncoding('utf8'); // декодер хранит хвост многобайтового символа между чанками
  socket.on('data', (chunk) => {
    acc += chunk;
    let i;
    while (!socket.destroyed && (i = acc.indexOf('\n')) >= 0) {
      // лимит — на каждую законченную строку по ТЕКУЩЕМУ значению (setLimit
      // вызывается синхронно из onLine, поэтому auth-ok + hello в одном чанке допустимы)
      if (i > limit) { socket.destroy(); return; }
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object' && !Array.isArray(m)) onLine(m);
    }
    // незавершённая строка (без перевода строки) — тоже в пределах текущего лимита
    if (!socket.destroyed && acc.length > limit) socket.destroy();
  });
  return { setLimit: (n) => { limit = n; } };
}

/** Сторона keeper'а. onAuthed(socket) возвращает обработчик сообщений после рукопожатия. */
function acceptAuthenticated(socket, secret, onAuthed, opts = {}) {
  const nonce = crypto.randomBytes(32).toString('hex');
  let handler = null;
  let authed = false;
  const timer = setTimeout(() => { if (!authed) socket.destroy(); },
    opts.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS);
  socket.on('error', () => {});
  socket.on('close', () => clearTimeout(timer));
  const rl = readLines(socket, (m) => {
    try {
      if (authed) { if (handler) handler(m); return; }
      if (m.t === 'auth' && isHex64(m.nonce) && eq(m.mac, mac(secret, 'client', nonce))) {
        authed = true;
        clearTimeout(timer);
        rl.setLimit(MAX_LINE_BUFFER);
        send(socket, { t: 'auth-ok', mac: mac(secret, 'server', m.nonce) });
        handler = onAuthed(socket) || null;
      } else {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  }, MAX_PREAUTH_LINE);
  send(socket, { t: 'challenge', nonce });
}

/** Сторона моста. Resolve: { socket, send(obj), onMessage(fn) } после взаимной проверки. */
function connectAuthenticated(pipe, secret, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    const nonce = crypto.randomBytes(32).toString('hex');
    let stage = 'challenge';
    let handler = null;
    const pending = [];
    const fail = (err) => {
      if (stage === 'done') return;
      stage = 'done';
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('keeper: таймаут рукопожатия')), timeoutMs);
    socket.on('error', (e) => { if (stage !== 'ready') fail(e); });
    socket.on('close', () => { if (stage !== 'ready') fail(new Error('keeper: соединение закрыто')); });
    const rl = readLines(socket, (m) => {
      try {
        if (stage === 'ready') { if (handler) handler(m); else pending.push(m); return; }
        if (stage === 'challenge' && m.t === 'challenge' && isHex64(m.nonce)) {
          send(socket, { t: 'auth', mac: mac(secret, 'client', m.nonce), nonce });
          stage = 'await-ok';
          return;
        }
        if (stage === 'await-ok' && m.t === 'auth-ok' && eq(m.mac, mac(secret, 'server', nonce))) {
          stage = 'ready';
          clearTimeout(timer);
          rl.setLimit(MAX_LINE_BUFFER);
          resolve({
            socket,
            send: (obj) => send(socket, obj),
            onMessage: (fn) => { handler = fn; while (pending.length) fn(pending.shift()); },
          });
          return;
        }
        fail(new Error('keeper: рукопожатие не прошло'));
      } catch (e) {
        if (stage === 'ready') socket.destroy(); else fail(e);
      }
    }, MAX_PREAUTH_LINE);
  });
}

// M-7: строка hello должна помещаться в лимит моста — отбрасываем самые старые куски.
function fitHello(base, chunks, maxBytes = HELLO_MAX_BYTES) {
  const list = chunks.slice();
  let s = list.join('');
  for (;;) {
    const size = Buffer.byteLength(JSON.stringify({ ...base, buffer: s }));
    if (size <= maxBytes || s.length === 0) return { ...base, buffer: s };
    if (list.length > 1) {
      list.splice(0, Math.max(1, Math.ceil(list.length / 10)));
      s = list.join('');
    } else {
      s = s.slice(Math.ceil(s.length / 4)); // единственный кусок — режем голову
      list[0] = s;
    }
  }
}

module.exports = { pipeName, acceptAuthenticated, connectAuthenticated, send, readLines, fitHello };
