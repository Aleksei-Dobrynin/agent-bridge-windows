# Паритет политики подключения ПК-клиента с телефоном (D-30) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `claude-mobile --remote` ведёт себя как `BridgeService` на телефоне: LAN приоритетен, туннель — запасной путь, ticket туннеля обновляется по LAN и сохраняется в профиль, обрыв переживается переподключением, отзыв устройства не ретраится; повторное `--pair` того же ПК не плодит устройства на мосте.

**Architecture:** Политика подключения вынесена в новый `bridge/lib/client-session.js` (без UI): проверка LAN с получением свежего ticket, поиск моста по UDP-маяку, выбор пути по `lastVia`, старт туннеля только как fallback. `bridge/remote.js` становится тонким TUI поверх сессии и добавляет цикл переподключения с backoff 2→30 с. Мост меняется точечно: `/pair` принимает необязательный `nodeId`, сразу пишет его в allowlist (P2 исчезает) и при совпадении `nodeId` перевыпускает токен существующего устройства вместо добавления дубликата. Модель D-8/D-9 не меняется: `/pair` по-прежнему только основной порт и LAN, владелец — только loopback, пиннинг без TOFU.

**Tech Stack:** Node.js ≥ 20 (CommonJS), `ws`, `https`/`tls`, `dgram` (UDP-маяк), `node:test`.

**Вне объёма:** `confirmRequest` на ноутбуке (вариант C — расширяет права устройства, отдельное решение по D-8), резидентный агент/трей/автозапуск, web-UI с домашнего ПК, изменения Rust-туннеля и APK.

**Обязательные правила проекта:** `Specs/` — первым (L0→L3); арх-решения — только с «да» оператора; реальную систему пользователя не трогать; коммиты — только релевантные пути, push — только по просьбе; секреты не коммитить. Гейт: `cd bridge; npm test` → `fail 0`, `node tools/check-specs.mjs` → PASS.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `bridge/lib/client-session.js` (new) | Политика пути: probe LAN + ticket, UDP-маяк, `lastVia`, туннель как fallback, `updateProfile` |
| `bridge/lib/pairings.js` (new) | `upsertDevice`: вставка/перевыпуск устройства по `nodeId` |
| `bridge/lib/validate.js` | `pairBody` принимает необязательный `nodeId` |
| `bridge/server.js` | `/pair`: `upsertDevice` + запись allowlist сразу |
| `bridge/lib/pair-client.js` | `pairDevice` шлёт `nodeId`; `registerNode` удаляется |
| `bridge/remote.js` | TUI поверх `client-session` + цикл переподключения |
| `bridge/test/client-session.test.js` (new) | Юнит: порядок путей, ticket, отзыв, маяк, `updateProfile` |
| `bridge/test/pairings.test.js` (new) | Юнит: дедупликация устройства по `nodeId` |
| `bridge/test/attach-remote.test.js` | Интеграция: LAN-путь и туннель-путь для `--remote` |
| `bridge/test/server-pairing.test.js` | Интеграция: `/pair` с `nodeId` → allowlist сразу |
| `Specs/...`, inventory | Нормы D-30 и статус |

---

### Task 1: `lib/client-session.js` — политика пути и обновление ticket

**Files:**
- Create: `bridge/lib/client-session.js`
- Test: `bridge/test/client-session.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `bridge/test/client-session.test.js`:

```js
'use strict';
// D-30: политика подключения ПК-клиента как у телефона — порядок путей, обновление
// ticket по LAN, отзыв без ретраев, поиск моста по UDP-маяку.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { createSession, discoverBridge, updateProfile, broadcastTargets } = require('../lib/client-session');

const TOKEN = 'a'.repeat(48);
const PIN = { ca: 'x', rejectUnauthorized: true };
const FP = 'ab'.repeat(32);

function profile(over = {}) {
  return {
    host: '10.0.0.5', port: 8790, fingerprint: FP, ticket: 'old-ticket',
    paths: { secret: path.join(os.tmpdir(), 'cb-x', 'iroh.key') },
    ...over,
  };
}
const fakeWs = () => ({ close() { }, sent: [] });

test('LAN доступен: туннель не поднимается, ticket сохраняется', async () => {
  const saved = [];
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { throw new Error('туннель не должен запускаться'); },
    saveProfile: (p) => saved.push(p),
    probe: async () => ({ ok: true, ticket: 'new-ticket' }),
    openWs: async () => fakeWs(),
  });
  const { ws, via } = await s.connect();
  assert.ok(ws);
  assert.strictEqual(via, 'lan');
  assert.ok(saved.some((p) => p.ticket === 'new-ticket'), 'ticket сохранён в профиль');
  s.stop();
});

test('LAN недоступен: поднимается туннель с ticket из профиля', async () => {
  const calls = [];
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async (o) => { calls.push(o.ticket); return { port: 5555, stop() { } }; },
    probe: async () => ({ ok: false, reason: 'timeout' }),
    discover: async () => null,
    openWs: async (host, port) => { calls.push(host + ':' + port); return fakeWs(); },
  });
  const { via } = await s.connect();
  assert.strictEqual(via, 'tunnel');
  assert.deepStrictEqual(calls, ['old-ticket', '127.0.0.1:5555']);
  s.stop();
});

test('нет LAN и нет ticket — понятная ошибка без запуска туннеля', async () => {
  const s = createSession({
    profile: profile({ ticket: null }), token: TOKEN, pin: PIN,
    startTunnel: async () => { throw new Error('не должен'); },
    probe: async () => ({ ok: false, reason: 'timeout' }),
    discover: async () => null,
    openWs: async () => fakeWs(),
  });
  await assert.rejects(s.connect(), /ticket/);
});

test('отзыв устройства: ошибка помечена revoked, туннель не пробуется', async () => {
  let tunnelCalls = 0;
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { tunnelCalls++; return { port: 1, stop() { } }; },
    probe: async () => ({ ok: false, revoked: true, reason: 'HTTP 401' }),
    discover: async () => null,
    openWs: async () => fakeWs(),
  });
  await assert.rejects(s.connect(), (e) => e.revoked === true);
  assert.strictEqual(tunnelCalls, 0);
});

test('lastVia=tunnel: сначала туннель, LAN не пробуется', async () => {
  let probed = 0;
  const s = createSession({
    profile: profile({ lastVia: 'tunnel' }), token: TOKEN, pin: PIN,
    startTunnel: async () => ({ port: 5555, stop() { } }),
    probe: async () => { probed++; return { ok: true, ticket: 'x' }; },
    openWs: async () => fakeWs(),
  });
  const { via } = await s.connect();
  assert.strictEqual(via, 'tunnel');
  assert.strictEqual(probed, 0);
  s.stop();
});

test('адрес сменился: мост найден маяком, новый host сохранён', async () => {
  const saved = [];
  let calls = 0;
  const s = createSession({
    profile: profile(), token: TOKEN, pin: PIN,
    startTunnel: async () => { throw new Error('не должен'); },
    saveProfile: (p) => saved.push(p),
    probe: async ({ host }) => {
      calls++;
      return host === '10.0.0.9' ? { ok: true, ticket: 'new-ticket' } : { ok: false, reason: 'timeout' };
    },
    discover: async () => ({ host: '10.0.0.9', port: 8790 }),
    openWs: async () => fakeWs(),
  });
  const { via } = await s.connect();
  assert.strictEqual(via, 'lan');
  assert.strictEqual(calls, 2);
  assert.ok(saved.some((p) => p.host === '10.0.0.9'), 'новый адрес сохранён');
});

test('updateProfile: точечное обновление и атомарная запись', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prof-'));
  const file = path.join(dir, 'profile.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ host: 'a', port: 1, ticket: null }));
    updateProfile(file, { ticket: 't', lastVia: 'lan' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { host: 'a', port: 1, ticket: 't', lastVia: 'lan' });
    assert.ok(!fs.existsSync(file + '.tmp'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discoverBridge: отвечает только маяк с нашим отпечатком', async () => {
  const srv = dgram.createSocket({ type: 'udp4' });
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  const port = srv.address().port;
  srv.on('message', (msg, rinfo) => {
    if (msg.toString().trim() !== 'CLAUDE_BRIDGE?') return;
    srv.send(JSON.stringify({ claudeBridge: true, port: 8790, fp: FP }), rinfo.port, rinfo.address);
  });
  try {
    const found = await discoverBridge({ fingerprint: FP, port: port - 1, targets: ['127.0.0.1'], timeoutMs: 2000 });
    assert.deepStrictEqual(found, { host: '127.0.0.1', port: 8790 });
    const none = await discoverBridge({ fingerprint: 'cd'.repeat(32), port: port - 1, targets: ['127.0.0.1'], timeoutMs: 300 });
    assert.strictEqual(none, null);
  } finally { srv.close(); }
});

test('broadcastTargets: глобальный адрес и направленные broadcast', () => {
  const list = broadcastTargets(() => ({
    Wi_Fi: [{ family: 4, address: '192.168.1.10', netmask: '255.255.255.0', internal: false }],
    lo: [{ family: 4, address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  }));
  assert.ok(list.includes('255.255.255.255'));
  assert.ok(list.includes('192.168.1.255'));
  assert.ok(!list.includes('127.255.255.255'));
});
```

- [ ] **Step 2: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/client-session.test.js`
Expected: FAIL `Cannot find module '../lib/client-session'`.

- [ ] **Step 3: Реализовать `bridge/lib/client-session.js`**

```js
'use strict';
// D-30: политика подключения ПК-клиента как у телефона (BridgeService) — LAN приоритетен,
// туннель запасной путь, ticket обновляется по LAN и сохраняется в профиль, отзыв не ретраится.
// Модуль не рисует UI: TUI и переподключение — в bridge/remote.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const BEACON_QUERY = 'CLAUDE_BRIDGE?';
const LAN_TIMEOUT_MS = 1500;
const BEACON_TIMEOUT_MS = 1200;
const BEACON_COOLDOWN_MS = 60000;

/** Цели broadcast-запроса маяка: глобальный адрес + направленные на каждый IPv4-интерфейс. */
function broadcastTargets(ifaces = os.networkInterfaces) {
  const out = ['255.255.255.255'];
  for (const list of Object.values(ifaces() || {})) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const ip = String(a.address || '').split('.').map(Number);
      const mask = String(a.netmask || '').split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some(Number.isNaN) || mask.some(Number.isNaN)) continue;
      out.push(ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...new Set(out)];
}

/** Найти мост по UDP-маяку (P-7: в ответе нет имени ПК — сверяем отпечаток). */
function discoverBridge({ fingerprint, port, timeoutMs = BEACON_TIMEOUT_MS, targets }) {
  return new Promise((resolve) => {
    const want = String(fingerprint).toLowerCase();
    const sock = dgram.createSocket({ type: 'udp4' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* закрыт */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', (msg, rinfo) => {
      let m;
      try { m = JSON.parse(msg.toString('utf8')); } catch { return; }
      if (!m || m.claudeBridge !== true) return;
      if (String(m.fp || '').toLowerCase() !== want) return;
      if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65533) return;
      finish({ host: rinfo.address, port: m.port });
    });
    sock.on('error', () => finish(null));
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* не критично */ }
      for (const t of targets || broadcastTargets()) {
        try { sock.send(BEACON_QUERY, port + 1, t); } catch { /* адрес недоступен */ }
      }
    });
  });
}

/** Проверить LAN-путь и заодно забрать свежий ticket (мост отвечает на `internet`). */
function probeLan({ host, port, pin, token, timeoutMs = LAN_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch { /* уже закрыт */ }
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'таймаут' }), timeoutMs);
    try {
      ws = new WebSocket(`wss://${host}:${port}/ws`, {
        ...pin, headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: timeoutMs,
      });
    } catch (e) { done({ ok: false, reason: e.message }); return; }
    ws.on('open', () => { try { ws.send(JSON.stringify({ type: 'internet' })); } catch { /* закроется */ } });
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      done({ ok: false, revoked: res.statusCode === 401, reason: 'HTTP ' + res.statusCode });
    });
    ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (m && m.type === 'internet') {
        done({ ok: true, ticket: typeof m.ticket === 'string' && m.ticket ? m.ticket : null });
      }
    });
    ws.on('error', (e) => done({ ok: false, reason: e.message }));
    ws.on('close', () => done({ ok: false, reason: 'закрыто' }));
  });
}

/** Точечно обновить profile.json (атомарно: tmp + rename). */
function updateProfile(file, patch) {
  let prof;
  try { prof = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const next = { ...prof, ...patch };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

/**
 * Сессия ПК-клиента. Порядок путей: последний удачный (`lastVia`) первым, второй — запасной.
 * connect() отдаёт готовый WS моста; переподключение и backoff — на стороне вызывающего.
 */
function createSession({ profile, token, pin, startTunnel, saveProfile, probe = probeLan, discover = discoverBridge,
  openWs = (host, port) => defaultOpenWs(host, port, { pin, token }) }) {
  let tunnel = null;
  let via = profile.lastVia === 'tunnel' ? 'tunnel' : 'lan';
  let lastDiscoverAt = 0;

  function stopTunnel() {
    if (!tunnel) return;
    try { tunnel.stop(); } catch { /* уже */ }
    tunnel = null;
  }

  function persist(patch) {
    Object.assign(profile, patch);
    if (!saveProfile) return;
    try { saveProfile(patch); } catch { /* профиль мог исчезнуть — не критично */ }
  }

  async function lanTarget() {
    let host = profile.host;
    let port = profile.port;
    let p = await probe({ host, port, pin, token });
    if (p.ok) return { host, port, ticket: p.ticket };
    if (p.revoked) {
      const e = new Error('мост отклонил токен устройства — оно отозвано?');
      e.revoked = true;
      throw e;
    }
    // DHCP сменил адрес: ищем мост маяком, но не чаще раза в минуту
    if (Date.now() - lastDiscoverAt < BEACON_COOLDOWN_MS) return null;
    lastDiscoverAt = Date.now();
    const found = await discover({ fingerprint: profile.fingerprint, port });
    if (!found || (found.host === host && found.port === port)) return null;
    p = await probe({ host: found.host, port: found.port, pin, token });
    if (!p.ok) return null;
    return { host: found.host, port: found.port, ticket: p.ticket };
  }

  return {
    get via() { return via; },
    async connect() {
      const order = via === 'lan' ? ['lan', 'tunnel'] : ['tunnel', 'lan'];
      const errors = [];
      for (const step of order) {
        try {
          if (step === 'lan') {
            const t = await lanTarget();
            if (!t) { errors.push('LAN недоступен'); continue; }
            const ws = await openWs(t.host, t.port);
            const patch = { lastVia: 'lan' };
            if (t.host !== profile.host || t.port !== profile.port) { patch.host = t.host; patch.port = t.port; }
            if (t.ticket && t.ticket !== profile.ticket) patch.ticket = t.ticket;
            persist(patch);
            via = 'lan';
            return { ws, via };
          }
          if (!profile.ticket) {
            const e = new Error('мост не сообщил ticket туннеля');
            e.noTicket = true;
            throw e;
          }
          tunnel = await startTunnel({ ticket: profile.ticket, secretFile: profile.paths.secret });
          const ws = await openWs('127.0.0.1', tunnel.port);
          persist({ lastVia: 'tunnel' });
          via = 'tunnel';
          return { ws, via };
        } catch (e) {
          if (e.revoked) { stopTunnel(); throw e; }
          stopTunnel();
          errors.push((step === 'lan' ? 'LAN' : 'туннель') + ': ' + e.message);
        }
      }
      throw new Error('Мост недоступен (' + errors.join('; ') + ')');
    },
    stop: stopTunnel,
  };
}

/** Обычное WS-соединение с мостом (пиннинг уже в pin). */
function defaultOpenWs(host, port, { pin, token } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:${port}/ws`, {
      ...pin, headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: 10000,
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => {
      req.destroy();
      const e = new Error('мост ответил HTTP ' + res.statusCode + ' вместо WebSocket');
      e.status = res.statusCode;
      if (res.statusCode === 401) e.revoked = true;
      reject(e);
    });
    ws.once('error', reject);
  });
}

module.exports = {
  createSession, probeLan, discoverBridge, broadcastTargets, updateProfile,
  LAN_TIMEOUT_MS, BEACON_TIMEOUT_MS, BEACON_COOLDOWN_MS,
};
```

- [ ] **Step 4: Тест должен пройти**

Run: `cd bridge; node --test --test-concurrency=1 test/client-session.test.js`
Expected: `pass 9`, `fail 0`.

- [ ] **Step 5: Коммит**

```bash
git add bridge/lib/client-session.js bridge/test/client-session.test.js
git commit -m "feat(bridge): политика пути ПК-клиента — LAN, ticket, маяк (D-30)"
```

---

### Task 2: `/pair` с `nodeId` — allowlist сразу и без дубликатов

**Files:**
- Create: `bridge/lib/pairings.js`
- Test: `bridge/test/pairings.test.js`
- Modify: `bridge/lib/validate.js` (`pairBody`)
- Modify: `bridge/server.js:921-940`
- Modify: `bridge/lib/pair-client.js` (`pairDevice`, удалить `registerNode`)
- Modify: `bridge/test/server-pairing.test.js`

- [ ] **Step 1: Написать падающий тест дедупликации**

Создать `bridge/test/pairings.test.js`:

```js
'use strict';
// D-30: повторное сопряжение того же p2p-узла перевыпускает токен, а не плодит устройства.
const test = require('node:test');
const assert = require('node:assert');
const { upsertDevice } = require('../lib/pairings');

const at = '2026-11-05T10:00:00.000Z';
const hash = (c) => c.repeat(64);

test('новое устройство добавляется', () => {
  const devices = [];
  const r = upsertDevice(devices, { tokenHash: hash('a'), name: 'home laptop', nodeId: 'b'.repeat(64), at });
  assert.strictEqual(r.replaced, false);
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].nodeId, 'b'.repeat(64));
  assert.strictEqual(devices[0].id, hash('a').slice(0, 12));
});

test('тот же nodeId — перевыпуск токена без дубликата', () => {
  const devices = [];
  const nid = 'b'.repeat(64);
  upsertDevice(devices, { tokenHash: hash('a'), name: 'home laptop', nodeId: nid, at });
  const r = upsertDevice(devices, { tokenHash: hash('c'), name: 'home laptop', nodeId: nid, at });
  assert.strictEqual(r.replaced, true);
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].tokenHash, hash('c'));
  assert.strictEqual(devices[0].nodeId, nid);
});

test('без nodeId устройства не схлопываются', () => {
  const devices = [];
  upsertDevice(devices, { tokenHash: hash('a'), name: 'phone', at });
  upsertDevice(devices, { tokenHash: hash('b'), name: 'phone', at });
  assert.strictEqual(devices.length, 2);
});
```

- [ ] **Step 2: Запустить — упасть**

Run: `cd bridge; node --test --test-concurrency=1 test/pairings.test.js`
Expected: FAIL `Cannot find module '../lib/pairings'`.

- [ ] **Step 3: Реализовать `bridge/lib/pairings.js`**

```js
'use strict';
// D-30: повторное сопряжение того же p2p-узла (тот же NodeId) не должно плодить устройства:
// перевыпускаем токен существующей записи. Без nodeId поведение прежнее (телефон регистрирует
// NodeId отдельным сообщением registerNode уже после /pair).
function upsertDevice(devices, { tokenHash, name, nodeId, at }) {
  const id = tokenHash.slice(0, 12);
  const same = nodeId ? devices.find((d) => d.nodeId === nodeId) : null;
  if (same) {
    Object.assign(same, { id, tokenHash, name, addedAt: at });
    return { device: same, replaced: true };
  }
  const device = { id, tokenHash, name, addedAt: at };
  if (nodeId) device.nodeId = nodeId;
  devices.push(device);
  return { device, replaced: false };
}

module.exports = { upsertDevice };
```

- [ ] **Step 4: `pairBody` принимает `nodeId`**

В `bridge/lib/validate.js` заменить `pairBody`:

```js
function pairBody(p) {
  if (!p || typeof p !== 'object' || typeof p.code !== 'string' || p.code.length > 64) return null;
  const out = { code: p.code.toUpperCase(), name: cleanTitle(p.name, 64) || '' };
  const nid = nodeId(p.nodeId); // D-30: ПК-клиент сообщает свой NodeId сразу при /pair
  if (nid) out.nodeId = nid;
  return out;
}
```

- [ ] **Step 5: `/pair` — upsert и allowlist**

В `bridge/server.js` (начало обработчика `/pair`, строка `const safeName = ...`) заменить блок
`pairings.devices.push({...})` и всё до `res.writeHead(200, ...)` на:

```js
      const safeName = p.name || 'устройство';
      const nid = p.nodeId || null;
      // D-30: повторное сопряжение того же узла перевыпускает токен, а не добавляет дубликат;
      // P2: NodeId пишется в allowlist сразу, второго шага (registerNode) для ПК-клиента нет.
      const { replaced } = P.upsertDevice(pairings.devices, {
        tokenHash, name: safeName, nodeId: nid, at: new Date().toISOString(),
      });
      pairings.phoneRequired = true; // D-22.2: дальше — только подтверждение на телефоне
      savePairings();
      if (nid) writeAllowFile();
      console.log(`\n  Сопряжено ${replaced ? 'заново' : 'новое'} устройство: ${safeName}`);
      // уже сопряжённые устройства узнают о новом (D-15 п. 6); формат notify — D-15 п. 1
      broadcast({
        type: 'notify', id: '', event: 'info',
        message: `${replaced ? 'Устройство сопряжено заново' : 'Сопряжено новое устройство'}: ${safeName}`,
        title: 'Claude Bridge', at: Date.now(),
      });
```

Подключить модуль рядом с другими `require` в начале `server.js`:

```js
const P = require('./lib/pairings');
```

- [ ] **Step 6: `pairDevice` шлёт `nodeId`, `registerNode` удаляется**

В `bridge/lib/pair-client.js`:
1. `pairDevice` принимает `nodeId` и передаёт его в теле `/pair`:

```js
async function pairDevice({ ticket, name, root, nodeId, timeoutMs }) {
  const t = parseTicket(typeof ticket === 'string' ? ticket : JSON.stringify(ticket));
  const der = await fetchPeerCert(t.host, t.port, timeoutMs);
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  if (fp !== t.fp) throw new Error('отпечаток сертификата не совпал с QR — сопряжение отменено');
  const pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), fp);
  // D-30: NodeId уходит вместе с кодом — мост сразу пишет allowlist (P2: без «осиротевших» устройств)
  const body = { code: t.code, name };
  if (nodeId) body.nodeId = nodeId;
  const res = await postPair(t.host, t.port, pin, body, timeoutMs);
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
    der, host: t.host, port: t.port, fingerprint: fp, ticket: r.nodeTicket, name, token: r.token,
  });
  return { token: r.token, fingerprint: fp, host: t.host, port: t.port, ticket: r.nodeTicket || null, paths };
}
```

2. Удалить функцию `registerNode` целиком и убрать её из `module.exports`:

```js
module.exports = { parseTicket, pairDevice, loadProfile, remotePaths };
```

3. Убрать из файла ставший ненужным `const WebSocket = require(...)` (он использовался только
   `registerNode`).

- [ ] **Step 7: Интеграционный тест `/pair` с NodeId**

В конец `bridge/test/server-pairing.test.js` добавить:

```js
test('/pair с nodeId: allowlist сразу, без registerNode (D-30)', { timeout: 60000 }, async () => {
  const o = await b.connect(b.owner);
  const at = o.mark();
  o.send({ type: 'pairinfo' });
  // устройства уже есть → нужен подтверждающий телефон; в этом файле это `token`
  const d = await b.connect(token);
  await d.wait((m) => m.type === 'sessions');
  const req = await d.wait((m) => m.type === 'confirmRequest', 5000, at);
  d.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
  const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
  const nodeId = 'b'.repeat(64);
  const res = await H.request(b.port, b.pin, { path: '/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    JSON.stringify({ code: p.code, name: 'home laptop', nodeId }));
  assert.strictEqual(res.statusCode, 200, res.body);
  const dev = JSON.parse(fs.readFileSync(path.join(b.home, 'pairings.json'), 'utf8')).devices
    .find((x) => x.nodeId === nodeId);
  assert.ok(dev, 'устройство сохранено с NodeId');
  assert.strictEqual(dev.name, 'home laptop');
  const allow = fs.readFileSync(path.join(b.home, 'certs', 'tunnel-allow.txt'), 'utf8');
  assert.ok(allow.includes(nodeId), 'NodeId в allowlist без отдельного registerNode');
});
```

- [ ] **Step 8: Прогнать тесты**

Run: `cd bridge; node --test --test-concurrency=1 test/pairings.test.js test/server-pairing.test.js`
Expected: `fail 0` (5 тестов в `server-pairing`).

Run: `cd bridge; node --test --test-concurrency=1 test/pair-client.test.js`
Expected: `fail 0` (4 теста). `attach-remote.test.js` проверяется в Task 3 — здесь его не запускай,
он ещё на старом `remote.js`.

- [ ] **Step 9: Коммит**

```bash
git add bridge/lib/pairings.js bridge/lib/validate.js bridge/lib/pair-client.js bridge/server.js bridge/test/pairings.test.js bridge/test/server-pairing.test.js
git commit -m "feat(bridge): /pair с nodeId — allowlist сразу и без дубликатов (D-30)"
```

---

### Task 3: `remote.js` — TUI поверх сессии и переподключение

**Files:**
- Modify: `bridge/remote.js`
- Modify: `bridge/test/attach-remote.test.js`

- [ ] **Step 1: Переписать `bridge/remote.js`**

Полный файл:

```js
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
```

- [ ] **Step 2: Обновить `attach-remote.test.js` — LAN-путь**

В конец файла добавить помощник и тест:

```js
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
```

Дополнить фикстуру `bridge/test/fixtures/fake-tunnel.js`: сразу после `'use strict'` (до проверки
`argv[2] === 'id'`) писать маркер, если задан `CB_FAKE_TUNNEL_MARK`:

```js
const fs = require('fs');
if (process.env.CB_FAKE_TUNNEL_MARK) {
  try { fs.writeFileSync(process.env.CB_FAKE_TUNNEL_MARK, '1'); } catch { /* тест сам проверит */ }
}
```

Режим `CB_FAKE_TUNNEL_MODE=error` в фикстуре уже есть — правок не требует.

- [ ] **Step 3: Прогнать тесты**

Run: `cd bridge; node --test --test-concurrency=1 test/attach-remote.test.js`
Expected: `pass 7`, `fail 0`; процессов `fake-tunnel.js` — 0.

Run: `cd bridge; node --test --test-concurrency=1 test/remote-tunnel.test.js test/client-session.test.js`
Expected: `fail 0`.

- [ ] **Step 4: Коммит**

```bash
git add bridge/remote.js bridge/test/attach-remote.test.js bridge/test/fixtures/fake-tunnel.js
git commit -m "feat(bridge): --remote — LAN/туннель и переподключение (D-30)"
```

---

### Task 4: спеки, статус, полный гейт

**Files:**
- Modify: `Specs/bridge/modules/AUTH_PAIRING.md`
- Modify: `Specs/bridge/modules/NETWORK_DISCOVERY.md`
- Modify: `Specs/tunnel/TUNNEL.md`
- Modify: `Specs/shared/PROTOCOL.md`
- Modify: `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md`

- [ ] **Step 1: `AUTH_PAIRING.md` — правило 10**

Дописать в конец правила 10 (строка 81) через `;`:

```markdown
При повторном сопряжении того же NodeId мост перевыпускает токен существующей записи
(`bridge/lib/pairings.js:upsertDevice`), а не добавляет дубликат; `nodeId` в теле `/pair`
сразу попадает в allowlist туннеля (P2: отдельный `registerNode` для ПК-клиента не нужен).
```

- [ ] **Step 2: `AUTH_PAIRING.md` §5 — снять долг P1**

Заменить пункт:

```markdown
- ПК-клиент (D-29): web-UI с домашнего ПК не поддерживается (нужен новый `Origin`); удалённо доступны только `-l`/`-a`;
  ticket туннеля берётся из ответа `/pair` и не обновляется, если мост перезапустил туннель с новым ticket — тогда
  нужно сопряжение заново в LAN.
```

на:

```markdown
- ПК-клиент (D-29/D-30): web-UI с домашнего ПК не поддерживается (нужен новый `Origin`); удалённо доступны
  только `-l`/`-a`. Политика пути — как у телефона: `lastVia` (LAN/туннель), ticket обновляется по LAN при
  каждом старте и сохраняется в `profile.json` (`bridge/lib/client-session.js`), обрыв — переподключение
  с backoff 2→30 с. Если мост перезапустил туннель, а ноутбук вне LAN, свежий ticket получить негде —
  нужен хотя бы разовый LAN.
```

- [ ] **Step 3: `NETWORK_DISCOVERY.md` — маяк как источник для ПК-клиента**

Добавить в таблицу §2 после правила 4:

```markdown
| 9 | ПК-клиент использует UDP-маяк, чтобы найти мост после смены адреса (DHCP): запрос `CLAUDE_BRIDGE?` на `port+1`, ответ принимается только при совпадении `fp` с отпечатком из профиля, не чаще раза в 60 с | Профиль хранит адрес, но он устаревает; сверка `fp` не даёт подключиться к чужому мосту | ❌ доверять первому ответившему — ✅ `discoverBridge({fingerprint})` | `bridge/lib/client-session.js` |
```

- [ ] **Step 4: `TUNNEL.md` §4 — строка ПК-клиента**

Заменить строку «ПК-клиент (домашний ноутбук)» на:

```markdown
| ПК-клиент (домашний ноутбук) | Сначала LAN (`wss://<host>:<port>/ws` с токеном устройства, оттуда же свежий ticket через `{type:'internet'}`); вне LAN — `claude-tunnel.exe connect --ticket=<ticket> --listen 127.0.0.1:0 --secret-file <данные>\remote\iroh.key`, порт — **только** из `{"event":"ready","port"}`; NodeId уходит в `/pair` (`nodeId`) и сразу попадает в allowlist | `bridge/lib/client-session.js`, `bridge/lib/remote-tunnel.js` |
```

- [ ] **Step 5: `PROTOCOL.md`**

1. В §1.3 строку `POST /pair` заменить на:

```markdown
| `POST /pair` | без авторизации, только основной порт (иначе 404) | `{code, name, nodeId?}` ≤ 4 КБ → 200 `{token, fingerprint, port, hostname, nodeTicket, internet}`; `nodeId` (64 hex) сразу пишется в allowlist (D-30); 400 / 403 (неверный/истёк) / 429 (блок) | `bridge/server.js:862` |
```

2. В §1.4 строку `internet` заменить на:

```markdown
| `internet` | — → `internet`; ПК-клиент так забирает свежий ticket по LAN (D-30) | все | `bridge/server.js:1493` |
```

3. В §1.4 строку `registerNode` заменить на:

```markdown
| `registerNode` | `nodeId` (64 hex) — в allowlist туннеля; ответ — nodeRegistered | устройство (телефон; ПК-клиент передаёт nodeId в `/pair`) | `bridge/server.js:1497` |
```

- [ ] **Step 6: Inventory — D-30 и статус**

Перед `## Статус реализации` добавить:

```markdown
### D-30 (OT-19). Паритет политики подключения ПК-клиента с телефоном — ✅ accepted (пользователь, 2026-11-05)

| Поле | Значение |
|---|---|
| Решение | Вариант B: перенести на ноутбук политику `BridgeService`, а не Android-обвязку. LAN приоритетен (`lastVia`), туннель — запасной путь; ticket обновляется по LAN (`{type:'internet'}`) и сохраняется в `profile.json`; адрес моста при смене DHCP ищется UDP-маяком со сверкой `fp` (не чаще раза в 60 с); обрыв — переподключение с backoff 2→30 с; 401/4401 — отказ без ретраев. Повторное `--pair` того же NodeId перевыпускает токен (без дубликатов), `nodeId` в теле `/pair` сразу пишется в allowlist (P2 закрыт). |
| Источник | Сессия 2026-11-05: пользователь спросил, можно ли перенести механизм телефона; выбрал B из A (только P1) / B (паритет политики) / C (паритет + `confirmRequest` + резидентный агент). |
| Последствия | Меняются `bridge/lib/client-session.js` (new), `bridge/lib/pairings.js` (new), `bridge/lib/validate.js`, `bridge/server.js` (`/pair`), `bridge/lib/pair-client.js`, `bridge/remote.js`. D-8/D-9 не меняются: `/pair` — только LAN и основной порт, владелец — только loopback, пиннинг без TOFU, секреты — в каталоге данных. Минус: вне LAN старт `--remote` платит до 1,5 с за проверку LAN (сглаживается `lastVia`). |
| Альтернативы | ❌ A — ticket обновляется, но после рестарта туннеля вне LAN всё равно нужен LAN, дубликаты устройств остаются. ❌ C — `confirmRequest` на ноутбуке делает его вторым фактором и ослабляет D-8 (телефон как страховка), плюс резидентный агент/трей. ❌ Не переносить — рестарт туннеля требует ручного `--pair`. |
| Не обсуждено | Нужен ли `confirmRequest` на ноутбуке (вариант C) — отдельное решение по D-8; клиентский режим `install.ps1 -Client` — вне объёма. |
```

В таблицу «Статус реализации» добавить строку:

```markdown
| D-30 паритет политики ПК-клиента (LAN-first, ticket по LAN, маяк, переподключение, дедуп `/pair`) | ✅ реализовано, тесты; проверка на реальных ПК — за оператором | `<хеши коммитов Task 1–3>` |
```

В строке OT-19 заменить статус `🔄` на `✅` и дописать: `Политика пути — D-30.`

- [ ] **Step 7: Линтер спеков**

Run: `node tools/check-specs.mjs`
Expected: `RESULT: PASS` (0 errors, 0 warnings).

- [ ] **Step 8: Полный гейт**

Run: `cd bridge; npm test`
Expected: `# fail 0`. Если `attach-agent.test.js` даст флейк `STATUS_CONTROL_C_EXIT` — перезапустить
изолированно и указать оба результата; другая ошибка — BLOCKED, не править код.

- [ ] **Step 9: Коммит**

```bash
git add docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md
git commit -m "docs(specs): D-30 — паритет политики ПК-клиента и статус"
```

`Specs/*` локальны (`.gitignore`) — в коммит не входят.

---

## Проверка на реальных ПК (после кода, за оператором)

1. Рабочий ПК: `claude-mobile --device` → `i`; `claude-mobile --qr --qr-out %USERPROFILE%\pairing-qr.png`.
2. Ноутбук в офисной LAN: `claude-mobile --pair %USERPROFILE%\pairing-qr.png` → «p2p-узел зарегистрирован».
3. В LAN: `claude-mobile --remote -l` — должен работать **без** туннеля (в логе моста нет нового iroh-соединения).
4. Вне LAN: `--remote -l`, `--remote -a <id>` — через туннель.
5. Перезапустить мост (туннель перевыпустит ticket), ноутбук вне LAN → `--remote` не должен требовать
   повторного `--pair`, пока не истёк старый ticket; после возврата в LAN — ticket обновится сам.
6. Отзыв устройства → `--remote` получает 401/4401 без ретраев.

## Самопроверка плана

- **Покрытие D-30:** LAN-first/`lastVia` (Task 1), ticket по LAN + сохранение (Task 1), маяк (Task 1),
  переподключение/отзыв (Task 3), дедуп `/pair` + P2 (Task 2), нормы и статус (Task 4).
- **Имена/типы:** `createSession/probeLan/discoverBridge/updateProfile` (Task 1) → Task 3;
  `upsertDevice` (Task 2) → `server.js`; `pairDevice({nodeId})` (Task 2) → Task 3.
- **Вне объёма:** `confirmRequest`, резидентный агент, web-UI, Rust/APK.
- **Риски:** тесты `--remote` не поднимают iroh (фикстура + TCP-прокси); проверка маяка — на loopback
  UDP-сокете, без реального broadcast.
