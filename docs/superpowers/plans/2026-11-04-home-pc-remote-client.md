# Домашний ПК — клиент рабочего моста через туннель (D-29) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ноутбук (домашний ПК) разово сопрягается с мостом рабочего ПК в офисной LAN и дальше подключается к той же сессии через p2p-туннель iroh — командами `claude-mobile --pair <qr.png>` и `claude-mobile --remote [-l|-a [id]]`.

**Architecture:** ноутбук — обычное сопряжённое устройство моста (D-8/D-9 не меняются): токен устройства, свой NodeId в allowlist туннеля. Сопряжение — QR, сохранённый рабочим ПК в PNG; ноутбук декодирует PNG, **сверяет SHA-256 сертификата моста с `fp` из QR до отправки кода** и только потом делает `POST /pair` по LAN. Работа — `claude-tunnel connect` (локальный TCP-порт из события `ready`), поверх него тот же TLS моста с пиннингом (`pinnedTlsOptions`) и TUI как у локального `claude-mobile`. Мост меняется только добавлением подтверждения `nodeRegistered` на `registerNode`.

**Tech Stack:** Node.js ≥ 20 (CommonJS), `ws`, `https`/`tls`, `node:test`; новые зависимости `qrcode` (PNG), `jsqr` (декодер), `pngjs` (пиксели PNG; приходит транзитивно с `qrcode`).

**Вне объёма (не делать в этом плане):** web-UI с домашнего ПК (нужен новый `Origin` в `originAllowed`), создание сессий с ноутбука (P-3: сырые `args` — только владельцу), приглашение с телефона и `/pair` через туннель (развилка B), изменение `Cargo.toml`/`Cargo.lock` туннеля, пересборка APK.

**Обязательные правила проекта:** `Specs/` — первым (L0→L3); арх-решения — только с «да» оператора; реальную систему пользователя не трогать; коммиты — только релевантные пути, push — только по просьбе; секреты не коммитить. Гейт: `cd bridge; npm test` → `fail 0`.

**Статус: ✅ реализовано 2026-11-05** (задачи 1–8, коммиты `fbe5b9c`…`e227ac7`; гейт 354 теста, 353 pass / 0 fail / 1 skip, `check-specs` PASS). Осталось — «Проверка на реальных ПК» ниже (за оператором). Долги: P1 — ticket не обновляется при рестарте туннеля; P2 — сбой `registerNode` после `/pair` без отката; у `install.ps1` нет режима `-Client`.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `bridge/lib/qr-image.js` (new) | QR → PNG и PNG → строка (qrcode/pngjs/jsqr) |
| `bridge/lib/pair-client.js` (new) | разбор тикета, получение сертификата, сверка `fp`, `POST /pair`, профиль на диске, `registerNode` |
| `bridge/lib/remote-tunnel.js` (new) | запуск `claude-tunnel connect`, разбор `ready{port}`, `id` → NodeId, остановка |
| `bridge/remote.js` (new) | CLI-режимы `--pair` и `--remote` (+ TUI подключения) |
| `bridge/attach.js` (modify) | ранний диспатч `--pair`/`--remote`; `--qr` пишет PNG |
| `bridge/server.js` (modify) | ответ `nodeRegistered` на `registerNode` |
| `bridge/package.json` (modify) | зависимости QR |
| `bridge/test/fixtures/fake-tunnel.js` (new) | фикстурный туннель для тестов |
| `bridge/test/helpers/bridge.js` (modify) | `runAttach`, `runAttachTty`, `tcpProxy` |
| `bridge/test/qr-image.test.js`, `pair-client.test.js`, `remote-tunnel.test.js`, `attach-remote.test.js` (new) | тесты |
| `bridge/test/attach-agent.test.js` (modify) | проверка PNG у `--qr` |
| `bridge/test/server-pairing.test.js` (modify) | `nodeRegistered` |
| `Specs/shared/PROTOCOL.md`, `Specs/bridge/modules/AUTH_PAIRING.md`, `Specs/tunnel/TUNNEL.md` (modify) | нормы |
| `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md` (modify) | строка статуса |

Файлы профиля на ноутбуке (в каталоге данных, ACL профиля — D-8):

```
<данные>\remote\profile.json   {host, port, fingerprint, ticket, name, pairedAt}
<данные>\remote\bridge.cer     DER сертификата моста (пиннинг)
<данные>\remote\device.token   токен устройства (48 hex)
<данные>\remote\iroh.key       постоянный ключ p2p-личности ноутбука
```

---

### Task 1: QR ↔ PNG

**Files:**
- Modify: `bridge/package.json`
- Create: `bridge/lib/qr-image.js`
- Test: `bridge/test/qr-image.test.js`

- [x] **Step 1: Добавить зависимости**

В `bridge/package.json` в `"dependencies"` (алфавитный порядок сохранить):

```json
    "jsqr": "^1.4.0",
    "pngjs": "^7.0.0",
    "qrcode": "^1.5.4",
```

- [x] **Step 2: Установить и зафиксировать lock-файл**

Run: `cd bridge; npm install --save-exact=false jsqr@^1.4.0 pngjs@^7.0.0 qrcode@^1.5.4`
Expected: `added N packages`, обновлены `package.json` и `package-lock.json`, `found 0 vulnerabilities`.

- [x] **Step 3: Написать падающий тест**

Создать `bridge/test/qr-image.test.js`:

```js
'use strict';
// D-29: QR сопряжения переносится на ноутбук файлом PNG — проверяем обратимость.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeQrPng, readQrPng } = require('../lib/qr-image');

const TICKET = JSON.stringify({ cb: 1, host: '127.0.0.2', port: 8790, code: '0123456789ABCDEF'.slice(0, 10), fp: 'ab'.repeat(32) });

test('QR PNG roundtrip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qr-'));
  const file = path.join(dir, 'qr.png');
  try {
    await writeQrPng(TICKET, file);
    assert.ok(fs.statSync(file).size > 100, 'PNG создан');
    assert.strictEqual(readQrPng(file), TICKET);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('нет файла — понятная ошибка', () => {
  assert.throws(() => readQrPng(path.join(os.tmpdir(), 'cb-no-such-qr.png')), /ENOENT/);
});

test('не PNG — отказ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qr-'));
  const file = path.join(dir, 'bad.png');
  try {
    fs.writeFileSync(file, 'not a png');
    assert.throws(() => readQrPng(file), /QR не распознан|не PNG|unexpected end/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [x] **Step 4: Запустить тест — должен упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/qr-image.test.js`
Expected: FAIL `Cannot find module '../lib/qr-image'`.

- [x] **Step 5: Реализовать `bridge/lib/qr-image.js`**

```js
'use strict';
// D-29: QR сопряжения ПК-клиента. Запись — qrcode (PNG), чтение — pngjs (пиксели) + jsqr (матрица).
const fs = require('fs');
const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

/** Записать текст в PNG с QR. Возвращает путь. */
async function writeQrPng(text, file) {
  if (typeof text !== 'string' || !text) throw new Error('нет данных для QR');
  await QRCode.toFile(file, text, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
  return file;
}

/** Прочитать строку из PNG с QR. Бросает, если QR не найден. */
function readQrPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const found = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!found || typeof found.data !== 'string' || !found.data) throw new Error('QR не распознан');
  return found.data;
}

module.exports = { writeQrPng, readQrPng };
```

- [x] **Step 6: Тест должен пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/qr-image.test.js`
Expected: `pass 3`, `fail 0`.

- [x] **Step 7: Коммит**

```bash
git add bridge/package.json bridge/package-lock.json bridge/lib/qr-image.js bridge/test/qr-image.test.js
git commit -m "feat(bridge): QR PNG для сопряжения ПК-клиента (D-29)"
```

---

### Task 2: сопряжение ПК-клиента (профиль на диске)

**Files:**
- Create: `bridge/lib/pair-client.js`
- Test: `bridge/test/pair-client.test.js`

- [x] **Step 1: Написать падающий тест**

Создать `bridge/test/pair-client.test.js`:

```js
'use strict';
// D-29: ноутбук сопрягается как устройство — сверка отпечатка до отправки кода,
// на диске только хэш токена на стороне моста, профиль и токен — на стороне клиента.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./helpers/bridge');
const { pairDevice, loadProfile } = require('../lib/pair-client');

let b;
test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-pc-', config: { host: H.TEST_LAN_HOST } });
});
test.after(() => b && b.stop());

let owner = null;
/** Свежий код сопряжения (одноразовый). Один owner-WS на весь файл. */
async function ticket() {
  if (!owner) owner = await b.connect(b.owner);
  const at = owner.mark();
  owner.send({ type: 'pairinfo', confirmed: true });
  const p = await owner.wait((m) => m.type === 'pairinfo', 5000, at);
  return JSON.stringify({ cb: 1, host: p.host, port: p.port, code: p.code, fp: p.fp });
}

// ВАЖНО: успешное сопряжение ставит phoneRequired — после него pairinfo требует телефон.
// Поэтому все проверки отказов идут ДО успешного сопряжения.
test('мусор в QR — понятная ошибка', async () => {
  await assert.rejects(pairDevice({ ticket: '{"cb":1}', name: 'x', root: H.tempHome('cb-lap-') }), /QR/);
  await assert.rejects(pairDevice({ ticket: 'not json', name: 'x', root: H.tempHome('cb-lap-') }), /JSON/);
});

test('неверный отпечаток в QR — отказ до /pair, ничего не сохранено', async () => {
  const root = H.tempHome('cb-lap-');
  try {
    const t = JSON.parse(await ticket());
    t.fp = 'cd'.repeat(32);
    await assert.rejects(pairDevice({ ticket: JSON.stringify(t), name: 'x', root }), /отпечаток/i);
    assert.ok(!fs.existsSync(path.join(root, 'remote', 'device.token')));
    assert.ok(!fs.existsSync(path.join(root, 'remote', 'profile.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('просроченный/неверный код — ошибка моста без профиля', async () => {
  const root = H.tempHome('cb-lap-');
  try {
    const t = JSON.parse(await ticket());
    t.code = '0000000000';
    await assert.rejects(pairDevice({ ticket: JSON.stringify(t), name: 'x', root }), /код сопряжения/i);
    assert.ok(!fs.existsSync(path.join(root, 'remote', 'profile.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pairDevice: профиль, сертификат и токен на диске', async () => {
  const root = H.tempHome('cb-lap-');
  try {
    const t = await ticket();
    const r = await pairDevice({ ticket: t, name: 'home laptop', root });
    assert.strictEqual(r.host, H.TEST_LAN_HOST);
    assert.match(r.token, /^[0-9a-f]{48}$/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'remote', 'device.token'), 'utf8').trim(), r.token);
    const der = fs.readFileSync(path.join(root, 'remote', 'bridge.cer'));
    assert.strictEqual(crypto.createHash('sha256').update(der).digest('hex'), r.fingerprint);
    const prof = loadProfile(root);
    assert.strictEqual(prof.fingerprint, r.fingerprint);
    assert.strictEqual(prof.host, H.TEST_LAN_HOST);
    assert.strictEqual(prof.port, b.port);
    // на стороне моста — только хэш
    const raw = fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8');
    assert.ok(!raw.includes(r.token));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
```

- [x] **Step 2: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/pair-client.test.js`
Expected: FAIL `Cannot find module '../lib/pair-client'`.

- [x] **Step 3: Реализовать `bridge/lib/pair-client.js`**

```js
'use strict';
// D-29: сопряжение ПК-клиента (домашний ноутбук). Отпечаток сертификата берётся из QR
// (человек переносит файл), поэтому TOFU нет: сертификат сверяется ДО отправки кода.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { pinnedTlsOptions } = require('./cert');

const CODE_RE = /^[0-9a-f]{10}$/i;
const FP_RE = /^[0-9a-f]{64}$/;
const HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;

/** Разобрать тикет из QR; любое отклонение — исключение (fail-closed). */
function parseTicket(text) {
  let t;
  try { t = JSON.parse(text); } catch { throw new Error('QR не содержит JSON сопряжения'); }
  if (!t || typeof t !== 'object' || t.cb !== 1) throw new Error('QR не от Claude Bridge');
  if (typeof t.host !== 'string' || !HOST_RE.test(t.host)) throw new Error('неверный адрес в QR');
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65533) throw new Error('неверный порт в QR');
  if (typeof t.code !== 'string' || !CODE_RE.test(t.code)) throw new Error('неверный код в QR');
  if (typeof t.fp !== 'string' || !FP_RE.test(t.fp)) throw new Error('неверный отпечаток в QR');
  return { host: t.host, port: t.port, code: t.code, fp: t.fp.toLowerCase() };
}

/** Сертификат моста с его порта. Проверка цепочки отключена — её заменяет сверка fp из QR. */
function fetchPeerCert(host, port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: '/', method: 'GET', agent: false,
      rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const c = res.socket.getPeerCertificate();
      res.resume();
      if (!c || !c.raw) { reject(new Error('мост не прислал сертификат')); return; }
      resolve(Buffer.from(c.raw));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут TLS (' + host + ':' + port + ')')));
    req.on('error', reject);
    req.end();
  });
}

function postPair(host, port, pin, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, port, path: '/pair', method: 'POST', agent: false, ...pin,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут /pair')));
    req.on('error', reject);
    req.end(data);
  });
}

function remotePaths(root) {
  const dir = path.join(root, 'remote');
  return {
    dir,
    profile: path.join(dir, 'profile.json'),
    cert: path.join(dir, 'bridge.cer'),
    token: path.join(dir, 'device.token'),
    secret: path.join(dir, 'iroh.key'),
  };
}

function saveProfile(root, { der, host, port, fingerprint, ticket, name }) {
  const p = remotePaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.cert, der);
  fs.writeFileSync(p.profile, JSON.stringify({
    host, port, fingerprint, ticket: ticket || null, name, pairedAt: new Date().toISOString(),
  }, null, 2));
  return p;
}

/** Полный цикл сопряжения. Возвращает {token, fingerprint, host, port, ticket, paths}. */
async function pairDevice({ ticket, name, root, timeoutMs }) {
  const t = parseTicket(typeof ticket === 'string' ? ticket : JSON.stringify(ticket));
  const der = await fetchPeerCert(t.host, t.port, timeoutMs);
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  if (fp !== t.fp) throw new Error('отпечаток сертификата не совпал с QR — сопряжение отменено');
  const pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), fp);
  const res = await postPair(t.host, t.port, pin, { code: t.code, name }, timeoutMs);
  if (res.status !== 200) {
    let why = '';
    try { why = JSON.parse(res.body || '{}').error || ''; } catch { /* не JSON */ }
    throw new Error('мост отказал в сопряжении: ' + (why || 'HTTP ' + res.status));
  }
  let r;
  try { r = JSON.parse(res.body); } catch { throw new Error('мост вернул некорректный ответ'); }
  if (!r || typeof r.token !== 'string' || !TOKEN_RE.test(r.token)) {
    throw new Error('мост вернул некорректный токен устройства');
  }
  const paths = saveProfile(root, {
    der, host: t.host, port: t.port, fingerprint: fp, ticket: r.nodeTicket, name,
  });
  fs.writeFileSync(paths.token, r.token, { mode: 0o600 });
  return { token: r.token, fingerprint: fp, host: t.host, port: t.port, ticket: r.nodeTicket || null, paths };
}

/** Профиль с диска или null (нет/повреждён). */
function loadProfile(root) {
  const p = remotePaths(root);
  let prof;
  try { prof = JSON.parse(fs.readFileSync(p.profile, 'utf8')); } catch { return null; }
  if (!prof || typeof prof !== 'object' || typeof prof.fingerprint !== 'string' || !FP_RE.test(prof.fingerprint)) return null;
  return { ...prof, paths: p };
}

/** Сообщить мосту NodeId этого ПК (LAN, токен устройства). Ждёт nodeRegistered. */
function registerNode({ host, port, pin, token, nodeId, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:${port}/ws`, {
      ...pin, headers: { Authorization: 'Bearer ' + token },
    });
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* закрыт */ }
      reject(new Error('мост не подтвердил регистрацию p2p-узла'));
    }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* закрыт */ } fn(v); };
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'nodeRegistered') {
        if (m.ok === true) done(resolve, m.nodeId);
        else done(reject, new Error('мост не принял NodeId устройства'));
      }
    });
    ws.on('error', (e) => done(reject, e));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'registerNode', nodeId })));
  });
}

module.exports = { parseTicket, pairDevice, loadProfile, registerNode, remotePaths };
```

- [x] **Step 4: Тест должен пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/pair-client.test.js`
Expected: `pass 4`, `fail 0` (тест `registerNode` появится в Task 3 и будет падать до неё — поэтому здесь его нет).

- [x] **Step 5: Коммит**

```bash
git add bridge/lib/pair-client.js bridge/test/pair-client.test.js
git commit -m "feat(bridge): сопряжение ПК-клиента по QR с пиннингом (D-29)"
```

---

### Task 3: подтверждение `registerNode` на мосте

**Files:**
- Modify: `bridge/server.js:1497-1511`
- Modify: `bridge/test/server-pairing.test.js`
- Modify: `Specs/shared/PROTOCOL.md:109,117-133`

- [x] **Step 1: Написать падающий тест**

Добавить в конец `bridge/test/server-pairing.test.js`:

```js
test('registerNode: устройство получает подтверждение, NodeId в allowlist (D-29)', { timeout: 60000 }, async () => {
  const d = await b.connect(token);
  await d.wait((m) => m.type === 'sessions');
  const at = d.mark();
  const nodeId = 'a'.repeat(64);
  d.send({ type: 'registerNode', nodeId });
  const ack = await d.wait((m) => m.type === 'nodeRegistered', 5000, at);
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.nodeId, nodeId);
  const raw = JSON.parse(fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8'));
  assert.strictEqual(raw.devices[0].nodeId, nodeId);
  const allow = fs.readFileSync(path.join(b.home, 'certs', 'tunnel-allow.txt'), 'utf8');
  assert.ok(allow.includes(nodeId), 'NodeId попал в allowlist туннеля');
});
```

- [x] **Step 2: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/server-pairing.test.js`
Expected: FAIL — `не дождались сообщения` (мост не отвечает `nodeRegistered`).

- [x] **Step 3: Добавить подтверждение**

В `bridge/server.js`, case `registerNode` — после блока записи (после `}` закрытия `if (dev && dev.nodeId !== nid)`):

```js
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
```

- [x] **Step 4: Тест должен пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/server-pairing.test.js`
Expected: `pass 4`, `fail 0`.

- [x] **Step 5: Обновить протокол**

В `Specs/shared/PROTOCOL.md`:
- строка `registerNode` (таблица 1.4) → `| registerNode | nodeId (64 hex) — в allowlist туннеля; ответ — nodeRegistered | устройство (телефон, ПК-клиент D-29) | bridge/server.js:1497 |`
- в таблицу 1.5 после строки `error` добавить:
  `| nodeRegistered | nodeId, ok — ответ на registerNode (D-29) | bridge/server.js:1509 |`

- [x] **Step 6: Линтер спеков и коммит**

Run: `node tools/check-specs.mjs`
Expected: без ошибок.

```bash
git add bridge/server.js bridge/test/server-pairing.test.js
git commit -m "feat(bridge): подтверждение registerNode для ПК-клиента (D-29)"
```

> `Specs/` — локальный, машинно-специфичный каталог (в `.gitignore`, см. AGENTS.md): правка `Specs/shared/PROTOCOL.md` остаётся в рабочей копии, в коммит не входит.

---

### Task 4: запуск туннеля `connect` из клиента

**Files:**
- Create: `bridge/lib/remote-tunnel.js`
- Create: `bridge/test/fixtures/fake-tunnel.js`
- Test: `bridge/test/remote-tunnel.test.js`

- [x] **Step 1: Написать фикстуру**

Создать `bridge/test/fixtures/fake-tunnel.js`:

```js
'use strict';
// Фикстурный claude-tunnel: `id` печатает node_id и выходит; `connect` печатает ready{port}
// (порт задаёт тест) и живёт до kill. Режимы ошибок — CB_FAKE_TUNNEL_MODE=error|hang.
const mode = process.env.CB_FAKE_TUNNEL_MODE || 'ready';
if (process.argv[2] === 'id') {
  process.stdout.write(JSON.stringify({ event: 'id', node_id: process.env.CB_FAKE_NODE_ID || 'a'.repeat(64) }) + '\n');
  process.exit(0);
}
if (mode === 'error') {
  process.stdout.write(JSON.stringify({ event: 'error', message: 'no relay' }) + '\n');
  process.exit(0);
}
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  const port = Number(process.env.CB_FAKE_TUNNEL_PORT);
  if (!Number.isInteger(port)) { console.error('CB_FAKE_TUNNEL_PORT'); process.exit(2); }
  process.stdout.write(JSON.stringify({ event: 'ready', port }) + '\n');
  setInterval(() => {}, 1000);
}
```

- [x] **Step 2: Написать падающий тест**

Создать `bridge/test/remote-tunnel.test.js`:

```js
'use strict';
// D-29: клиент берёт локальный порт туннеля только из ready; ошибки — fail-closed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { startTunnel, readNodeId } = require('../lib/remote-tunnel');

const FAKE = path.join(__dirname, 'fixtures', 'fake-tunnel.js');

test('ready{port} → порт и живой процесс', async () => {
  const t = await startTunnel({ ticket: 'x', secretFile: 'k', exePath: FAKE,
    env: { ...process.env, CB_FAKE_TUNNEL_PORT: '45678' } });
  try {
    assert.strictEqual(t.port, 45678);
    assert.strictEqual(t.child.exitCode, null);
  } finally { t.stop(); }
});

test('error из туннеля → отказ', async () => {
  await assert.rejects(startTunnel({ ticket: 'x', secretFile: 'k', exePath: FAKE,
    env: { ...process.env, CB_FAKE_TUNNEL_MODE: 'error' } }), /no relay/);
});

test('нет ready за таймаут → отказ', async () => {
  await assert.rejects(startTunnel({ ticket: 'x', secretFile: 'k', exePath: FAKE,
    env: { ...process.env, CB_FAKE_TUNNEL_MODE: 'hang' }, timeoutMs: 300 }), /не поднялся/);
});

test('readNodeId: разбор id', () => {
  const id = readNodeId({ exePath: FAKE,
    secretFile: 'k', env: { ...process.env, CB_FAKE_NODE_ID: 'b'.repeat(64) } });
  assert.strictEqual(id, 'b'.repeat(64));
});
```

- [x] **Step 3: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/remote-tunnel.test.js`
Expected: FAIL `Cannot find module '../lib/remote-tunnel'`.

- [x] **Step 4: Реализовать `bridge/lib/remote-tunnel.js`**

```js
'use strict';
// D-29: туннель на стороне ПК-клиента. Порт берём ТОЛЬКО из ready (tunnel/src/main.rs:593),
// туннель не сдаётся сам — переподключение внутри iroh, наш процесс живёт до выхода клиента.
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function defaultExe() {
  return process.env.CLAUDE_BRIDGE_TUNNEL || path.join(__dirname, '..', 'bin', 'claude-tunnel.exe');
}

/** Команда запуска: `.js` (тестовый фикстур) — через node, иначе — сам бинарь. */
function command(exePath) {
  return /\.(c|m)?js$/i.test(exePath)
    ? { cmd: process.execPath, pre: [exePath] }
    : { cmd: exePath, pre: [] };
}

/** Запустить `connect` и дождаться ready. */
function startTunnel({ ticket, secretFile, exePath = defaultExe(), timeoutMs = 30000,
  spawnFn = spawn, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (!ticket) { reject(new Error('нет ticket туннеля — включите интернет-доступ на рабочем ПК')); return; }
    const { cmd, pre } = command(exePath);
    const child = spawnFn(cmd, [...pre, 'connect', `--ticket=${ticket}`,
      '--listen', '127.0.0.1:0', '--secret-file', secretFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    let acc = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error('туннель не поднялся за ' + Math.round(timeoutMs / 1000) + ' с')), timeoutMs);
    const stop = () => { try { child.kill(); } catch { /* уже вышел */ } };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(e);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      acc += d;
      let i;
      while ((i = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, i);
        acc = acc.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.event === 'ready' && Number.isInteger(m.port)) {
          if (settled) continue;
          settled = true;
          clearTimeout(timer);
          resolve({ port: m.port, child, stop });
        } else if (m.event === 'error') {
          fail(new Error('туннель: ' + (m.message || 'ошибка')));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => fail(new Error('не удалось запустить туннель: ' + e.message)));
    child.on('exit', (code) => fail(new Error('туннель завершился (код ' + code + ')' +
      (stderr.trim() ? ': ' + stderr.trim() : ''))));
  });
}

/** Постоянный NodeId этого ПК (`id --secret-file`), ключ создаётся при первом вызове. */
function readNodeId({ exePath = defaultExe(), secretFile, env = process.env } = {}) {
  const { cmd, pre } = command(exePath);
  const r = spawnSync(cmd, [...pre, 'id', '--secret-file', secretFile],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, env });
  if (r.error) throw new Error('не удалось запустить туннель: ' + r.error.message);
  if (r.status !== 0) throw new Error('туннель id завершился с кодом ' + r.status);
  for (const line of String(r.stdout).split(/\r?\n/)) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.event === 'id' && typeof m.node_id === 'string' && /^[0-9a-f]{64}$/.test(m.node_id)) return m.node_id;
  }
  throw new Error('туннель не вернул node_id');
}

module.exports = { startTunnel, readNodeId, defaultExe };
```

- [x] **Step 5: Тест должен пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/remote-tunnel.test.js`
Expected: `pass 4`, `fail 0`.

- [x] **Step 6: Коммит**

```bash
git add bridge/lib/remote-tunnel.js bridge/test/fixtures/fake-tunnel.js bridge/test/remote-tunnel.test.js
git commit -m "feat(bridge): запуск claude-tunnel connect из ПК-клиента (D-29)"
```

---

### Task 5: `claude-mobile --pair <qr.png>`

**Files:**
- Create: `bridge/remote.js`
- Modify: `bridge/attach.js` (диспатч в начале файла + USAGE)
- Modify: `bridge/test/helpers/bridge.js` (обёртки `runAttach`, `runAttachTty`, `tcpProxy`)
- Test: `bridge/test/attach-remote.test.js`

- [x] **Step 1: Добавить обёртки в тестовые помощники**

В `bridge/test/helpers/bridge.js` перед `module.exports` добавить:

```js
/** claude-mobile без консоли (stdin — закрытый pipe). env — поверх process.env. */
function runAttach(home, args, env = {}) {
  const p = spawn(process.execPath, [path.join(__dirname, '..', '..', 'attach.js'), ...args], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, ...env },
    cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  p.stdin.end();
  let out = '';
  let err = '';
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise((r) => p.on('exit', (code) => r(code)));
  const t = setTimeout(() => killTree(p.pid), 30000);
  done.then(() => clearTimeout(t));
  return { p, done, out: () => stripAnsi(out), err: () => err };
}

/** claude-mobile в интерактивной консоли (ConPTY). */
function runAttachTty(home, args, env = {}) {
  const pty = require('../../node_modules/node-pty');
  const term = pty.spawn(process.execPath, [path.join(__dirname, '..', '..', 'attach.js'), ...args], {
    name: 'xterm', cols: 200, rows: 50, cwd: home, env: { ...process.env, CLAUDE_BRIDGE_HOME: home, ...env },
  });
  let out = '';
  term.onData((d) => { out += d; });
  const done = new Promise((r) => term.onExit(({ exitCode }) => r(exitCode)));
  const t = setTimeout(() => { try { term.kill(); } catch { /* вышел */ } }, 40000);
  done.then(() => clearTimeout(t));
  return { term, done, out: () => stripAnsi(out), write: (s) => term.write(s) };
}

/** TCP-прокси «вместо туннеля»: слушает 127.0.0.1:0 и переливает в targetPort. */
function tcpProxy(targetPort) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const socks = new Set();
    const srv = net.createServer((c) => {
      socks.add(c);
      const up = net.connect(targetPort, '127.0.0.1');
      socks.add(up);
      c.pipe(up);
      up.pipe(c);
      const drop = () => { socks.delete(c); socks.delete(up); };
      c.on('close', drop);
      up.on('close', drop);
      c.on('error', () => up.destroy());
      up.on('error', () => c.destroy());
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r()); }),
    }));
  });
}
```

В `module.exports` добавить `runAttach, runAttachTty, tcpProxy`.

`close()` рвёт все открытые соединения перед `srv.close()` — иначе сервер ждёт их и тест висит.

- [x] **Step 2: Написать падающий тест**

Создать `bridge/test/attach-remote.test.js`:

```js
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
```

- [x] **Step 3: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/attach-remote.test.js`
Expected: FAIL — `--pair` не распознан, выводится справка `claude-mobile`.

- [x] **Step 4: Создать `bridge/remote.js`**

```js
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
const { startTunnel, readNodeId, defaultExe } = require('./lib/remote-tunnel');
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
  const DATA = ensureDataDirs();
  let ticket;
  try { ticket = readQrPng(png); } catch (e) { fail('Не удалось прочитать QR: ' + e.message); }
  // NodeId получаем ДО /pair: без рабочего туннеля сопряжение бессмысленно, а устройство
  // на мосте осталось бы «осиротевшим» (D-29).
  const secret = path.join(DATA.root, 'remote', 'iroh.key');
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  const exe = defaultExe();
  if (!fs.existsSync(exe)) {
    fail(`Нет ${exe} — без него --remote не работает. Установите мост целиком.`);
  }
  let nodeId;
  try { nodeId = readNodeId({ secretFile: secret }); } catch (e) { fail(e.message); }
  let r;
  try { r = await pairDevice({ ticket, name: os.hostname(), root: DATA.root }); } catch (e) { fail(e.message); }
  console.log(`Сопряжено с мостом ${r.host}:${r.port}.`);
  if (!r.ticket) {
    console.log('Внимание: интернет-доступ на рабочем ПК выключен. Включите его и сопрягите заново — ' +
      'иначе --remote не сможет поднять туннель.');
  }
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
        const want = rest[1];
        const target = want ? list.find((s) => s.id === want) : list.filter((s) => s.alive).pop();
        if (!target) {
          die(want ? `Нет сессии ${want}. Список: claude-mobile --remote -l`
            : 'Живых сессий нет. Запустите сессию на рабочем ПК.', 1);
        } else attach(target.id);
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
```

- [x] **Step 5: Подключить диспатч в `bridge/attach.js`**

Сразу после `'use strict';` (до `const path = require(...)`) вставить:

```js
// D-29: удалённый ПК-клиент — отдельный режим: owner.token и локальный сертификат не нужны.
if (process.argv[2] === '--remote' || process.argv[2] === '--pair') {
  require('./remote').main(process.argv.slice(2));
  return; // CommonJS: дальше локальный код этого файла не выполняется
}
```

В `USAGE` добавить строки:

```
  claude-mobile --pair <qr.png>      сопрячься с мостом рабочего ПК (разово, в LAN)
  claude-mobile --remote [-l|-a [id]] работа с сессиями рабочего ПК через туннель
```

- [x] **Step 6: Тесты пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/attach-remote.test.js`
Expected: `pass 2`, `fail 0`.

Run: `cd bridge; node --test --test-concurrency=1 test/attach-agent.test.js test/attach.test.js`
Expected: `fail 0` (локальный режим не сломан).

- [x] **Step 7: Коммит**

```bash
git add bridge/remote.js bridge/attach.js bridge/test/attach-remote.test.js bridge/test/helpers/bridge.js
git commit -m "feat(bridge): claude-mobile --pair для ПК-клиента (D-29)"
```

---

### Task 6: `claude-mobile --remote -l|-a`

**Files:**
- Modify: `bridge/test/attach-remote.test.js`
- (реализация уже в `bridge/remote.js` из Task 5 — здесь проверяется поведение)

- [x] **Step 1: Добавить тесты**

Дописать в `bridge/test/attach-remote.test.js`:

```js
/** Подменить ticket на фиктивный: настоящий iroh в тестах не поднимаем. */
function fakeTicket(lap) {
  const f = path.join(lap, 'remote', 'profile.json');
  const prof = JSON.parse(fs.readFileSync(f, 'utf8'));
  prof.ticket = 'fake-ticket';
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
  } finally { await proxy.close(); fs.rmSync(lap, { recursive: true, force: true }); }
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
    await H.waitFor(async () => /ARGV:/.test(r.out()), 20000);
    r.write('hi\r');
    await H.waitFor(async () => /ECHO:"hi\\r"/.test(r.out()), 10000);
    assert.match(r.out(), /ECHO:/);
    r.term.kill();
    await r.done;
  } finally { await proxy.close(); fs.rmSync(lap, { recursive: true, force: true }); }
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
  try {
    const r = H.runAttach(lap, ['--remote', '--agent', 'echo']);
    assert.strictEqual(await r.done, 1);
    assert.match(r.err(), /только -l и -a/);
  } finally { fs.rmSync(lap, { recursive: true, force: true }); }
});
```

- [x] **Step 2: Запустить — проверить**

Run: `cd bridge; node --test --test-concurrency=1 test/attach-remote.test.js`
Expected: `pass 6`, `fail 0`.

Если `--remote -l` не выводит список — проверить, что `remote.js` печатает `sessions` до `die('', 0)`, а `die` вызывает `tunnel.stop()` (иначе процесс висит до таймаута теста).

- [x] **Step 3: Коммит**

```bash
git add bridge/test/attach-remote.test.js
git commit -m "test(bridge): --remote через туннель — список и подключение (D-29)"
```

---

### Task 7: `--qr` сохраняет PNG

**Files:**
- Modify: `bridge/attach.js` (case `pairinfo`, разбор `--qr-out`)
- Modify: `bridge/test/attach-agent.test.js`

- [x] **Step 1: Написать падающий тест**

В `bridge/test/attach-agent.test.js` после теста `--qr without paired devices…` добавить:

```js
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
```

В начало `attach-agent.test.js` добавить `const fs = require('fs');` (если его нет).

- [x] **Step 2: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/attach-agent.test.js`
Expected: FAIL — файла нет / нет строки «QR сохранён в файл».

- [x] **Step 3: Реализовать**

В `bridge/attach.js` перед `case 'pairinfo'` (внутри обработчика сообщений недоступно — вынести функцию рядом с `openLoginUrl`):

```js
/** D-29: путь для PNG с QR — --qr-out <file> или <данные>\pairing-qr.png. */
function qrOutPath() {
  const i = args.indexOf('--qr-out');
  if (i >= 0) {
    const p = args[i + 1];
    if (!p || p.startsWith('-')) fail('Укажите путь: claude-mobile --qr --qr-out <file.png>');
    return path.resolve(p);
  }
  return path.join(DATA.root, 'pairing-qr.png');
}
```

Заменить тело `case 'pairinfo'` на:

```js
    case 'pairinfo': {
      const qrcode = require(path.join(__dirname, 'node_modules', 'qrcode-terminal'));
      const ticket = JSON.stringify({ cb: 1, host: m.host, port: m.port, code: m.code, fp: m.fp });
      const out = qrOutPath();
      console.log('\nСопряжение нового устройства с Claude Bridge');
      console.log(`Адрес моста: ${m.host}:${m.port}`);
      if (m.internet) console.log(`Доступ через интернет: ${fmtInet(m.internet)}`);
      // P-7: сопряжение только по QR — код для ручного ввода не печатаем
      console.log(`Отсканируйте QR в приложении (действует ${m.ttlMin || 10} минут)\n`);
      qrcode.generate(ticket, { small: true }, (q) => {
        console.log(q);
        require('./lib/qr-image').writeQrPng(ticket, out)
          .then(() => { console.log('QR сохранён в файл: ' + out); process.exit(0); })
          .catch((e) => fail('Не удалось сохранить QR: ' + e.message));
      });
      break;
    }
```

- [x] **Step 4: Тест должен пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/attach-agent.test.js`
Expected: `fail 0`.

- [x] **Step 5: Коммит**

```bash
git add bridge/attach.js bridge/test/attach-agent.test.js
git commit -m "feat(bridge): --qr сохраняет QR в PNG для ПК-клиента (D-29)"
```

---

### Task 8: спеки, статус, полный гейт

**Files:**
- Modify: `Specs/bridge/modules/AUTH_PAIRING.md`
- Modify: `Specs/tunnel/TUNNEL.md`
- Modify: `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md`

- [x] **Step 1: Норма сопряжения ПК-клиента**

В `Specs/bridge/modules/AUTH_PAIRING.md` в таблицу «Правила (сопряжение)» добавить строку 10:

```
| 10 | ПК-клиент (D-29) сопрягается как устройство: QR из PNG, **до** `POST /pair` клиент получает сертификат моста, сверяет SHA-256 с `fp` из QR и при несовпадении отменяет сопряжение, ничего не сохраняя; профиль (`profile.json`, `bridge.cer`, `device.token`, `iroh.key`) — в `<данные>\remote`, токен — отдельным файлом | TOFU нет: отпечаток приходит по доверенному каналу (файл, перенесённый человеком); D-8 — секреты в каталоге данных профиля | ❌ `rejectUnauthorized:false` без сверки `fp` — ✅ `fetchPeerCert` + сверка, затем `pinnedTlsOptions` | `bridge/lib/pair-client.js` |
```

В §5 «Текущее состояние / долг» добавить пункт:

```
- ПК-клиент (D-29): web-UI с домашнего ПК не поддерживается (нужен новый `Origin`); удалённо доступны только `-l`/`-a`; ticket туннеля берётся из ответа `/pair` и не обновляется, если мост перезапустил туннель с новым ticket — тогда нужно сопряжение заново в LAN.
```

- [x] **Step 2: Норма туннеля на стороне клиента**

В `Specs/tunnel/TUNNEL.md` в таблицу §4 добавить строку:

```
| ПК-клиент (домашний ноутбук) | `claude-tunnel.exe connect --ticket=<ticket> --listen 127.0.0.1:0 --secret-file <данные>\remote\iroh.key`; локальный порт — **только** из `{"event":"ready","port"}`; NodeId этого ПК регистрируется на мосте по LAN (`registerNode`) | `bridge/lib/remote-tunnel.js`, `bridge/remote.js` |
```

В §2 добавить правило:

```
> **Правило.** Порт локального слушателя `connect` брать только из события `ready` (не задавать фиксированный,
> не угадывать): на одном ПК может быть несколько клиентов, а `--listen 127.0.0.1:0` выбирает свободный порт.
> **Почему.** Фиксированный порт конфликтует и раскрывает клиента другим процессам; `ready` — единственный
> машиночитаемый источник (`tunnel/src/main.rs:593`).
> ✅ `startTunnel()` ждёт `ready{port}` — ❌ `--listen 127.0.0.1:8780`.
```

- [x] **Step 3: Строка статуса в inventory**

В `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md`, таблица «Статус реализации» — добавить строку:

```
| D-29 ПК-клиент через туннель (`--pair`, `--remote`, QR-PNG, `nodeRegistered`) | ✅ реализовано, тесты; проверка на реальном ноутбуке через iroh — за оператором | `<хеши коммитов задач 1–7>` |
```

- [x] **Step 4: Линтер спеков**

Run: `node tools/check-specs.mjs`
Expected: без ошибок (если линтер ругается на формат — править по `Specs/_meta/spec-authoring-guide.md`).

- [x] **Step 5: Полный гейт**

Run: `cd bridge; npm test`
Expected: `# fail 0` (число `pass` — прежние 334 + новые тесты; `1 skipped` — живой opencode).

- [x] **Step 6: Коммит**

```bash
git add docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md
git commit -m "docs(specs): ПК-клиент через туннель — нормы и статус D-29"
```

> `Specs/*` в коммит не входят (локальные, `.gitignore`): нормы живут в рабочей копии и в Serena-памяти.

---

## Проверка на реальных ПК (после кода, за оператором)

1. Рабочий ПК: включить интернет-доступ (`claude-mobile --device` → `i`), затем `claude-mobile --qr --qr-out %USERPROFILE%\pairing-qr.png` (подтверждение на телефоне).
2. Перенести PNG на ноутбук, принести ноутбук в офисную LAN.
3. Ноутбук: `claude-mobile --pair %USERPROFILE%\pairing-qr.png` → «p2p-узел зарегистрирован».
4. Ноутбук вне LAN: `claude-mobile --remote -l`, затем `--remote -a <id>`; ввод с ноутбука виден на телефоне и рабочем ПК.
5. Отзыв: на рабочем ПК `claude-mobile --device` → отозвать «<имя ноутбука>» → `--remote` получает 401/4401 и понятное сообщение.

## Самопроверка плана

- **Покрытие D-29:** QR-PNG (Task 1, 7), сопряжение с пиннингом и профиль (Task 2, 5), NodeId в allowlist (Task 3, 5), туннель и порт из `ready` (Task 4), `--remote` список/подключение (Task 5, 6), нормы и статус (Task 8), реальная проверка (раздел выше).
- **Вне объёма:** web-UI, создание сессий, fork B, правки туннеля/APK — перечислены в шапке.
- **Имена/типы:** `pairDevice/loadProfile/registerNode/remotePaths` (Task 2) используются в Task 5 без переименований; `startTunnel/readNodeId` (Task 4) — в Task 5; `writeQrPng/readQrPng` (Task 1) — в Task 5, 7.
- **Риски:** `--qr` в тестах требует ConPTY (node-pty) — используется существующий `runAttachTty`; тесты `--remote` не поднимают iroh (TCP-прокси + фикстурный туннель).
