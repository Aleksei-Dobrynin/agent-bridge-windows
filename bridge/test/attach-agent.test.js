'use strict';
// Задача 16: claude-mobile — --agent <id> (D-5), конфликт resume решает мост (D-7, без
// клиентского дубля), подтверждения D-13 (телефон / консоль), QR без ручного кода (P-7).
// Интерактивная консоль — настоящий ConPTY (node-pty): --qr требует TTY (D-18 п. 2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pty = require('../node_modules/node-pty');
const H = require('./helpers/bridge');

test.after(() => setTimeout(() => process.exit(0), 300).unref()); // node-pty держит цикл событий

const { FAKE_AGENT, DEVICE, TEST_LAN_HOST, stripAnsi, createAndAttach } = H;
const ATTACH = path.join(__dirname, '..', 'attach.js');
const AGENTS = {
  defaultAgent: 'echo',
  agents: {
    echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [FAKE_AGENT] },
    claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] },
  },
};

let b; // мост с сопряжённым телефоном
test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-cm-', devices: [DEVICE], config: { host: TEST_LAN_HOST, ...AGENTS },
    env: { CLAUDE_BRIDGE_TEST_COOLDOWN_MS: '1500' } }); // пауза после отказа (D-22.3) — короткая
});
test.after(() => b && b.stop());

/** claude-mobile без консоли (stdin — закрытый pipe). */
function run(bridge, args) {
  const p = spawn(process.execPath, [ATTACH, ...args], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: bridge.home }, cwd: bridge.cwd, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  p.stdin.end();
  let out = '';
  let err = '';
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise((r) => p.on('exit', (code) => r(code)));
  const t = setTimeout(() => H.killTree(p.pid), 30000);
  done.then(() => clearTimeout(t));
  return { p, done, out: () => stripAnsi(out), err: () => err };
}

/** claude-mobile в интерактивной консоли (ConPTY): write() — ввод человека. */
function runTty(bridge, args) {
  const env = { ...process.env, CLAUDE_BRIDGE_HOME: bridge.home };
  const term = pty.spawn(process.execPath, [ATTACH, ...args], { name: 'xterm', cols: 200, rows: 50, cwd: bridge.cwd, env });
  let out = '';
  term.onData((d) => { out += d; });
  const done = new Promise((r) => term.onExit(({ exitCode }) => r(exitCode)));
  const t = setTimeout(() => { try { term.kill(); } catch { /* вышел */ } }, 40000);
  done.then(() => clearTimeout(t));
  return { term, done, out: () => stripAnsi(out), write: (s) => term.write(s) };
}

const until = async (fn, ms, what) => assert.ok(await H.waitFor(fn, ms), 'не дождались: ' + what);

test('--agent starts that agent with raw args; -l shows the agent', { timeout: 60000 }, async () => {
  const a = run(b, ['--agent', 'echo', '--x']);
  await until(() => /ARGV:\["--x"\]/.test(a.out()), 20000, 'ARGV в выводе: ' + a.out() + a.err());
  assert.match(a.out(), /Запускаю: echo --x/);
  H.killTree(a.p.pid);
  const l = run(b, ['-l']);
  assert.strictEqual(await l.done, 0, l.err());
  assert.match(l.out(), /\tжива\tEcho\t/);
});

test('--agent without id fails; unknown agent -> bridge error', { timeout: 60000 }, async () => {
  for (const args of [['--agent'], ['--agent', '--resume']]) {
    const a = run(b, args);
    assert.strictEqual(await a.done, 1, args.join(' '));
    assert.match(a.err(), /id агента/);
  }
  const u = run(b, ['--agent', 'nope']);
  assert.strictEqual(await u.done, 1);
  assert.match(u.err(), /неизвестный агент/);
});

test('resume next to a live session: the bridge decides (createConflict), no client-side prompt (D-7)', { timeout: 90000 }, async () => {
  const o = await b.connect(b.owner);
  const live = await createAndAttach(o, { agent: 'claude', cwd: b.cwd });
  assert.strictEqual(live.type, 'created');
  // без консоли — отказ после предупреждения моста
  const a = run(b, ['--agent', 'claude', '--resume']);
  assert.strictEqual(await a.done, 1);
  assert.match(a.out(), /уже есть живые сессии этого агента/);
  assert.match(a.out(), new RegExp(live.id));
  assert.match(a.err(), /нет интерактивной консоли/);
  // в консоли — вопрос; «y» -> create с force, сессия с --resume
  const t = runTty(b, ['--agent', 'claude', '--resume']);
  await until(() => /продолжить с resume\? \[y\/N\]/.test(t.out()), 20000, 'вопрос о resume: ' + t.out());
  t.write('y\r');
  await until(() => /ARGV:\["--resume"\]/.test(t.out()), 20000, 'сессия с --resume: ' + t.out());
  // клиент больше не нужен (сессия живёт в keeper'е; её погасит stop() стенда)
  H.killTree(t.term.pid);
  await t.done;
});

test('--qr with a paired phone waits for the phone (D-13); QR has no manual code line (P-7)', { timeout: 60000 }, async () => {
  const d = await b.connect(DEVICE.token);
  let atD = d.mark();
  // отказ на телефоне
  const no = runTty(b, ['--qr']);
  let req = await d.wait((m) => m.type === 'confirmRequest', 15000, atD);
  await until(() => /сопряжённом телефоне/.test(no.out()), 10000, 'подсказка про телефон: ' + no.out());
  await until(() => no.out().includes('Сверьте код на телефоне: ' + req.checkCode), 10000, 'контрольный код (D-22.3)');
  assert.doesNotMatch(no.out(), /\[y\/N\]/, 'no console question when a phone is paired');
  d.send({ type: 'confirm', confirmId: req.confirmId, allow: false });
  assert.strictEqual(await no.done, 1);
  assert.match(no.out(), /Отклонено на телефоне/);
  // сразу повтор — пауза после отказа (D-22.3), телефон не беспокоим
  const cd = runTty(b, ['--qr']);
  assert.strictEqual(await cd.done, 1);
  assert.match(cd.out(), /повторите через \d+ с/);
  await H.sleep(1600);
  // разрешение на телефоне
  atD = d.mark();
  const a = runTty(b, ['--qr']);
  req = await d.wait((m) => m.type === 'confirmRequest', 15000, atD);
  d.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
  assert.strictEqual(await a.done, 0, a.out());
  assert.match(a.out(), /Сопряжение нового устройства/);
  assert.match(a.out(), new RegExp('Адрес моста: ' + TEST_LAN_HOST.replace(/\./g, '\\.')));
  assert.doesNotMatch(a.out(), /ручного ввода/);
});

test('--qr without paired devices: console confirmation (P-9), then QR', { timeout: 90000 }, async () => {
  const nb = await H.startTestBridge({ prefix: 'cb-cm0-', config: { host: TEST_LAN_HOST, ...AGENTS } });
  try {
    const a = runTty(nb, ['--qr']);
    await until(() => /Выпустить код сопряжения нового устройства\? \[y\/N\]/.test(a.out()), 20000, 'вопрос: ' + a.out());
    a.write('y\r');
    assert.strictEqual(await a.done, 0, a.out());
    assert.match(a.out(), /Сопряжение нового устройства/);
    assert.doesNotMatch(a.out(), /ручного ввода/);
  } finally { await nb.stop(); }
});

test('--qr сохраняет PNG для ПК-клиента (D-29)', { timeout: 90000 }, async () => {
  const nb = await H.startTestBridge({ prefix: 'cb-cm-png-', config: { host: TEST_LAN_HOST, ...AGENTS } });
  try {
    const out = path.join(nb.home, 'pairing-qr.png');
    const a = runTty(nb, ['--qr', '--qr-out', out]);
    await until(() => /Выпустить код сопряжения нового устройства\? \[y\/N\]/.test(a.out()), 20000, 'вопрос: ' + a.out());
    a.write('y\r');
    assert.strictEqual(await a.done, 0, a.out());
    assert.ok(fs.existsSync(out), 'PNG создан: ' + a.out());
    const t = JSON.parse(require('../lib/qr-image').readQrPng(out));
    assert.strictEqual(t.cb, 1);
    assert.strictEqual(t.host, TEST_LAN_HOST);
    assert.match(t.fp, /^[0-9a-f]{64}$/);
    assert.match(a.out(), /QR сохранён в файл/);
  } finally { await nb.stop(); }
});

test('--device: enabling internet waits for the phone (D-13); denial ends the menu', { timeout: 60000 }, async () => {
  const d = await b.connect(DEVICE.token);
  const atD = d.mark();
  const a = runTty(b, ['--device']);
  await until(() => /i — вкл\/выкл интернет/.test(a.out()), 20000, 'меню устройств');
  assert.match(a.out(), /Test phone/);
  a.write('i\r');
  const req = await d.wait((m) => m.type === 'confirmRequest' && m.action === 'setInternet', 15000, atD);
  await until(() => /сопряжённом телефоне/.test(a.out()), 10000, 'подсказка про телефон');
  d.send({ type: 'confirm', confirmId: req.confirmId, allow: false });
  assert.strictEqual(await a.done, 1);
  assert.match(a.out(), /Отклонено на телефоне/);
});

test('C-1 / D-22.2: after the last phone is revoked --qr refuses instead of asking the console', { timeout: 90000 }, async () => {
  const nb = await H.startTestBridge({ prefix: 'cb-cm1-', devices: [DEVICE], config: { host: TEST_LAN_HOST, ...AGENTS } });
  try {
    const o = await nb.connect(nb.owner);
    o.send({ type: 'revokeDevice', id: DEVICE.id });
    await o.wait((m) => m.type === 'devices' && m.devices.length === 0, 5000);
    const a = runTty(nb, ['--qr']);
    assert.strictEqual(await a.done, 1);
    assert.match(a.out(), /нужен сопряжённый телефон/);
    assert.doesNotMatch(a.out(), /\[y\/N\]/);
  } finally { await nb.stop(); }
});

test('m-2: own claude-mobile flags after --agent are refused, not reinterpreted', { timeout: 60000 }, async () => {
  for (const flag of ['-l', '--list', '-a', '--attach', '--qr', '--device', '--devices', '--open', '--rotate-token', '-h', '--help']) {
    const a = run(b, ['--agent', 'echo', flag]);
    assert.strictEqual(await a.done, 1, flag);
    assert.match(a.err(), /--agent нельзя сочетать/, flag);
    assert.doesNotMatch(a.out(), /Запускаю|Сессий нет|жива/, flag);
  }
});

test('m-3: a refusal or cancel in the console exits with code 1', { timeout: 90000 }, async () => {
  const nb = await H.startTestBridge({ prefix: 'cb-cm2-', config: { host: TEST_LAN_HOST, ...AGENTS } });
  try {
    const a = runTty(nb, ['--qr']);
    await until(() => /\[y\/N\]/.test(a.out()), 20000, 'вопрос консоли');
    a.write('n\r');
    assert.strictEqual(await a.done, 1);
    assert.match(a.out(), /Отменено/);
    // отказ продолжить resume рядом с живой сессией
    const o = await nb.connect(nb.owner);
    assert.strictEqual((await createAndAttach(o, { agent: 'claude', cwd: nb.cwd })).type, 'created');
    const r = runTty(nb, ['--agent', 'claude', '--resume']);
    await until(() => /продолжить с resume\? \[y\/N\]/.test(r.out()), 20000, 'вопрос о resume');
    r.write('n\r');
    assert.strictEqual(await r.done, 1);
    assert.match(r.out(), /Отменено/);
  } finally { await nb.stop(); }
});

test('D-23.2: Ctrl+\\ detaches after the agent enabled win32-input-mode; the key is not forwarded', { timeout: 90000 }, async () => {
  const o = await b.connect(b.owner);
  const before = new Set();
  const list = await o.wait((m) => m.type === 'sessions');
  for (const s of list.sessions) before.add(s.id);
  const a = runTty(b, ['--agent', 'echo', '--w32-input']);
  let exitCode = null;
  a.done.then((c) => { exitCode = c; });
  await until(() => /ARGV:\["--w32-input"\]/.test(a.out()), 20000, 'агент запущен: ' + a.out());
  const msg = await o.wait((m) => m.type === 'sessions' && m.sessions.some((s) => !before.has(s.id)), 10000);
  const sid = msg.sessions.find((s) => !before.has(s.id)).id;
  // ConPTY консоли claude-mobile теперь кодирует клавиши в win32-input-mode: 0x1c приходит как
  // \x1b[17;29;0;1;8;1_\x1b[220;43;28;1;8;1_… (задача 17)
  a.write('\x1c');
  await until(() => exitCode !== null, 10000, 'claude-mobile не отсоединился: ' + JSON.stringify(a.out().slice(-200)));
  assert.strictEqual(exitCode, 0);
  assert.match(a.out(), /отсоединился/);
  // сессия жива, нажатие в неё не ушло
  o.send({ type: 'attach', id: sid, cols: 120, rows: 30 });
  await o.waitOutput(sid, /ARGV:\["--w32-input"\]/);
  // агент включил win32-input-mode — и «Z» он получает в этой кодировке (символ 90)
  o.send({ type: 'input', id: sid, data: 'Z' });
  await o.waitOutput(sid, /ECHO:".*;90;1;/);
  const echoes = o.output(sid).match(/ECHO:.*/g);
  assert.strictEqual(echoes.length, 1, 'Ctrl+\\ packet was forwarded: ' + JSON.stringify(echoes));
  assert.doesNotMatch(echoes[0], /;28;|\\u001c/);
  o.send({ type: 'kill', id: sid });
});
