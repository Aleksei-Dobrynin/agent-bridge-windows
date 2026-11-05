'use strict';
// D-29: ноутбук — сопряжённое устройство. --pair принимает QR из PNG, --remote ходит
// через «туннель» (в тестах — TCP-прокси), не имея owner.token и локального сертификата.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge');
const { writeQrPng, readQrPng } = require('../lib/qr-image');

const FAKE = path.join(__dirname, 'fixtures', 'fake-tunnel.js');
const NODE_ID = 'c'.repeat(64);
const AGENTS = {
  defaultAgent: 'echo',
  agents: { echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [H.FAKE_AGENT] } },
};

let b;
test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-rem-', config: { host: H.TEST_LAN_HOST, ...AGENTS } });
});
test.after(() => b && b.stop());

/** Сопрячь «ноутбук» один раз на файл: успешное сопряжение ставит phoneRequired, повторный
 *  pairinfo потребовал бы подтверждения на телефоне. Возвращает {lap, png, out}. */
let LAP = null;
async function pairLaptop() {
  if (LAP) return LAP;
  const o = await b.connect(b.owner);
  const at = o.mark();
  o.send({ type: 'pairinfo', confirmed: true });
  const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
  const lap = H.tempHome('cb-lap-');
  const png = path.join(lap, 'qr.png');
  await writeQrPng(JSON.stringify({ cb: 1, host: p.host, port: p.port, code: p.code, fp: p.fp }), png);
  const r = H.runAttach(lap, ['--pair', png], { CLAUDE_BRIDGE_TUNNEL: FAKE, CB_FAKE_NODE_ID: NODE_ID });
  assert.strictEqual(await r.done, 0, r.out() + r.err());
  LAP = { lap, png, out: r.out() };
  return LAP;
}
test.after(() => { if (LAP) fs.rmSync(LAP.lap, { recursive: true, force: true }); });

test('--pair: профиль, токен, сертификат, NodeId в allowlist', { timeout: 90000 }, async () => {
  const { lap, png, out } = await pairLaptop();
  assert.match(out, /Сопряжено с мостом/);
  const prof = JSON.parse(fs.readFileSync(path.join(lap, 'remote', 'profile.json'), 'utf8'));
  assert.strictEqual(prof.host, H.TEST_LAN_HOST);
  assert.strictEqual(prof.fingerprint, JSON.parse(readQrPng(png)).fp);
  assert.match(fs.readFileSync(path.join(lap, 'remote', 'device.token'), 'utf8').trim(), /^[0-9a-f]{48}$/);
  assert.ok(fs.existsSync(path.join(lap, 'remote', 'bridge.cer')));
  const allow = fs.readFileSync(path.join(b.home, 'certs', 'tunnel-allow.txt'), 'utf8');
  assert.ok(allow.includes(NODE_ID), 'NodeId ноутбука в allowlist');
  // owner.token на ноутбуке не появлялся
  assert.ok(!fs.existsSync(path.join(lap, 'owner.token')));
});

test('--pair без аргумента — понятная ошибка', async () => {
  const lap = H.tempHome('cb-lap-');
  try {
    const r = H.runAttach(lap, ['--pair']);
    assert.strictEqual(await r.done, 1);
    assert.match(r.err(), /--pair <qr\.png>/);
  } finally { fs.rmSync(lap, { recursive: true, force: true }); }
});

/** Подменить ticket на фиктивный: настоящий iroh в тестах не поднимаем.
 *  Заодно обнуляем прямой адрес моста (D-30): host/port в профиле указывают на мёртвый адрес,
 *  поэтому клиент обязан идти через туннель, а прямой LAN-путь недоступен. */
function fakeTicket(lap) {
  const f = path.join(lap, 'remote', 'profile.json');
  const prof = JSON.parse(fs.readFileSync(f, 'utf8'));
  prof.ticket = 'fake-ticket';
  prof.host = '127.0.0.1';
  prof.port = 1;
  fs.writeFileSync(f, JSON.stringify(prof, null, 2));
}

test('--remote -l: список сессий рабочего ПК через туннель', { timeout: 90000 }, async () => {
  const { lap } = await pairLaptop();
  const proxy = await H.tcpProxy(b.port);
  try {
    fakeTicket(lap);
    const o = await b.connect(b.owner);
    const created = await H.createAndAttach(o, { cwd: b.cwd, agent: 'echo' });
    assert.strictEqual(created.type, 'created', JSON.stringify(created));

    const r = H.runAttach(lap, ['--remote', '-l'], {
      CLAUDE_BRIDGE_TUNNEL: FAKE, CB_FAKE_TUNNEL_PORT: String(proxy.port),
    });
    assert.strictEqual(await r.done, 0, r.out() + r.err());
    assert.ok(r.out().includes(created.id), 'в списке есть сессия: ' + r.out());
    assert.match(r.out(), /жива/);
    // lap общий на файл (pairLaptop мемоизирован) — каталог удаляет test.after, не этот тест
  } finally { await proxy.close(); }
});

test('--remote -a: ввод и вывод сессии через туннель', { timeout: 90000 }, async () => {
  const { lap } = await pairLaptop();
  const proxy = await H.tcpProxy(b.port);
  try {
    fakeTicket(lap);
    const o = await b.connect(b.owner);
    const created = await H.createAndAttach(o, { cwd: b.cwd, agent: 'echo' });
    assert.strictEqual(created.type, 'created');
    const r = H.runAttachTty(lap, ['--remote', '-a', created.id], {
      CLAUDE_BRIDGE_TUNNEL: FAKE, CB_FAKE_TUNNEL_PORT: String(proxy.port),
    });
    try {
      assert.ok(await H.waitFor(async () => /ARGV:/.test(r.out()), 20000), 'сессия прислала ARGV: ' + r.out());
      r.write('hi\r');
      // ConPTY может разбить чанк — ждём начало эха, а не строку целиком
      assert.ok(await H.waitFor(async () => /ECHO:"hi/.test(r.out()), 10000), 'эхо ввода: ' + r.out());
    } finally {
      // pty закрываем при любом исходе: иначе упавший ассерт подвесит node --test
      try { r.term.kill(); } catch { /* уже вышел */ }
      await r.done;
    }
    // lap общий на файл — каталог удаляет test.after
  } finally { await proxy.close(); }
});

test('--remote без профиля — понятная ошибка', async () => {
  const lap = H.tempHome('cb-lap-');
  try {
    const r = H.runAttach(lap, ['--remote', '-l']);
    assert.strictEqual(await r.done, 1);
    assert.match(r.err(), /Нет профиля сопряжения/);
  } finally { fs.rmSync(lap, { recursive: true, force: true }); }
});

test('--remote: создание сессии удалённо запрещено', async () => {
  const { lap } = await pairLaptop();
  const r = H.runAttach(lap, ['--remote', '--agent', 'echo']);
  assert.strictEqual(await r.done, 1);
  assert.match(r.err(), /только -l и -a/);
  // lap общий на файл — каталог удаляет test.after (иначе сломает любой следующий тест)
});

/** Вернуть профиль на реальный адрес тестового моста (после fakeTicket). */
function realHost(lap) {
  const file = path.join(lap, 'remote', 'profile.json');
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.host = H.TEST_LAN_HOST;
  p.port = b.port;
  p.lastVia = 'lan'; // проверяем именно приоритет LAN
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
}

test('--remote -l: в LAN идёт напрямую, туннель не запускается (D-30)', { timeout: 60000 }, async () => {
  const { lap } = await pairLaptop();
  realHost(lap);
  const mark = path.join(lap, 'tunnel-was-started');
  // фикстура пишет маркер при старте: если клиент полезет в туннель — маркер появится
  const r = H.runAttach(lap, ['--remote', '-l'], {
    CLAUDE_BRIDGE_TUNNEL: FAKE, CB_FAKE_TUNNEL_MODE: 'error', CB_FAKE_TUNNEL_MARK: mark,
  });
  assert.strictEqual(await r.done, 0, r.out() + r.err());
  assert.match(r.out(), /жива/);
  assert.ok(!fs.existsSync(mark), 'туннель не запускался: путь LAN приоритетен');
});

test('--remote без ticket — отказ, а не бесконечный ретрай (D-30)', { timeout: 60000 }, async () => {
  const { lap } = await pairLaptop();
  const dir = H.tempHome('cb-lap-noticket-');
  try {
    fs.cpSync(path.join(lap, 'remote'), path.join(dir, 'remote'), { recursive: true });
    const file = path.join(dir, 'remote', 'profile.json');
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    p.host = '127.0.0.1'; p.port = 1; p.ticket = null; p.lastVia = 'lan';
    fs.writeFileSync(file, JSON.stringify(p, null, 2));
    const r = H.runAttach(dir, ['--remote', '-a'], { CLAUDE_BRIDGE_TUNNEL: FAKE, CB_FAKE_TUNNEL_MODE: 'error' });
    assert.strictEqual(await r.done, 1, r.out() + r.err());
    assert.match(r.err(), /ticket/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
