'use strict';
// D-29: удалённый режим claude-mobile для домашнего ПК. Owner-токен и локальный
// сертификат не используются: профиль сопряжения лежит в <данные>/remote.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));
const { ensureDataDirs } = require('./lib/datadir');
const { pinnedTlsOptions } = require('./lib/cert');
const { readQrPng } = require('./lib/qr-image');
const { pairDevice, loadProfile, registerNode } = require('./lib/pair-client');
const { startTunnel, readNodeId } = require('./lib/remote-tunnel');
const W32 = require('./lib/win32-input');

const USAGE = `claude-mobile — удалённый ПК-клиент (домашний ПК)

  claude-mobile --pair <qr.png>   сопрячься с мостом рабочего ПК по QR (разово, в LAN)
  claude-mobile --remote -l       список сессий рабочего ПК через туннель
  claude-mobile --remote -a [id]  подключиться к сессии (без id — к последней живой)
  claude-mobile --remote -h       эта справка

Сессии создаются на рабочем ПК: удалённо доступны только список и подключение.
Ctrl+\\ — отсоединиться (сессия продолжает работать на рабочем ПК).`;

function fail(msg) { console.error(msg); process.exit(1); }

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
  // без бинаря туннеля сопряжение бессмысленно (NodeId не получить) — проверяем ДО /pair,
  // чтобы не оставить на мосте «осиротевшее» устройство
  if (!process.env.CLAUDE_BRIDGE_TUNNEL && !fs.existsSync(path.join(__dirname, 'bin', 'claude-tunnel.exe'))) {
    fail('Нет bridge\\bin\\claude-tunnel.exe — без него --remote не работает. Установите мост целиком.');
  }
  const DATA = ensureDataDirs();
  let ticket;
  try { ticket = readQrPng(png); } catch (e) { fail('Не удалось прочитать QR: ' + e.message); }
  let r;
  try { r = await pairDevice({ ticket, name: os.hostname(), root: DATA.root }); } catch (e) { fail(e.message); }
  console.log(`Сопряжено с мостом ${r.host}:${r.port}.`);
  if (!r.ticket) {
    console.log('Внимание: интернет-доступ на рабочем ПК выключен. Включите его и сопрягите заново — ' +
      'иначе --remote не сможет поднять туннель.');
  }
  let nodeId;
  try { nodeId = readNodeId({ secretFile: r.paths.secret }); } catch (e) { fail(e.message); }
  try {
    await registerNode({
      host: r.host, port: r.port, token: r.token, nodeId,
      pin: pinnedTlsOptions(new crypto.X509Certificate(fs.readFileSync(r.paths.cert)).toString(), r.fingerprint),
    });
  } catch (e) { fail('Не удалось зарегистрировать p2p-узел: ' + e.message); }
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
  if (!prof.ticket) fail('Мост не сообщил ticket туннеля. Включите интернет-доступ на рабочем ПК и сопрягите заново.');
  let der;
  let token;
  try {
    der = fs.readFileSync(prof.paths.cert);
    token = String(fs.readFileSync(prof.paths.token, 'utf8')).trim();
  } catch (e) { fail('Профиль сопряжения повреждён — сопрягите заново (--pair): ' + e.message); }
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  if (fp !== prof.fingerprint) fail('Сертификат моста не совпадает с сохранённым — сопрягите заново (--pair).');
  const pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), fp);

  let tunnel;
  try { tunnel = await startTunnel({ ticket: prof.ticket, secretFile: prof.paths.secret }); }
  catch (e) { fail(e.message); }

  let raw = false;
  let sid = null;
  function cleanup() {
    if (raw && process.stdin.isTTY) {
      raw = false;
      try { process.stdin.setRawMode(false); } catch { /* консоль закрыта */ }
      if (process.stdout.isTTY) { try { process.stdout.write(W32.CONSOLE_RESET); } catch { /* закрыта */ } }
    }
  }
  function die(msg, code) {
    cleanup();
    try { tunnel.stop(); } catch { /* уже остановлен */ }
    if (msg) console.error(msg);
    process.exit(code || 0);
  }
  process.on('exit', () => { cleanup(); try { tunnel.stop(); } catch { /* уже */ } });

  const ws = new WebSocket(`wss://127.0.0.1:${tunnel.port}/ws`, {
    ...pin, headers: { Authorization: 'Bearer ' + token },
  });
  const send = (o) => ws.send(JSON.stringify(o));

  function attach(id) {
    sid = id;
    send({ type: 'attach', id, cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
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
      send({ type: 'input', id: sid, data: s });
    });
    process.stdout.on('resize', () => {
      send({ type: 'resize', id: sid, cols: process.stdout.columns, rows: process.stdout.rows });
    });
  }

  ws.on('unexpected-response', (req, res) => {
    req.destroy();
    if (res.statusCode === 401) die('Мост отклонил токен устройства — оно отозвано? Сопрягите заново (--pair).', 1);
    else die('Мост ответил HTTP ' + res.statusCode + ' вместо WebSocket.', 1);
  });
  ws.on('error', (e) => die('Мост недоступен через туннель (' + e.message + ').', 1));
  ws.on('close', (code) => {
    if (code === 4401) die('\r\n[Устройство отозвано — мост закрыл соединение.]', 1);
    die('\r\n[Соединение с мостом закрыто' + (code && code !== 1005 ? ` (код ${code})` : '') + '. Продолжить: claude-mobile --remote -a]', 1);
  });

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'sessions': {
        const list = Array.isArray(m.sessions) ? m.sessions : [];
        if (mode === '-l' || mode === '--list') {
          if (!list.length) console.log('Сессий нет.');
          for (const s of list) {
            console.log(`${s.id}\t${s.alive ? 'жива' : 'завершена'}\t${s.agentName || s.agent || '-'}\t${s.title}\t${s.cwd}`);
          }
          die('', 0);
          break;
        }
        const target = rest[1] ? list.find((s) => s.id === rest[1]) : list.filter((s) => s.alive).pop();
        if (!target) die('Живых сессий нет. Запустите сессию на рабочем ПК.', 1);
        else attach(target.id);
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

module.exports = { main, USAGE };
