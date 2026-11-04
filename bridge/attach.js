#!/usr/bin/env node
'use strict';
// D-29: удалённый ПК-клиент — отдельный режим: owner.token и локальный сертификат не нужны.
if (process.argv[2] === '--remote' || process.argv[2] === '--pair') {
  require('./remote').main(process.argv.slice(2));
  return; // CommonJS: дальше локальный код этого файла не выполняется
}
// claude-mobile: запустить агента (Claude Code, opencode, …) через мост и зеркалировать
// сессию в этом терминале. Телефон видит ту же сессию и может вмешиваться.
//
//   claude-mobile [args…]    новая сессия агента по умолчанию в текущем каталоге; все
//                            аргументы передаются самому агенту (--resume, --continue…)
//   claude-mobile --agent <id> [args…]  новая сессия указанного агента (D-5)
//   claude-mobile -l         список сессий
//   claude-mobile -a [id]    подключиться к сессии (без id — к последней живой)
//   claude-mobile --device   доверенные устройства: просмотр и отзыв
//   claude-mobile --qr       показать QR-код сопряжения (мост должен работать)
//
// Выпуск кода сопряжения и включение интернет-доступа: если уже есть сопряжённый телефон —
// подтверждение на нём (D-13), иначе — вопрос в этой консоли (P-9).
//   claude-mobile --open     открыть веб-интерфейс моста в браузере
//   claude-mobile --rotate-token  перевыпустить токен владельца
//
// Ctrl+\  — отсоединиться (сессия продолжает жить, телефон остаётся подключён)
//
// Подключение (P-1, M-8): wss://127.0.0.1:<port>/ws с токеном владельца
// (owner.token в каталоге данных) и пиннингом сертификата моста (certs\bridge.cer).
// Каталог данных — lib/datadir.js (CLAUDE_BRIDGE_HOME для тестов), порт — из
// config.json там же; CLAUDE_BRIDGE_LISTEN_PORT переопределяет его, как и у моста.
// --open печатает одноразовую ссылку только в интерактивную консоль: без TTY (агент)
// ссылка не выводится — иначе агент получил бы права владельца, не читая файлов (D-13, D-16.3).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));
const { ensureDataDirs } = require('./lib/datadir');
const { pinnedTlsOptions } = require('./lib/cert');
const { buildLoginUrl, openInBrowser } = require('./lib/open-url');
const W32 = require('./lib/win32-input');

const args = process.argv.slice(2);

const USAGE = `claude-mobile — агент через мост (зеркало на телефон)

  claude-mobile [args…]              новая сессия агента по умолчанию в текущем каталоге;
                                     аргументы передаются самому агенту (--resume, --continue…)
  claude-mobile --agent <id> [args…] новая сессия указанного агента (claude, opencode, …)
  claude-mobile -l                   список сессий
  claude-mobile -a [id]              подключиться к сессии (без id — к последней живой)
  claude-mobile --device             доверенные устройства и интернет-доступ
  claude-mobile --qr                 QR-код сопряжения нового устройства
  claude-mobile --open               открыть веб-интерфейс моста в браузере (одноразовая ссылка)
  claude-mobile --rotate-token       перевыпустить токен владельца
  claude-mobile --pair <qr.png>      сопрячься с мостом рабочего ПК (разово, в LAN)
  claude-mobile --remote [-l|-a [id]] работа с сессиями рабочего ПК через туннель
  claude-mobile -h                   эта справка

Если уже есть сопряжённый телефон, выпуск кода и включение интернет-доступа
подтверждаются на нём; иначе — здесь, в консоли.

Ctrl+\\ — отсоединиться: сессия продолжит жить, вернуться — claude-mobile -a.
Завершить сессию по-настоящему: выйти из агента (например, /exit)
или долгим нажатием на её вкладку в приложении на телефоне.`;

// Частые опечатки в НАШИХ флагах ловим до создания сессии: иначе «claude --l»
// молча запустил бы сессию, claude отверг бы флаг и умер с загадочным
// «[сессия завершена]».
const TYPOS = new Map([
  ['--l', '-l'], ['-list', '-l'],
  ['--a', '-a'], ['-attach', '-a'],
  ['-device', '--device'], ['-devices', '--device'],
  ['-qr', '--qr'], ['--h', '-h'], ['-help', '-h'],
  ['-open', '--open'], ['-rotate-token', '--rotate-token'], ['-agent', '--agent'],
]);

if (args[0] === '-h' || args[0] === '--help') {
  console.log(USAGE);
  process.exit(0);
}
if (TYPOS.has(args[0])) {
  console.error(`Неизвестный флаг «${args[0]}» — возможно, вы имели в виду «${TYPOS.get(args[0])}»?\n`);
  console.error(USAGE);
  process.exit(1);
}
// D-5: агент новой сессии; остальные аргументы, как и раньше, уходят самому агенту
let agentId = null;
if (args[0] === '--agent') {
  agentId = args[1];
  if (!agentId || agentId.startsWith('-')) {
    console.error('Укажите id агента: claude-mobile --agent <id> [аргументы…]');
    process.exit(1);
  }
  args.splice(0, 2);
  // m-2: собственные флаги claude-mobile после --agent не переинтерпретируем (иначе
  // «--agent x -l» молча показал бы список, а «--agent x --qr» выпустил бы код сопряжения)
  const OWN = new Set(['-l', '--list', '-a', '--attach', '--device', '--devices', '--qr', '--open',
    '--rotate-token', '-h', '--help']);
  if (OWN.has(args[0])) {
    console.error(`--agent нельзя сочетать с ${args[0]}: claude-mobile --agent <id> [аргументы агента…]`);
    process.exit(1);
  }
}

/** m-3: интерактивная консоль — и ввод, и вывод (одна проверка для всех мест). */
const isTty = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// Сопряжение и меню устройств (отзыв, интернет-доступ) — только для человека в
// интерактивной консоли (P-9); проверяем до подключения к мосту.
if ((args[0] === '--qr' || args[0] === '--device' || args[0] === '--devices') && !isTty()) {
  console.error('Эта операция требует подтверждения в интерактивной консоли.');
  process.exit(1);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** Порт моста: CLAUDE_BRIDGE_LISTEN_PORT или port из config.json (правила как в server.js). */
function bridgePort(configFile) {
  let raw = process.env.CLAUDE_BRIDGE_LISTEN_PORT;
  if (raw === undefined || raw === '') {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) {
      fail(e.code === 'ENOENT'
        ? `Мост ещё не запускался на этом ПК (нет ${configFile}). Запустите bridge\\server.js.`
        : `Не удалось прочитать ${configFile}: ${e.message}`);
    }
    raw = cfg && cfg.port !== undefined ? cfg.port : 8790;
  }
  const n = (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) ? Number(raw) : raw;
  if (!Number.isInteger(n) || n < 1 || n > 65533) fail(`Неверный порт моста: ${JSON.stringify(raw)}`);
  return n;
}

function readOrFail(file, what) {
  try { return fs.readFileSync(file); } catch (e) {
    return fail(e.code === 'ENOENT'
      ? `Нет ${what} (${file}) — мост ещё не запускался? Запустите bridge\\server.js.`
      : `Не удалось прочитать ${what} (${file}): ${e.message}`);
  }
}

const DATA = ensureDataDirs();
const PORT = bridgePort(DATA.config);
const BRIDGE = `wss://127.0.0.1:${PORT}/ws`;
const CER = readOrFail(path.join(DATA.certs, 'bridge.cer'), 'сертификата моста');
const OWNER = String(readOrFail(DATA.ownerToken, 'токена владельца')).trim();

// Доверяем только сертификату нашего моста (пиннинг по отпечатку, M-8); WebSocket —
// всегда новое TLS-соединение, keep-alive не обходит проверку.
const ws = new WebSocket(BRIDGE, {
  ...pinnedTlsOptions(new crypto.X509Certificate(CER).toString(),
    crypto.createHash('sha256').update(CER).digest('hex')),
  headers: { Authorization: 'Bearer ' + OWNER },
});
let sid = null;
let rotating = false; // --rotate-token: закрытие с кодом 4401 — ожидаемое подтверждение
let decided = false;
let raw = false;

function die(msg, code) {
  cleanup();
  if (msg) console.error(msg);
  process.exit(code || 0);
}

function cleanup() {
  if (raw && process.stdin.isTTY) {
    raw = false;
    try { process.stdin.setRawMode(false); } catch { /* консоль уже закрыта */ }
    // агент мог включить в этой консоли win32-input-mode (\x1b[?9001h проходит через наш вывод),
    // мышь, отчёт о фокусе, альтернативный экран: без сброса следующая программа в консоли
    // получает клавиши как \x1b[…_ (D-25 п. 5)
    if (process.stdout.isTTY) {
      try { process.stdout.write(W32.CONSOLE_RESET); } catch { /* консоль уже закрыта */ }
    }
  }
}
// любой выход (в т.ч. process.exit из веток ниже) возвращает консоль из raw-режима
process.on('exit', cleanup);

function send(obj) { ws.send(JSON.stringify(obj)); }

// последняя операция, требующая подтверждения (D-13) — для повтора с confirmed:true (P-9)
let lastSensitive = null;
function sendSensitive(obj) { lastSensitive = obj; send(obj); }

function attach(id) {
  sid = id;
  send({
    type: 'attach', id,
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  });
}

let createdAtMs = 0; // когда МЫ создали сессию — для диагностики мгновенной смерти

/**
 * Создание сессии. Конфликт resume (живая сессия того же агента в этом каталоге — resume
 * открытой беседы создал бы её КОПИЮ) определяет мост и отвечает createConflict (D-7);
 * после согласия человека — повтор с force:true.
 */
function doCreate(force) {
  createdAtMs = Date.now();
  const shown = (agentId || 'агент по умолчанию') + (args.length ? ' ' + args.join(' ') : '');
  console.log(`Запускаю: ${shown}  (каталог ${process.cwd()})`);
  send({ type: 'create', cwd: process.cwd(), ...(agentId ? { agent: agentId } : {}), args, force: force === true });
}

function enterRaw() {
  if (raw || !process.stdin.isTTY) return;
  raw = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    const s = d.toString('utf8');
    // Ctrl+\ — сырой 0x1c или, после \x1b[?9001h от агента, в кодировке win32-input-mode
    // (D-23.2): порция с этим нажатием в агента не пересылается
    if (W32.isCtrlBackslash(s)) {
      die('\r\n[отсоединился — сессия продолжает работать; вернуться: claude-mobile -a]\r');
      return;
    }
    send({ type: 'input', id: sid, data: s });
  });
  // Windows: SIGWINCH нет, изменение размера консоли приходит событием 'resize'
  process.stdout.on('resize', () => {
    send({ type: 'resize', id: sid, cols: process.stdout.columns, rows: process.stdout.rows });
  });
}

/**
 * P-9: подтверждение живым человеком в интерактивной консоли — агент запускает команды без TTY.
 * Мост просит его (confirmRequired), только если сопряжённых телефонов нет: от агента, который
 * сам откроет WS с токеном владельца, консоль не защищает — при сопряжённом телефоне мост
 * принимает подтверждение только с него (D-13).
 */
function confirmHuman(question, onYes, iface) {
  if (!isTty()) {
    die('Эта операция требует подтверждения в интерактивной консоли.', 1);
    return;
  }
  const q = iface || readline.createInterface({ input: process.stdin, output: process.stdout });
  q.question(question + ' [y/N]: ', (ans) => {
    if (!iface) q.close();
    if (/^[yд]/i.test(ans.trim())) onYes(); else die('Отменено.', 1); // m-3: отказ — код 1
  });
}

/** --open: открыть ссылку входа в браузере; напечатать её — только в интерактивную консоль. */
function openLoginUrl(m) {
  const url = buildLoginUrl(m);
  if (!url) { die('Мост вернул некорректный токен входа.', 1); return; }
  openInBrowser(url, { onError: (e) => console.error('Не удалось запустить браузер: ' + e.message) });
  console.log('Открываю веб-интерфейс моста (ссылка одноразовая, действует 60 с).');
  if (isTty()) console.log('Если браузер не открылся: ' + url); // D-18 п. 2
  setTimeout(() => process.exit(0), 300);
}

ws.on('unexpected-response', (req, res) => {
  req.destroy();
  if (res.statusCode === 401) {
    die(`Мост отклонил токен владельца (${DATA.ownerToken}). Токен перевыпускали вручную? ` +
      'Мост перечитывает файл только при перезапуске; штатная смена — claude-mobile --rotate-token.', 1);
  } else {
    die(`Мост ответил HTTP ${res.statusCode} вместо WebSocket.`, 1);
  }
});
ws.on('error', (e) => die('Мост недоступен (' + e.message + '). Запущен ли bridge\\server.js?', 1));
ws.on('close', (code) => {
  if (rotating && code === 4401) {
    console.log('Токен владельца перевыпущен; открытые вкладки браузера нужно открыть заново (claude-mobile --open).');
    die('', 0);
  } else if (code === 4401) {
    die('\r\n[Токен владельца перевыпущен — мост закрыл соединение. Запустите claude-mobile заново.]', 1);
  } else {
    die('\r\n[Соединение с мостом закрыто' + (code && code !== 1005 ? ` (код ${code})` : '') + '.]', 1);
  }
});

ws.on('message', (rawMsg) => {
  let m;
  try { m = JSON.parse(rawMsg); } catch { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'sessions': {
      if (decided) return;
      decided = true;
      if (args[0] === '--device' || args[0] === '--devices') {
        send({ type: 'internet' }); // придёт раньше devices — меню покажет статус
        send({ type: 'devices' });
      } else if (args[0] === '--open') {
        send({ type: 'issueLoginToken' });
      } else if (args[0] === '--rotate-token') {
        rotating = true;
        send({ type: 'rotateOwnerToken' });
        // подтверждение — закрытие соединения мостом с кодом 4401 (обработчик 'close')
        setTimeout(() => die('Мост не подтвердил перевыпуск токена владельца.', 1), 5000);
      } else if (args[0] === '--qr') {
        // D-13: подтверждение — на сопряжённом телефоне (confirmPending) или, если телефонов
        // нет, здесь в консоли (confirmRequired -> повтор с confirmed:true)
        sendSensitive({ type: 'pairinfo' });
      } else if (args[0] === '-l' || args[0] === '--list') {
        if (!m.sessions.length) console.log('Сессий нет.');
        for (const s of m.sessions) {
          console.log(`${s.id}\t${s.alive ? 'жива' : 'завершена'}\t${s.agentName || s.agent || '-'}\t${s.title}\t${s.cwd}`);
        }
        process.exit(0);
      } else if (args[0] === '-a' || args[0] === '--attach') {
        const target = args[1]
          ? m.sessions.find((s) => s.id === args[1])
          : m.sessions.filter((s) => s.alive).pop();
        if (!target) die('Живых сессий нет. Запустите: claude-mobile', 1);
        else attach(target.id);
      } else {
        // все остальные аргументы уходят самому агенту
        doCreate(false);
      }
      break;
    }
    case 'created':
      attach(m.id);
      break;
    case 'createConflict': {
      // D-7: мост сам сравнил каталоги и нашёл живые сессии этого агента
      const live = Array.isArray(m.live) ? m.live : [];
      console.log('⚠ В этом каталоге уже есть живые сессии этого агента:');
      for (const s of live) console.log(`    ${s.id}\t${s.title}`);
      console.log('Если ваша беседа ещё открыта в одной из них, resume создаст её КОПИЮ.');
      if (live.length) console.log(`Вернуться в живую сессию: claude-mobile -a ${live[live.length - 1].id}`);
      if (!isTty()) { die('Отменено (нет интерактивной консоли).', 1); break; }
      const q = readline.createInterface({ input: process.stdin, output: process.stdout });
      q.question('Всё равно продолжить с resume? [y/N]: ', (ans) => {
        q.close();
        if (/^[yд]/i.test(ans.trim())) doCreate(true); else die('Отменено.', 1);
      });
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
      if (m.id === sid) {
        let msg = `\r\n[сессия завершена, код ${m.exitCode}]`;
        // сессию создали мы, и агент умер почти сразу с ошибкой —
        // почти наверняка он не принял переданные аргументы
        if (createdAtMs && m.exitCode !== 0 && Date.now() - createdAtMs < 15000 && args.length) {
          msg += `\r\nагент вышел сразу после старта — возможно, не принял аргументы: ${args.join(' ')}`;
          msg += '\r\nСправка: claude-mobile -h';
        }
        die(msg, m.exitCode === 0 ? 0 : 1);
      }
      break;
    case 'devices':
      if (args[0] === '--device' || args[0] === '--devices') deviceTui(m);
      break;
    case 'internet':
      inetState = m;
      break;
    case 'loginToken':
      openLoginUrl(m);
      break;
    case 'confirmRequired':
      // D-13: сопряжённых телефонов нет — подтверждает человек в этой консоли (P-9)
      if (!lastSensitive) break;
      confirmHuman(m.action === 'pairinfo' ? 'Выпустить код сопряжения нового устройства?' : 'Включить доступ через интернет?',
        () => {
          send({ ...lastSensitive, confirmed: true });
          if (m.action === 'setInternet') setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
        });
      break;
    case 'confirmPending':
      console.log(typeof m.message === 'string' && m.message ? m.message : 'Подтвердите операцию на сопряжённом телефоне…');
      // D-22.3: человек сверяет код с запросом на телефоне — так виден чужой (агентский) запрос
      if (typeof m.checkCode === 'string' && /^\d{4}$/.test(m.checkCode)) console.log(`Сверьте код на телефоне: ${m.checkCode}`);
      break;
    case 'confirmResult':
      if (m.reason === 'cooldown') {
        const sec = Number.isInteger(m.retryAfterSec) ? m.retryAfterSec : 0;
        die(`Недавний запрос этой операции отклонён или истёк — повторите через ${sec} с.`, 1);
      } else if (!m.allow) {
        die(m.reason === 'timeout' ? 'Время подтверждения истекло.' : 'Отклонено на телефоне.', 1);
      } else if (m.action === 'setInternet') {
        console.log('Подтверждено на телефоне.');
        setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
      }
      break;
    case 'error': {
      // отказ моста (нет LAN-адреса для QR, предел сессий и т.п.)
      const text = 'Мост: ' + (typeof m.message === 'string' ? m.message : 'ошибка');
      if (!sid) die(text, 1); else process.stderr.write('\r\n[' + text + ']\r\n');
      break;
    }
    case 'pairinfo': {
      const qrcode = require(path.join(__dirname, 'node_modules', 'qrcode-terminal'));
      console.log('\nСопряжение нового устройства с Claude Bridge');
      console.log(`Адрес моста: ${m.host}:${m.port}`);
      if (m.internet) console.log(`Доступ через интернет: ${fmtInet(m.internet)}`);
      // P-7: сопряжение только по QR — код для ручного ввода не печатаем
      console.log(`Отсканируйте QR в приложении (действует ${m.ttlMin || 10} минут)\n`);
      qrcode.generate(JSON.stringify({ cb: 1, host: m.host, port: m.port, code: m.code, fp: m.fp }),
        { small: true }, (q) => { console.log(q); process.exit(0); });
      break;
    }
  }
});

// ------------------------------- TUI: доверенные устройства + интернет-доступ

let rl = null;
let inetState = null;

function fmtInet(s) {
  if (!s) return 'статус неизвестен';
  if (!s.available) return 'недоступен: не собран bridge\\bin\\claude-tunnel.exe';
  if (!s.enabled) return 'выключен';
  let line = 'ВКЛЮЧЁН' + (s.ticket ? '' : ' (p2p-endpoint запускается…)');
  if (s.peers && s.peers.length) {
    const paths = s.peers.map((p) =>
      (p.path === 'direct' ? 'напрямую' : p.path === 'relay' ? 'через relay' : '…') +
      (p.rttMs != null ? ` ${Math.round(p.rttMs)} мс` : '')).join(', ');
    line += `; интернет-подключений: ${s.peers.length} (${paths})`;
  }
  return line;
}

function deviceTui(m) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\nДоверенные устройства моста:');
  if (!m.devices.length) console.log('  (нет сопряжённых устройств)');
  m.devices.forEach((d, i) => {
    const self = d.id === m.self ? '  [это устройство]' : '';
    console.log(`  ${i + 1}. ${d.name}  ·  добавлено ${new Date(d.addedAt).toLocaleString('ru-RU')}${self}`);
  });
  console.log(`\nДоступ через интернет (p2p iroh): ${fmtInet(inetState)}`);

  rl.question('\nНомер — отозвать устройство, i — вкл/выкл интернет, Enter — выход: ', (ans) => {
    ans = ans.trim();
    if (/^[iи]$/i.test(ans)) {
      const enable = !(inetState && inetState.enabled);
      rl.close(); // подтверждение (консоль или телефон) не должно делить stdin с меню
      rl = null;
      // выключение — без подтверждения; включение — телефон (D-13) или консоль (confirmRequired, P-9);
      // мост разошлёт свежий internet-статус, меню перезапрашиваем
      sendSensitive({ type: 'setInternet', enabled: enable });
      if (!enable) setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
      return;
    }
    const n = parseInt(ans, 10);
    const dev = m.devices[n - 1];
    if (!dev) { console.log('Выход.'); process.exit(0); }
    rl.question(`Отозвать «${dev.name}»? Устройство сразу потеряет доступ [y/N]: `, (yn) => {
      if (/^[yд]/i.test(yn.trim())) {
        send({ type: 'revokeDevice', id: dev.id });
        console.log('Отозвано.');
        // сервер пришлёт обновлённый список — TUI покажет его снова
      } else {
        console.log('Отменено.');
        process.exit(1); // m-3: отказ — код 1
      }
    });
  });
}
