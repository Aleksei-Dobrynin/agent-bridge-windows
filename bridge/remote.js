'use strict';
// D-29/D-30: удалённый режим claude-mobile для домашнего ПК. Owner-токен и локальный
// сертификат не используются: профиль сопряжения лежит в <данные>/remote.
// D-30: путь выбирает lib/client-session (LAN приоритетен, туннель — запасной),
// ticket обновляется по LAN и сохраняется, обрыв переживается переподключением.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ensureDataDirs } = require('./lib/datadir');
const { pinnedTlsOptions } = require('./lib/cert');
const { readQrPng } = require('./lib/qr-image');
const { pairDevice, loadProfile } = require('./lib/pair-client');
const { startTunnel, readNodeId, defaultExe } = require('./lib/remote-tunnel');
const { createSession, updateProfile } = require('./lib/client-session');
const W32 = require('./lib/win32-input');

const USAGE = `claude-mobile — удалённый ПК-клиент (домашний ПК)

  claude-mobile --pair <qr.png>   сопрячься с мостом рабочего ПК по QR (разово, в LAN)
  claude-mobile --remote -l       список сессий рабочего ПК (LAN или туннель)
  claude-mobile --remote -a [id]  подключиться к сессии (без id — к последней живой)
  claude-mobile --remote -h       эта справка

Путь выбирается сам: в офисе — напрямую по LAN, вне её — через p2p-туннель.
Сессии создаются на рабочем ПК: удалённо доступны только список и подключение.
Ctrl+\\ — отсоединиться (сессия продолжает работать на рабочем ПК).`;

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

function fail(msg) { console.error(msg); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function main(argv) {
  const cmd = argv[0];
  if (cmd === '--pair') return pair(argv.slice(1));
  if (cmd === '--remote') return remote(argv.slice(1));
  fail(USAGE);
}

async function pair(rest) {
  const png = rest[0];
  if (!png || png.startsWith('-')) fail('Укажите файл QR: claude-mobile --pair <qr.png>');
  if (!fs.existsSync(png)) fail('Нет файла QR: ' + png);
  const DATA = ensureDataDirs();
  let ticket;
  try { ticket = readQrPng(png); } catch (e) { fail('Не удалось прочитать QR: ' + e.message); }
  // NodeId получаем ДО /pair: без рабочего туннеля сопряжение бессмысленно.
  const secret = path.join(DATA.root, 'remote', 'iroh.key');
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  const exe = defaultExe();
  if (!fs.existsSync(exe)) {
    fail(`Нет ${exe} — без него --remote не работает. Установите мост целиком.`);
  }
  let nodeId;
  try { nodeId = readNodeId({ secretFile: secret }); } catch (e) { fail(e.message); }
  let r;
  try { r = await pairDevice({ ticket, name: os.hostname(), root: DATA.root, nodeId }); } catch (e) { fail(e.message); }
  console.log(`Сопряжено с мостом ${r.host}:${r.port}.`);
  if (!r.ticket) {
    console.log('Внимание: интернет-доступ на рабочем ПК выключен. Правильный порядок: включить доступ ' +
      '(claude-mobile --device → i), затем выпустить QR и сопрячь заново. Иначе --remote не сможет ' +
      'поднять туннель, а повторный QR потребует подтверждения на телефоне (при потере телефона — ' +
      'удалить pairings.json при остановленном мосте).');
  }
  console.log('p2p-узел зарегистрирован. Дальше: claude-mobile --remote -l');
  process.exit(0);
}

async function remote(rest) {
  const mode = rest[0];
  if (mode === '-h' || mode === '--help') { console.log(USAGE); process.exit(0); }
  const DATA = ensureDataDirs();
  const prof = loadProfile(DATA.root);
  if (!prof) fail('Нет профиля сопряжения. На ноутбуке в LAN рабочего ПК: claude-mobile --pair <qr.png>');
  if (mode && !['-l', '--list', '-a', '--attach'].includes(mode)) {
    fail('Удалённо доступны только -l и -a: сессии создаются на рабочем ПК.');
  }
  let der;
  let token;
  try {
    der = fs.readFileSync(prof.paths.cert);
    token = String(fs.readFileSync(prof.paths.token, 'utf8')).trim();
  } catch (e) { fail('Профиль сопряжения повреждён — сопрягите заново (--pair): ' + e.message); }
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  if (fp !== prof.fingerprint) fail('Сертификат моста не совпадает с сохранённым — сопрягите заново (--pair).');
  const pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), fp);

  const session = createSession({
    profile: prof, token, pin,
    startTunnel: (o) => startTunnel(o),
    saveProfile: (patch) => updateProfile(prof.paths.profile, patch),
  });

  let raw = false;
  let sid = null;
  let current = null; // WS текущего соединения: ввод и resize всегда идут в него
  let stopping = false;

  function cleanup() {
    if (raw && process.stdin.isTTY) {
      raw = false;
      try { process.stdin.setRawMode(false); } catch { /* консоль закрыта */ }
      if (process.stdout.isTTY) { try { process.stdout.write(W32.CONSOLE_RESET); } catch { /* закрыта */ } }
    }
  }
  function die(msg, code) {
    stopping = true;
    cleanup();
    session.stop();
    if (msg) console.error(msg);
    process.exit(code || 0);
  }
  process.on('exit', () => { cleanup(); session.stop(); });
  process.on('SIGINT', () => die('\r\n[отсоединился — сессия продолжает работать; вернуться: claude-mobile --remote -a]\r'));
  process.on('SIGTERM', () => die('', 1));

  function attach(ws, id) {
    sid = id;
    ws.send(JSON.stringify({ type: 'attach', id, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 }));
  }

  function enterRaw() {
    if (raw || !process.stdin.isTTY) return;
    raw = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const s = d.toString('utf8');
      if (W32.isCtrlBackslash(s)) {
        die('\r\n[отсоединился — сессия продолжает работать; вернуться: claude-mobile --remote -a]\r');
        return;
      }
      if (current) current.send(JSON.stringify({ type: 'input', id: sid, data: s }));
    });
    process.stdout.on('resize', () => {
      if (current) current.send(JSON.stringify({ type: 'resize', id: sid, cols: process.stdout.columns, rows: process.stdout.rows }));
    });
  }

  function handle(ws) {
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      if (res.statusCode === 401) die('Мост отклонил токен устройства — оно отозвано? Сопрягите заново (--pair).', 1);
      die('Мост ответил HTTP ' + res.statusCode + ' вместо WebSocket.', 1);
    });
    ws.on('error', () => { /* решение — по close */ });
    ws.on('close', (code) => {
      if (stopping) return;
      if (code === 4401) die('\r\n[Устройство отозвано — мост закрыл соединение.]', 1);
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      switch (m.type) {
        case 'sessions': {
          if (sid) break; // переподключение: уже привязаны к сессии
          const list = Array.isArray(m.sessions) ? m.sessions : [];
          if (mode === '-l' || mode === '--list') {
            if (!list.length) console.log('Сессий нет.');
            for (const s of list) {
              console.log(`${s.id}\t${s.alive ? 'жива' : 'завершена'}\t${s.agentName || s.agent || '-'}\t${s.title}\t${s.cwd}`);
            }
            die('', 0);
            break;
          }
          const want = rest[1];
          const target = want ? list.find((s) => s.id === want && s.alive) : list.filter((s) => s.alive).pop();
          if (!target) {
            if (want) {
              const known = list.find((s) => s.id === want);
              die(known ? `Сессия ${want} завершена. Список: claude-mobile --remote -l`
                : `Нет сессии ${want}. Список: claude-mobile --remote -l`, 1);
            }
            die('Живых сессий нет. Запустите сессию на рабочем ПК.', 1);
          } else attach(ws, target.id);
          break;
        }
        case 'scrollback':
          enterRaw();
          process.stdout.write(m.data);
          break;
        case 'output':
          if (m.id === sid) process.stdout.write(m.data);
          break;
        case 'exit':
          if (m.id === sid) die(`\r\n[сессия завершена, код ${m.exitCode}]`, m.exitCode === 0 ? 0 : 1);
          break;
        case 'error':
          if (!sid) die('Мост: ' + (typeof m.message === 'string' ? m.message : 'ошибка'), 1);
          else process.stderr.write('\r\n[Мост: ' + m.message + ']\r\n');
          break;
      }
    });
  }

  let attempt = 0;
  let connectedOnce = false;
  for (;;) {
    let conn;
    try { conn = await session.connect(); }
    catch (e) {
      if (e.revoked) die('Мост отклонил токен устройства — оно отозвано? Сопрягите заново (--pair).', 1);
      if (e.noTicket) die('Мост не сообщил ticket туннеля. Включите интернет-доступ на рабочем ПК и сопрягите заново.', 1);
      if (!connectedOnce && (mode === '-l' || mode === '--list')) die(e.message, 1); // список не ждёт
      const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt++;
      process.stderr.write(`\r\n[${e.message}] Повтор через ${Math.round(delay / 1000)} с…\r\n`);
      await sleep(delay);
      continue;
    }
    attempt = 0;
    connectedOnce = true;
    const ws = conn.ws;
    current = ws;
    handle(ws);
    if (sid) {
      // переподключение: чистим экран и просим хвост буфера заново
      process.stdout.write('\x1b[2J\x1b[H');
      attach(ws, sid);
    }
    await new Promise((r) => ws.once('close', r));
    if (stopping) break;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt++;
    process.stderr.write(`\r\n[соединение потеряно — переподключаюсь через ${Math.round(delay / 1000)} с]\r\n`);
    await sleep(delay);
  }
}

module.exports = { main, USAGE };
