# Ядро моста на Windows — план реализации (подплан 1 из 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** мост (`bridge/`) работает на Windows: данные в `%LOCALAPPDATA%\ClaudeBridge`, локальная аутентификация токеном вместо UID, сертификат без openssl, keeper по named pipe с рукопожатием, пути Windows, хук на Node, автозапуск без консоли, исправления устойчивости из аудита.

**Architecture:** новая логика выносится в небольшие модули `bridge/lib/*.js` с юнит-тестами на `node:test`; `server.js`, `keeper.js`, `attach.js` переводятся на эти модули. Протокол WS с телефоном в этом подплане НЕ меняется (это подпланы 2–3), поэтому существующее приложение продолжает работать с новым мостом — сквозная проверка возможна после каждого этапа.

**Tech Stack:** Node.js ≥ 20 (на машине 24.8), `node:test`, `ws` 8, `node-pty` 1.1 (системный ConPTY), PowerShell 5.1 (`New-SelfSignedCertificate`), Windows named pipes.

**Источник решений:** `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md` — D-1, D-7, D-8, D-9, D-11, P-1, P-4, P-7, P-9, P-10. Остальные подпланы: (2) адаптеры агентов и протокол D-3/D-4/D-5/D-10/D-12 — после живых проб; (3) веб-клиент и Android; (4) распространение P-8.

**Не делаем (D-9):** Linux-режим, обратную совместимость старых данных/протокола, миграцию `bridge/config.json` и `bridge/pairings.json`.

> **Статус выполнения (2026-10-31):** задачи 1–15 реализованы и закоммичены в `feature/windows-multi-agent`
> (`2f027df` … `814ca1c`), каждая группа прошла ревью соответствия и качества с правками; `npm test` — 108/108.
> Отклонения от кода задач зафиксированы в разделе «Поправки по итогам ревью» и в реестре (D-16, D-17).

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| `bridge/lib/datadir.js` (новый) | Каталог данных `%LOCALAPPDATA%\ClaudeBridge` и пути внутри него |
| `bridge/lib/paths.js` (новый) | D-7: раскрытие `~`/`%VAR%`, канонизация, проверка вложенности, допустимые формы путей с телефона |
| `bridge/lib/tokens.js` (новый) | P-1: токен владельца, одноразовые токены, сравнение постоянного времени |
| `bridge/lib/origin.js` (новый) | P-1: allowlist заголовка `Origin` |
| `bridge/lib/cert.js` (новый) | P-4: генерация/загрузка сертификата через PowerShell, отпечаток, пиннинг для локальных клиентов |
| `bridge/lib/keeper-channel.js` (новый) | D-11: имя pipe, рукопожатие HMAC в обе стороны, JSON-строки |
| `bridge/lib/which.js` (новый) | Поиск исполняемого файла по PATH/PATHEXT для запуска в ConPTY |
| `bridge/lib/validate.js` (новый) | P-10: проверка типов входящих сообщений (M-2, L-1, L-2, L-8) |
| `bridge/lib/log.js` (новый) | Лог в файл с ротацией по размеру |
| `bridge/keeper.js` | Переписать на named pipe + рукопожатие; секрет не наследуется агентом |
| `bridge/server.js` | Интеграция модулей, удаление `/proc`-логики, Origin, токены, ott, устойчивость |
| `bridge/attach.js` | Токен владельца, пиннинг, `resize`, `--open`, `--rotate-token`, подтверждения P-9 |
| `bridge/hooks/bridge-hook.js` (новый) | Хук Claude Code на Node с пиннингом и токеном хука |
| `bridge/hooks/bridge-hook.sh` | Удалить |
| `bridge/start-bridge.js` (новый) | Запуск моста отсоединённым скрытым процессом (для Планировщика) |
| `bridge/config.example.json` | Windows-значения по умолчанию |
| `bridge/test/*.test.js` (новые) | Юнит- и интеграционные тесты |
| `bridge/package.json` | Скрипт `test` |
| `.gitignore` | Починить inline-комментарии (M-1), добавить `.serena/` |

---

### Task 1: Тестовая инфраструктура и `.gitignore`

**Files:**
- Modify: `bridge/package.json`
- Modify: `.gitignore`
- Create: `bridge/test/smoke.test.js`

- [ ] **Step 1: Добавить скрипт тестов**

`bridge/package.json`, блок `scripts`:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test --test-concurrency=1 \"test/*.test.js\""
  },
```

- [ ] **Step 2: Смоук-тест**

`bridge/test/smoke.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('test runner works', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 3: Запустить**

Run: `cd bridge && npm test`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 4: Починить `.gitignore` (M-1)**

Заменить первый блок файла (строки 1–10) — комментарии только на отдельных строках:

```gitignore
# --- Секреты и личные данные (НИКОГДА не коммитить) ---
# Данные моста на Windows живут в %LOCALAPPDATA%\ClaudeBridge (вне репозитория);
# правила ниже — страховка на случай ручного копирования файлов в клон.
bridge/config.json
bridge/certs/
bridge/pairings.json
bridge/internet.json
*.pem
*.key
*.pfx
*.p12
*.keystore
*.jks
.env
```

и в блок «Инструменты» добавить строку `.serena/`.

- [ ] **Step 5: Проверить**

Run: `git check-ignore -v bridge/config.json bridge/pairings.json bridge/certs/x .serena/x`
Expected: 4 строки с указанием правила `.gitignore` для каждого пути.

- [ ] **Step 6: Commit**

```bash
git add bridge/package.json bridge/test/smoke.test.js .gitignore
git commit -m "chore(bridge): node:test runner; fix .gitignore inline comments (M-1)"
```

---

### Task 2: `datadir.js` — каталог данных

**Files:**
- Create: `bridge/lib/datadir.js`
- Test: `bridge/test/datadir.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataDir, ensureDataDirs } = require('../lib/datadir');

test('CLAUDE_BRIDGE_HOME overrides data dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dd-'));
  process.env.CLAUDE_BRIDGE_HOME = tmp;
  try {
    assert.strictEqual(dataDir(), tmp);
    const d = ensureDataDirs();
    for (const sub of ['sessions', 'logs', 'certs']) assert.ok(fs.statSync(path.join(tmp, sub)).isDirectory());
    assert.strictEqual(d.pairings, path.join(tmp, 'pairings.json'));
    assert.strictEqual(d.ownerToken, path.join(tmp, 'owner.token'));
  } finally {
    delete process.env.CLAUDE_BRIDGE_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('default data dir is under LOCALAPPDATA', () => {
  assert.strictEqual(dataDir().toLowerCase(), path.join(process.env.LOCALAPPDATA, 'ClaudeBridge').toLowerCase());
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/datadir.test.js`
Expected: FAIL — `Cannot find module '../lib/datadir'`.

- [ ] **Step 3: Реализация** — `bridge/lib/datadir.js`:

```js
'use strict';
// Каталог данных моста (D-9, P-1): секреты и состояние — в профиле пользователя,
// а не в рабочей копии git. Профиль закрыт ACL от других учётных записей (D-8).
const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir() {
  if (process.env.CLAUDE_BRIDGE_HOME) return process.env.CLAUDE_BRIDGE_HOME;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ClaudeBridge');
}

function ensureDataDirs(root = dataDir()) {
  for (const sub of ['', 'sessions', 'logs', 'certs']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return {
    root,
    config: path.join(root, 'config.json'),
    pairings: path.join(root, 'pairings.json'),
    internet: path.join(root, 'internet.json'),
    ownerToken: path.join(root, 'owner.token'),
    certs: path.join(root, 'certs'),
    sessions: path.join(root, 'sessions'),
    logs: path.join(root, 'logs'),
  };
}

module.exports = { dataDir, ensureDataDirs };
```

- [ ] **Step 4: Тест проходит**

Run: `cd bridge && node --test test/datadir.test.js`
Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/datadir.js bridge/test/datadir.test.js
git commit -m "feat(bridge): data dir in %LOCALAPPDATA%\\ClaudeBridge (P-1)"
```

---

### Task 3: `paths.js` — пути Windows (D-7)

**Files:**
- Create: `bridge/lib/paths.js`
- Test: `bridge/test/paths.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/paths');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-paths-')));
const proj = path.join(tmp, 'Work', 'RepoA');
fs.mkdirSync(proj, { recursive: true });
const outside = path.join(tmp, 'Secret');
fs.mkdirSync(outside, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('expandConfigPath: ~, %VAR%, forward slashes', () => {
  assert.strictEqual(P.expandConfigPath('~'), path.win32.normalize(os.homedir()));
  assert.strictEqual(P.expandConfigPath('~/x'), path.win32.join(os.homedir(), 'x'));
  process.env.CB_TEST_DIR = 'C:\\data';
  assert.strictEqual(P.expandConfigPath('%CB_TEST_DIR%/proj'), 'C:\\data\\proj');
  assert.strictEqual(P.expandConfigPath('%NO_SUCH_VAR_CB%\\a'), '%NO_SUCH_VAR_CB%\\a');
  assert.strictEqual(P.expandConfigPath(''), null);
  assert.strictEqual(P.expandConfigPath(42), null);
});

test('isAcceptableRemoteForm rejects UNC, device, drive-relative, control chars', () => {
  assert.ok(P.isAcceptableRemoteForm('C:\\work'));
  assert.ok(P.isAcceptableRemoteForm('c:/work/repo'));
  for (const bad of ['\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '//server/share',
    'C:foo', 'work\\repo', '', 'C:\\a\u0000b', 42, null]) {
    assert.strictEqual(P.isAcceptableRemoteForm(bad), false, String(bad));
  }
});

test('canonical fixes case and returns null for missing', () => {
  const c = P.canonical(proj.toUpperCase());
  assert.strictEqual(c, proj);
  assert.strictEqual(P.canonical(path.join(tmp, 'nope')), null);
});

test('isInside: case-insensitive, drive root, different drive, sibling prefix', () => {
  assert.ok(P.isInside('C:\\Work', 'c:\\work\\repo'));
  assert.ok(P.isInside('C:\\Work', 'C:\\Work'));
  assert.ok(P.isInside('C:\\', 'C:\\anything\\x'));
  assert.strictEqual(P.isInside('C:\\Work', 'D:\\Work\\repo'), false);
  assert.strictEqual(P.isInside('C:\\Work', 'C:\\Work-secret'), false);
  assert.strictEqual(P.isInside('C:\\Work', 'C:\\Work\\..\\Secret'), false);
});

test('samePath ignores case, separators and trailing slash', () => {
  assert.ok(P.samePath('C:\\Work\\Repo\\', 'c:/work/repo'));
  assert.strictEqual(P.samePath('C:\\Work\\Repo', 'C:\\Work\\Repo2'), false);
  assert.strictEqual(P.samePath(null, 'C:\\x'), false);
});

test('resolveRemoteCwd: inside root -> canonical, otherwise fallback', () => {
  const roots = [path.join(tmp, 'work')];
  assert.strictEqual(P.resolveRemoteCwd(proj.toLowerCase(), roots, 'FALLBACK'), proj);
  assert.strictEqual(P.resolveRemoteCwd(outside, roots, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveRemoteCwd('\\\\localhost\\c$\\x', roots, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveRemoteCwd(path.join(tmp, 'work', 'missing'), roots, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveRemoteCwd('', roots, 'FALLBACK'), 'FALLBACK');
});

test('resolveRemoteCwd: junction inside root pointing outside is rejected', () => {
  const link = path.join(tmp, 'Work', 'escape');
  fs.symlinkSync(outside, link, 'junction');
  assert.strictEqual(P.resolveRemoteCwd(link, [path.join(tmp, 'Work')], 'FALLBACK'), 'FALLBACK');
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../lib/paths'`.

- [ ] **Step 3: Реализация** — `bridge/lib/paths.js`:

```js
'use strict';
// D-7: вся работа с путями моста — здесь. Только Windows (D-9).
const fs = require('fs');
const os = require('os');
const win = require('path').win32;

/** Путь из конфига: раскрыть ~ и %VAR%, принять / и \. Пустое/не строка -> null. */
function expandConfigPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = os.homedir() + s.slice(1);
  s = s.replace(/%([A-Za-z0-9_()]+)%/g, (m, name) =>
    (process.env[name] !== undefined ? process.env[name] : m));
  return win.normalize(s);
}

/** Форма пути, пришедшего по сети: только «X:\...». UNC, \\?\, \\.\, X:foo — нет. */
function isAcceptableRemoteForm(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (/[\x00-\x1f]/.test(p)) return false;
  const s = p.replace(/\//g, '\\');
  if (s.startsWith('\\\\')) return false;
  return /^[A-Za-z]:\\/.test(s);
}

/** Канонический путь от ОС: регистр, 8.3, junction, subst. Нет пути -> null. */
function canonical(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function isInside(root, p) {
  const rel = win.relative(win.resolve(root), win.resolve(p)); // relative на win32 регистронезависим
  if (rel === '') return true;
  if (win.isAbsolute(rel)) return false;                      // другой диск
  return rel !== '..' && !rel.startsWith('..\\');
}

function key(p) {
  return win.normalize(String(p)).replace(/\\+$/, '').toLowerCase();
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return key(a) === key(b);
}

/** cwd с телефона: допустимая форма + существует + внутри одного из корней; иначе fallback. */
function resolveRemoteCwd(cwd, roots, fallback) {
  if (!isAcceptableRemoteForm(cwd)) return fallback;
  const real = canonical(cwd);
  if (!real) return fallback;
  const ok = (roots || []).some((r) => {
    const rr = canonical(r);
    return rr && isInside(rr, real);
  });
  return ok ? real : fallback;
}

/** cwd владельца: без ограничений, но канонический (иначе --resume не найдёт беседы). */
function resolveLocalCwd(cwd, fallback) {
  if (typeof cwd !== 'string' || !cwd) return fallback;
  return canonical(cwd) || fallback;
}

module.exports = {
  expandConfigPath, isAcceptableRemoteForm, canonical, isInside, samePath,
  resolveRemoteCwd, resolveLocalCwd,
};
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/paths.test.js`
Expected: `# pass 7`. Если `fs.realpathSync.native` вернул путь с префиксом `\\?\` — тест `canonical` упадёт; тогда в `canonical` добавить `.replace(/^\\\\\?\\/, '')` и перезапустить.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/paths.js bridge/test/paths.test.js
git commit -m "feat(bridge): Windows path module (D-7)"
```

---

### Task 4: `tokens.js` и `origin.js` (P-1)

**Files:**
- Create: `bridge/lib/tokens.js`, `bridge/lib/origin.js`
- Test: `bridge/test/tokens.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../lib/tokens');
const { originAllowed } = require('../lib/origin');

test('owner token: created once, stable, rotatable', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tok-')), 'owner.token');
  const a = T.loadOrCreateOwnerToken(f);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(T.loadOrCreateOwnerToken(f), a);
  const b = T.rotateOwnerToken(f);
  assert.notStrictEqual(a, b);
  assert.strictEqual(T.loadOrCreateOwnerToken(f), b);
});

test('owner token: garbage in file is replaced', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-tok-')), 'owner.token');
  fs.writeFileSync(f, 'not-a-token');
  assert.match(T.loadOrCreateOwnerToken(f), /^[0-9a-f]{64}$/);
});

test('safeEq', () => {
  assert.ok(T.safeEq('abc', 'abc'));
  assert.strictEqual(T.safeEq('abc', 'abd'), false);
  assert.strictEqual(T.safeEq('abc', 'abcd'), false);
  assert.strictEqual(T.safeEq(undefined, 'x'), false);
});

test('one-time tokens: single use and expiry', () => {
  const o = new T.OneTimeTokens(50);
  const t = o.issue();
  assert.ok(o.consume(t));
  assert.strictEqual(o.consume(t), false);
  const t2 = o.issue();
  const until = Date.now() + 80;
  while (Date.now() < until) { /* ждём истечения */ }
  assert.strictEqual(o.consume(t2), false);
  assert.strictEqual(o.consume(123), false);
});

test('origin allowlist', () => {
  assert.ok(originAllowed(undefined, 8790));
  assert.ok(originAllowed('https://127.0.0.1:8790', 8790));
  assert.ok(originAllowed('https://localhost:8790', 8790));
  assert.ok(originAllowed('http://127.0.0.1:38471', 8790));
  for (const bad of ['null', 'https://evil.example', 'https://127.0.0.1:8791', 'http://127.0.0.1:8790', '']) {
    assert.strictEqual(originAllowed(bad, 8790), false, bad);
  }
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/tokens.test.js`
Expected: FAIL — `Cannot find module '../lib/tokens'`.

- [ ] **Step 3: Реализация** — `bridge/lib/tokens.js`:

```js
'use strict';
// P-1: токен владельца (файл в профиле) и одноразовые токены для входа браузера.
const fs = require('fs');
const crypto = require('crypto');

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function loadOrCreateOwnerToken(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch { /* нет файла — создадим */ }
  return rotateOwnerToken(file);
}

function rotateOwnerToken(file) {
  const t = newToken();
  fs.writeFileSync(file, t + '\n');
  return t;
}

class OneTimeTokens {
  constructor(ttlMs = 60000) { this.ttlMs = ttlMs; this.map = new Map(); }
  issue() {
    const t = newToken();
    this.map.set(t, Date.now() + this.ttlMs);
    return t;
  }
  consume(t) {
    if (typeof t !== 'string') return false;
    const now = Date.now();
    for (const [k, exp] of this.map) if (exp < now) this.map.delete(k);
    for (const k of this.map.keys()) {
      if (safeEq(k, t)) { this.map.delete(k); return true; }
    }
    return false;
  }
}

module.exports = { safeEq, newToken, loadOrCreateOwnerToken, rotateOwnerToken, OneTimeTokens };
```

`bridge/lib/origin.js`:

```js
'use strict';
// P-1: второй слой против H-1 (CSWSH). Браузер всегда шлёт Origin; CLI-клиенты — нет.
const WEBVIEW_ORIGIN = 'http://127.0.0.1:38471'; // LocalGateway в Android-приложении

function originAllowed(origin, port) {
  if (origin === undefined) return true;
  return origin === `https://127.0.0.1:${port}` ||
    origin === `https://localhost:${port}` ||
    origin === WEBVIEW_ORIGIN;
}

module.exports = { originAllowed, WEBVIEW_ORIGIN };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/tokens.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/tokens.js bridge/lib/origin.js bridge/test/tokens.test.js
git commit -m "feat(bridge): owner/one-time tokens and Origin allowlist (P-1)"
```

---

### Task 5: `cert.js` — сертификат без openssl (P-4)

**Files:**
- Create: `bridge/lib/cert.js`
- Test: `bridge/test/cert.test.js`

- [ ] **Step 1: Тест** (запускает PowerShell; ~5–10 с)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { loadOrCreateCert, pinnedTlsOptions } = require('../lib/cert');

test('generate, reload, serve, pin', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cert-'));
  const a = loadOrCreateCert(dir);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  const b = loadOrCreateCert(dir);
  assert.strictEqual(b.fingerprint, a.fingerprint, 'second call reuses files');
  const der = new crypto.X509Certificate(a.certPem).raw;
  assert.strictEqual(crypto.createHash('sha256').update(der).digest('hex'), a.fingerprint);

  const srv = https.createServer(a.tls, (req, res) => res.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (opts) => new Promise((resolve) => {
    https.get({ host: '127.0.0.1', port, path: '/', agent: false, ...opts }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s));
    }).on('error', (e) => resolve('ERR ' + e.message));
  });
  assert.strictEqual(await get(pinnedTlsOptions(a.certPem, a.fingerprint)), 'ok');
  assert.match(await get(pinnedTlsOptions(a.certPem, '0'.repeat(64))), /^ERR/);
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/cert.test.js`
Expected: FAIL — `Cannot find module '../lib/cert'`.

- [ ] **Step 3: Реализация** — `bridge/lib/cert.js`:

```js
'use strict';
// P-4: самоподписанный сертификат без openssl — PowerShell New-SelfSignedCertificate,
// экспорт в PFX (ключ) и CER (DER, для отпечатка), удаление из хранилища Windows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PS = `
$ErrorActionPreference = 'Stop'
$c = New-SelfSignedCertificate -Subject 'CN=claude-bridge' -KeyAlgorithm RSA -KeyLength 2048 \`
  -NotAfter (Get-Date).AddYears(10) -CertStoreLocation 'Cert:\\CurrentUser\\My' \`
  -KeyExportPolicy Exportable -KeyUsage DigitalSignature, KeyEncipherment \`
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
try {
  $p = ConvertTo-SecureString -String $env:CB_PFX_PASS -Force -AsPlainText
  Export-PfxCertificate -Cert $c -FilePath $env:CB_PFX -Password $p | Out-Null
  Export-Certificate -Cert $c -FilePath $env:CB_CER -Type CERT | Out-Null
} finally {
  Remove-Item -Path ('Cert:\\CurrentUser\\My\\' + $c.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
}
`;

function files(dir) {
  return {
    pfx: path.join(dir, 'bridge.pfx'),
    cer: path.join(dir, 'bridge.cer'),
    pass: path.join(dir, 'bridge.pass'),
  };
}

function generate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = files(dir);
  const pass = crypto.randomBytes(24).toString('hex');
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
      env: { ...process.env, CB_PFX: f.pfx, CB_CER: f.cer, CB_PFX_PASS: pass },
      encoding: 'utf8', windowsHide: true,
    });
  if (r.status !== 0) throw new Error('генерация сертификата не удалась: ' + (r.stderr || r.stdout));
  fs.writeFileSync(f.pass, pass);
}

function loadOrCreateCert(dir) {
  const f = files(dir);
  if (!fs.existsSync(f.pfx) || !fs.existsSync(f.cer) || !fs.existsSync(f.pass)) generate(dir);
  const der = fs.readFileSync(f.cer);
  const certPem = new crypto.X509Certificate(der).toString();
  return {
    tls: { pfx: fs.readFileSync(f.pfx), passphrase: fs.readFileSync(f.pass, 'utf8').trim() },
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
    certPem,
  };
}

/** TLS-опции клиента: доверять только этому сертификату (M-8). Имя хоста не проверяем — пиннинг.
 * Важно: использовать с новым соединением (agent: false / ws) — при переиспользовании
 * keep-alive сокета рукопожатие и проверка отпечатка не повторяются. */
function pinnedTlsOptions(certPem, fingerprint) {
  const want = fingerprint.toLowerCase();
  return {
    ca: certPem,
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) => {
      const got = String(cert.fingerprint256 || '').replace(/:/g, '').toLowerCase();
      return got === want ? undefined : new Error('отпечаток сертификата моста не совпадает');
    },
  };
}

module.exports = { loadOrCreateCert, pinnedTlsOptions };
```

- [ ] **Step 4: Тест проходит**

Run: `cd bridge && node --test test/cert.test.js`
Expected: `# pass 1`. Если OpenSSL в Node отвергает самоподписанный лист как CA (`unable to verify the first certificate`), добавить в `pinnedTlsOptions` `rejectUnauthorized: false` и проверку отпечатка перенести в обработчик `secureConnect` (`socket.getPeerCertificate().fingerprint256`) — и обновить тест на этот вариант.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/cert.js bridge/test/cert.test.js
git commit -m "feat(bridge): self-signed cert via PowerShell, pinned client TLS (P-4, M-8)"
```

---

### Task 6: `keeper-channel.js` — pipe и рукопожатие (D-11)

**Files:**
- Create: `bridge/lib/keeper-channel.js`
- Test: `bridge/test/keeper-channel.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const K = require('../lib/keeper-channel');

function startServer(secret) {
  const pipe = K.pipeName();
  const got = [];
  const srv = net.createServer((sock) => {
    K.acceptAuthenticated(sock, secret, (s) => {
      K.send(s, { t: 'hello', buffer: 'SCREEN' });
      return (m) => got.push(m);
    });
  });
  return new Promise((r) => srv.listen(pipe, () => r({ srv, pipe, got })));
}

test('pipe name is random and in pipe namespace', () => {
  const a = K.pipeName();
  assert.match(a, /^\\\\\.\\pipe\\claude-bridge-[0-9a-f]{32}$/);
  assert.notStrictEqual(a, K.pipeName());
});

test('correct secret: hello delivered, messages flow', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const { srv, pipe, got } = await startServer(secret);
  const ch = await K.connectAuthenticated(pipe, secret);
  const first = await new Promise((r) => ch.onMessage(r));
  assert.deepStrictEqual(first, { t: 'hello', buffer: 'SCREEN' });
  ch.send({ t: 'in', d: 'x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(got, [{ t: 'in', d: 'x' }]);
  ch.socket.destroy(); srv.close();
});

test('wrong secret: rejected, nothing leaked', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const { srv, pipe, got } = await startServer(secret);
  await assert.rejects(K.connectAuthenticated(pipe, crypto.randomBytes(32).toString('hex')));
  assert.deepStrictEqual(got, []);
  srv.close();
});

test('raw client gets only the challenge and is dropped on garbage', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const { srv, pipe, got } = await startServer(secret);
  const raw = net.connect(pipe);
  let data = '';
  raw.on('data', (d) => (data += d));
  raw.on('error', () => {});
  await new Promise((r) => setTimeout(r, 150));
  raw.write('{"t":"in","d":"evil"}\n');
  await new Promise((r) => raw.on('close', r));
  assert.match(data, /"t":"challenge"/);
  assert.doesNotMatch(data, /SCREEN/);
  assert.deepStrictEqual(got, []);
  srv.close();
});

test('impostor server without secret is detected by client', async () => {
  const pipe = K.pipeName();
  const srv = net.createServer((s) => {
    K.send(s, { t: 'challenge', nonce: crypto.randomBytes(32).toString('hex') });
    s.on('data', () => K.send(s, { t: 'auth-ok', mac: '0'.repeat(64) }));
    s.on('error', () => {});
  });
  await new Promise((r) => srv.listen(pipe, r));
  await assert.rejects(K.connectAuthenticated(pipe, crypto.randomBytes(32).toString('hex')));
  srv.close();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/keeper-channel.test.js`
Expected: FAIL — `Cannot find module '../lib/keeper-channel'`.

- [ ] **Step 3: Реализация** — `bridge/lib/keeper-channel.js`:

```js
'use strict';
// D-11: канал мост<->keeper. Named pipe доступен по SMB (проверено в P-5),
// поэтому keeper ничего не отдаёт без HMAC-доказательства знания секрета сессии,
// а мост в ответ проверяет, что говорит с настоящим keeper'ом.
const net = require('net');
const crypto = require('crypto');

const HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_LINE_BUFFER = 8 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

function pipeName() {
  return '\\\\.\\pipe\\claude-bridge-' + crypto.randomBytes(16).toString('hex');
}

function mac(secret, label, nonce) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(label + '|' + nonce).digest('hex');
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

function readLines(socket, onLine) {
  let acc = '';
  socket.on('data', (chunk) => {
    acc += chunk.toString('utf8');
    if (acc.length > MAX_LINE_BUFFER) { socket.destroy(); return; }
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object') onLine(m);
    }
  });
}

/** Сторона keeper'а. onAuthed(socket) возвращает обработчик сообщений после рукопожатия. */
function acceptAuthenticated(socket, secret, onAuthed) {
  const nonce = crypto.randomBytes(32).toString('hex');
  let handler = null;
  let authed = false;
  const timer = setTimeout(() => { if (!authed) socket.destroy(); }, HANDSHAKE_TIMEOUT_MS);
  socket.on('error', () => {});
  socket.on('close', () => clearTimeout(timer));
  readLines(socket, (m) => {
    if (authed) { if (handler) handler(m); return; }
    if (m.t === 'auth' && HEX64.test(m.nonce || '') && eq(m.mac, mac(secret, 'client', nonce))) {
      authed = true;
      clearTimeout(timer);
      send(socket, { t: 'auth-ok', mac: mac(secret, 'server', m.nonce) });
      handler = onAuthed(socket) || null;
    } else {
      socket.destroy();
    }
  });
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
    readLines(socket, (m) => {
      if (stage === 'ready') { if (handler) handler(m); else pending.push(m); return; }
      if (stage === 'challenge' && m.t === 'challenge' && HEX64.test(m.nonce || '')) {
        send(socket, { t: 'auth', mac: mac(secret, 'client', m.nonce), nonce });
        stage = 'await-ok';
        return;
      }
      if (stage === 'await-ok' && m.t === 'auth-ok' && eq(m.mac, mac(secret, 'server', nonce))) {
        stage = 'ready';
        clearTimeout(timer);
        resolve({
          socket,
          send: (obj) => send(socket, obj),
          onMessage: (fn) => { handler = fn; while (pending.length) fn(pending.shift()); },
        });
        return;
      }
      fail(new Error('keeper: рукопожатие не прошло'));
    });
  });
}

module.exports = { pipeName, acceptAuthenticated, connectAuthenticated, send, readLines };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/keeper-channel.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/keeper-channel.js bridge/test/keeper-channel.test.js
git commit -m "feat(bridge): authenticated named-pipe channel to keeper (D-11)"
```

---

### Task 7: `which.js` — запуск команд в ConPTY

**Files:**
- Create: `bridge/lib/which.js`
- Test: `bridge/test/which.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveSpawn } = require('../lib/which');

test('absolute exe is used as-is', () => {
  const r = resolveSpawn(process.execPath, ['-v']);
  assert.strictEqual(r.file, process.execPath);
  assert.deepStrictEqual(r.args, ['-v']);
});

test('bare name is found on PATH with PATHEXT', () => {
  const r = resolveSpawn('node', ['-v']);
  assert.match(r.file, /node\.exe$/i);
});

test('.cmd shims are wrapped in cmd.exe /d /s /c', () => {
  const r = resolveSpawn('npm', ['-v']);
  assert.match(r.file, /cmd\.exe$/i);
  assert.deepStrictEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(r.args[3], /npm\.cmd/i);
});

test('missing command throws', () => {
  assert.throws(() => resolveSpawn('definitely-not-a-command-cb', []), /не найдена/);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/which.test.js`
Expected: FAIL — `Cannot find module '../lib/which'`.

- [ ] **Step 3: Реализация** — `bridge/lib/which.js`:

```js
'use strict';
// node-pty на Windows запускает файл через CreateProcess: нужен реальный .exe.
// npm-шимы (.cmd) запускаются через cmd.exe. Аргументы с телефона формирует мост
// из id опций (P-3), поэтому интерпретация cmd.exe не открывает инъекцию с телефона.
const fs = require('fs');
const path = require('path');

function findOnPath(name) {
  const exts = path.extname(name)
    ? ['']
    : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = path.isAbsolute(name) ? [''] : (process.env.PATH || '').split(';').filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.isAbsolute(name) ? name + e : path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* дальше */ }
    }
  }
  return null;
}

function resolveSpawn(command, args) {
  const file = findOnPath(command);
  if (!file) throw new Error(`команда не найдена: ${command}`);
  if (/\.(cmd|bat)$/i.test(file)) {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', `"${file}"`, ...args] };
  }
  return { file, args };
}

module.exports = { resolveSpawn, findOnPath };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/which.test.js`
Expected: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/which.js bridge/test/which.test.js
git commit -m "feat(bridge): resolve executables for ConPTY spawn"
```

---

### Task 8: `keeper.js` на named pipe

**Files:**
- Modify: `bridge/keeper.js` (полная замена)
- Test: `bridge/test/keeper.test.js`

- [ ] **Step 1: Интеграционный тест** (реальный отсоединённый keeper + ConPTY)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const K = require('../lib/keeper-channel');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('detached keeper: authenticated attach, output, input, kill', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-keeper-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const meta = {
    id: 's1-test', cmd: process.execPath,
    args: ['-e', "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
    cwd: dir, cols: 80, rows: 24, scrollbackBytes: 65536, pipe: K.pipeName(), secret,
  };
  const metaPath = path.join(dir, 's1-test.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const k = spawn(process.execPath, [path.join(__dirname, '..', 'keeper.js'), metaPath],
    { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, CLAUDE_BRIDGE_KEEPER_SECRET: secret } });
  k.unref();

  let ch = null;
  for (let i = 0; i < 40 && !ch; i++) {
    await sleep(150);
    ch = await K.connectAuthenticated(meta.pipe, secret).catch(() => null);
  }
  assert.ok(ch, 'connected to keeper');
  const msgs = [];
  ch.onMessage((m) => msgs.push(m));
  await sleep(300);
  assert.strictEqual(msgs[0].t, 'hello');
  ch.send({ t: 'in', d: 'ping\r' });
  await sleep(800);
  assert.ok(msgs.some((m) => m.t === 'out' && m.d.includes('ECHO:ping')), 'echo received');
  ch.send({ t: 'kill' });
  await sleep(1500);
  assert.ok(msgs.some((m) => m.t === 'exit'), 'exit received');
  assert.strictEqual(fs.existsSync(metaPath), false, 'meta removed');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/keeper.test.js`
Expected: FAIL — `connected to keeper` (старый keeper слушает `.sock`-путь, а не pipe).

- [ ] **Step 3: Новый `bridge/keeper.js`**

```js
#!/usr/bin/env node
'use strict';
// Хранитель сессии: отдельный отсоединённый процесс, владеет PTY (ConPTY) и
// переживает перезапуск моста. Канал к мосту — named pipe с рукопожатием (D-11).
const fs = require('fs');
const net = require('net');
const path = require('path');
const pty = require(path.join(__dirname, 'node_modules', 'node-pty'));
const K = require('./lib/keeper-channel');
const { resolveSpawn } = require('./lib/which');

const metaPath = process.argv[2];
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const secret = process.env.CLAUDE_BRIDGE_KEEPER_SECRET || meta.secret;
// секрет канала не должен попасть в окружение агента
delete process.env.CLAUDE_BRIDGE_KEEPER_SECRET;

const { file, args } = resolveSpawn(meta.cmd, meta.args || []);
const term = pty.spawn(file, args, {
  name: 'xterm-256color',
  cols: meta.cols || 100,
  rows: meta.rows || 30,
  cwd: meta.cwd,
  env: process.env,
});

const LIMIT = meta.scrollbackBytes || 262144;
let buffer = [];
let bytes = 0;
const clients = new Set();

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

const srv = net.createServer((sock) => {
  K.acceptAuthenticated(sock, secret, (c) => {
    clients.add(c);
    c.on('close', () => clients.delete(c));
    K.send(c, { t: 'hello', buffer: buffer.join(''), cols: term.cols, rows: term.rows, pid: term.pid });
    return (m) => {
      if (m.t === 'in' && typeof m.d === 'string') term.write(m.d);
      else if (m.t === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) &&
        m.cols > 0 && m.rows > 0 && m.cols <= 1000 && m.rows <= 1000) {
        try { term.resize(m.cols, m.rows); } catch { /* PTY уже закрыт */ }
      } else if (m.t === 'kill') {
        try { term.kill(); } catch { /* уже завершён */ }
      }
    };
  });
});
srv.on('error', () => process.exit(1));
srv.listen(meta.pipe);
```

- [ ] **Step 4: Тест проходит**

Run: `cd bridge && node --test test/keeper.test.js`
Expected: `# pass 1`.

- [ ] **Step 5: Commit**

```bash
git add bridge/keeper.js bridge/test/keeper.test.js
git commit -m "feat(bridge): keeper over authenticated named pipe (D-11)"
```

---

### Task 9: `validate.js` и `log.js` (P-10)

**Files:**
- Create: `bridge/lib/validate.js`, `bridge/lib/log.js`
- Test: `bridge/test/validate.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/validate');

test('wsMessage: only objects with string type', () => {
  assert.strictEqual(V.wsMessage(null), null);
  assert.strictEqual(V.wsMessage(5), null);
  assert.strictEqual(V.wsMessage({ type: 1 }), null);
  assert.deepStrictEqual(V.wsMessage({ type: 'list' }), { type: 'list' });
});

test('str / int / sessionId / nodeId', () => {
  assert.strictEqual(V.str(5), null);
  assert.strictEqual(V.str('a'.repeat(10), 5), null);
  assert.strictEqual(V.str('abc', 5), 'abc');
  assert.strictEqual(V.int('5', 1, 10), null);
  assert.strictEqual(V.int(5, 1, 10), 5);
  assert.strictEqual(V.int(50, 1, 10), null);
  assert.strictEqual(V.sessionId('s12-a1b2c3'), 's12-a1b2c3');
  assert.strictEqual(V.sessionId('../x'), null);
  assert.strictEqual(V.nodeId('A'.repeat(64)), 'a'.repeat(64));
  assert.strictEqual(V.nodeId(7), null);
});

test('cleanTitle strips control chars and limits length', () => {
  assert.strictEqual(V.cleanTitle('\x1b[2Jhi\x07'), '[2Jhi');
  assert.strictEqual(V.cleanTitle(5), null);
  assert.strictEqual(V.cleanTitle('x'.repeat(200)).length, 120);
});

test('pairBody', () => {
  assert.strictEqual(V.pairBody(null), null);
  assert.strictEqual(V.pairBody({ code: 1 }), null);
  assert.deepStrictEqual(V.pairBody({ code: 'ab12', name: 'Phone' }), { code: 'AB12', name: 'Phone' });
});

test('cookieToken accepts only 64/48 hex', () => {
  assert.strictEqual(V.cookieToken('x;Domain=evil'), null);
  assert.strictEqual(V.cookieToken('a'.repeat(48)), 'a'.repeat(48));
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/validate.test.js`
Expected: FAIL — `Cannot find module '../lib/validate'`.

- [ ] **Step 3: Реализация** — `bridge/lib/validate.js`:

```js
'use strict';
// P-10: проверка типов всех входов (M-2, L-1, L-2, L-8). Каждая функция
// возвращает нормализованное значение или null.
function wsMessage(m) {
  return m && typeof m === 'object' && !Array.isArray(m) && typeof m.type === 'string' ? m : null;
}
function str(v, max = 1 << 20) {
  return typeof v === 'string' && v.length <= max ? v : null;
}
function int(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}
function sessionId(v) {
  return typeof v === 'string' && /^s\d{1,9}-[0-9a-f]{6}$/.test(v) ? v : null;
}
function nodeId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}
function cleanTitle(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 120);
}
function pairBody(p) {
  if (!p || typeof p !== 'object' || typeof p.code !== 'string' || p.code.length > 64) return null;
  return { code: p.code.toUpperCase(), name: typeof p.name === 'string' ? p.name : '' };
}
function cookieToken(v) {
  return typeof v === 'string' && /^[0-9a-f]{48}$|^[0-9a-f]{64}$/.test(v) ? v : null;
}
module.exports = { wsMessage, str, int, sessionId, nodeId, cleanTitle, pairBody, cookieToken };
```

`bridge/lib/log.js`:

```js
'use strict';
// У моста на Windows нет консоли (запуск из Планировщика): console.* дублируется в файл.
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 5 * 1024 * 1024;

function installFileLog(logDir) {
  const file = path.join(logDir, 'bridge.log');
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${util.format(...args)}\n`;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, line);
    } catch { /* лог не должен ронять мост */ }
  };
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { write('INFO', a); origLog(...a); };
  console.error = (...a) => { write('ERROR', a); origErr(...a); };
  process.on('uncaughtException', (e) => { write('FATAL', [e && e.stack || e]); process.exit(1); });
  return file;
}

module.exports = { installFileLog };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/validate.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/validate.js bridge/lib/log.js bridge/test/validate.test.js
git commit -m "feat(bridge): input validation and file log (P-10)"
```

---

### Task 10: `server.js` — данные, сертификат, аутентификация, Origin

**Files:**
- Modify: `bridge/server.js:1-227` и `:625-840`, `:840-880`
- Test: `bridge/test/server-auth.test.js`

Мост должен запускаться в тестах с изолированным каталогом данных и своими портами. Для этого `server.js` читает `CLAUDE_BRIDGE_HOME` (через `datadir.js`) и `CLAUDE_BRIDGE_PORT` (переопределяет `config.port`), а при `CLAUDE_BRIDGE_TEST=1` не публикует mDNS и не печатает QR.

- [ ] **Step 1: Интеграционный тест аутентификации**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { pinnedTlsOptions } = require('../lib/cert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-srv-'));
const port = 18790 + Math.floor(Math.random() * 500) * 3;
let proc;
let pin;
let owner;

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TEST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(home, 'owner.token')); i++) await sleep(200);
  await sleep(1500);
  owner = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
  const certPem = new (require('crypto').X509Certificate)(fs.readFileSync(path.join(home, 'certs', 'bridge.cer'))).toString();
  const fp = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(home, 'certs', 'bridge.cer'))).digest('hex');
  pin = pinnedTlsOptions(certPem, fp);
});
test.after(() => { try { proc.kill(); } catch {} fs.rmSync(home, { recursive: true, force: true }); });

function wsOpen(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers });
    ws.on('message', (d) => { resolve({ ok: true, msg: JSON.parse(d) }); ws.close(); });
    ws.on('unexpected-response', (req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false, status: 'error' }));
  });
}

test('ws without token is refused before upgrade', async () => {
  const r = await wsOpen({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
});

test('ws with owner token works', async () => {
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.msg.type, 'sessions');
});

test('ws with owner token but foreign Origin is refused (H-1)', async () => {
  const r = await wsOpen({ Authorization: 'Bearer ' + owner, Origin: 'https://evil.example' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
});

test('POST /pair with null body does not crash the bridge (M-2)', async () => {
  const status = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/pair', method: 'POST', ...pin },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('error'));
    req.end('null');
  });
  assert.strictEqual(status, 400);
  const r = await wsOpen({ Authorization: 'Bearer ' + owner });
  assert.strictEqual(r.ok, true, 'bridge still alive');
});

test('one-time token login sets cookie and redirects', async () => {
  const ott = await new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers: { Authorization: 'Bearer ' + owner } });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'issueLoginToken' })));
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'loginToken') { resolve(m.token); ws.close(); } });
  });
  const res = await new Promise((resolve) => {
    https.get({ host: '127.0.0.1', port, path: '/?ott=' + ott, ...pin }, resolve);
  });
  assert.strictEqual(res.statusCode, 302);
  assert.match(String(res.headers['set-cookie']), /bridgeToken=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  res.resume();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/server-auth.test.js`
Expected: FAIL — мост не создаёт `owner.token` в `CLAUDE_BRIDGE_HOME` (старый `server.js` пишет в `bridge/`).

- [ ] **Step 3: Заменить начало `server.js` (строки 1–227)**

Заменить блок от `const CONFIG_PATH = ...` (строка 15) до конца функции `revokeDeviceById` (строка 227) на:

```js
const { ensureDataDirs } = require('./lib/datadir');
const P = require('./lib/paths');
const T = require('./lib/tokens');
const V = require('./lib/validate');
const { originAllowed } = require('./lib/origin');
const { loadOrCreateCert } = require('./lib/cert');
const { installFileLog } = require('./lib/log');

const DATA = ensureDataDirs();
if (!process.env.CLAUDE_BRIDGE_TEST) installFileLog(DATA.logs);

// Конфиг живёт в каталоге данных (D-9: без миграции старого bridge/config.json).
if (!fs.existsSync(DATA.config)) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), DATA.config);
  console.log('  Создан ' + DATA.config + ' — отредактируйте его при необходимости');
}
const CONFIG = JSON.parse(fs.readFileSync(DATA.config, 'utf8'));
if (process.env.CLAUDE_BRIDGE_PORT) CONFIG.port = parseInt(process.env.CLAUDE_BRIDGE_PORT, 10);
CONFIG.projects = (CONFIG.projects || []).map(P.expandConfigPath).filter(Boolean);
CONFIG.defaultCwd = P.expandConfigPath(CONFIG.defaultCwd || '') || os.homedir();

const WEB_DIR = path.join(__dirname, 'web');
const VENDOR = {
  '/vendor/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};
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

const CERT = loadOrCreateCert(DATA.certs);
const TLS = CERT.tls;
const FINGERPRINT = CERT.fingerprint;

// Токен владельца (P-1): полные локальные права. Файл в профиле пользователя (D-8).
let OWNER_TOKEN = T.loadOrCreateOwnerToken(DATA.ownerToken);
const loginTokens = new T.OneTimeTokens(60000);

let pairings = { devices: [] };
try { pairings = JSON.parse(fs.readFileSync(DATA.pairings, 'utf8')); } catch { /* первый запуск */ }
const PAIR_TTL_MS = 10 * 60 * 1000;
let pairState = { code: '', expiresAt: 0 };
const pairGuard = new Map(); // ip -> { fails, blockedUntil }
let pairFailTotal = 0;
const PAIR_FAIL_TOTAL_MAX = 50;
function regenPairCode() {
  pairFailTotal = 0;
  pairState = {
    code: crypto.randomBytes(5).toString('hex').toUpperCase(),
    expiresAt: Date.now() + PAIR_TTL_MS,
  };
  return pairState;
}
// Код сопряжения НЕ выпускается при старте: только по подтверждённому запросу владельца (P-9).
pairState = { code: '', expiresAt: 0 };

function deviceIdOf(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}
for (const d of pairings.devices) if (!d.id) d.id = deviceIdOf(d.token);

function savePairings() {
  fs.writeFileSync(DATA.pairings, JSON.stringify(pairings, null, 2));
}

function bearer(req) {
  const h = req.headers.authorization;
  const m = typeof h === 'string' && h.match(/^Bearer ([0-9a-f]{48,64})$/);
  return m ? m[1] : null;
}
function cookieTokenOf(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)bridgeToken=([0-9a-f]+)/);
  return m ? V.cookieToken(m[1]) : null;
}
function requestToken(req) {
  return bearer(req) || cookieTokenOf(req);
}
function deviceByToken(t) {
  if (!t) return null;
  for (const d of pairings.devices) if (T.safeEq(d.token, t)) return d;
  return null;
}
/** Владелец: токен владельца + loopback + основной порт (не туннель). */
function isOwner(req) {
  const a = req.socket.remoteAddress;
  const loopback = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  if (!loopback || req.socket.localPort !== CONFIG.port) return false;
  return T.safeEq(requestToken(req) || '', OWNER_TOKEN);
}
/** Кто это: 'owner' | устройство | null. Origin проверяется отдельно. */
function principal(req) {
  if (isOwner(req)) return 'owner';
  return deviceByToken(requestToken(req));
}
function revokeDeviceById(id) {
  const idx = pairings.devices.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  const name = pairings.devices[idx].name;
  pairings.devices.splice(idx, 1);
  savePairings();
  writeAllowFile();
  console.log(`\n  Устройство отозвано: ${name}`);
  for (const c of allClients) {
    if (c.deviceId === id) { try { c.close(4401, 'revoked'); } catch { /* закрыт */ } }
  }
  if (tunnel && inet.enabled) { stopTunnel(); startTunnel(); }
  return true;
}
```

Также удалить из верхних `require` неиспользуемое `execSync` (оставить `spawn, spawnSync`).

- [ ] **Step 4: HTTP-обработчик — Origin, `/pair`, `/hook`, статика, вход по ott**

В `httpHandler` (начало функции, сразу после `const url = new URL(req.url, 'http://x');`) вставить:

```js
  if (!originAllowed(req.headers.origin, CONFIG.port)) {
    res.writeHead(403); res.end(); return;
  }
```

В обработчике `/pair` заменить разбор тела (`let p = {}; try { p = JSON.parse(body || '{}'); } catch {}`) и проверку кода на:

```js
      let raw = null;
      try { raw = JSON.parse(body || 'null'); } catch { /* невалидный JSON */ }
      const p = V.pairBody(raw);
      if (!p) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"неверный запрос"}');
        return;
      }
```

и строку сравнения кода — на `if (!T.safeEq(p.code, pairState.code)) {`. В ответе `/pair` поле `hostname: os.hostname()` оставить (код уже проверен).

В обработчике `/stt`: `if (!authed(req, url))` → `if (!principal(req))`.

Обработчик `/hook` полностью заменить (авторизация — токен хука сессии, задача 12 добавит его выдачу):

```js
  if (req.method === 'POST' && url.pathname === '/hook') {
    const sid = V.sessionId(req.headers['x-bridge-session']);
    const s = sid ? sessions.get(sid) : null;
    const tok = bearer(req);
    if (!s || !tok || !T.safeEq(tok, s.hookToken || '')) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body || 'null'); } catch { /* невалидный JSON */ }
      if (!payload || typeof payload !== 'object') { res.writeHead(400); res.end(); return; }
      const event = V.str(payload.hook_event_name, 64) || 'Notification';
      const message = V.str(payload.message, 2000) || (event === 'Stop' ? 'Claude завершил ответ' : 'Событие Claude Code');
      const status = { UserPromptSubmit: 'working', PostToolUse: 'working', Notification: 'waiting', Stop: 'idle' }[event];
      if (status && s.status !== status) {
        broadcast({ type: 'status', id: sid, status });
        s.status = status;
        broadcastSessions();
      }
      if (event === 'Notification' || event === 'Stop') {
        s.lastNotify = { event, message, at: Date.now() };
        broadcast({ type: 'notify', id: sid, event, message, title: s.title, at: Date.now() });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
```

`/health`: `if (!authed(req, url))` → `if (!principal(req))`.

Статику (от комментария `// static:` до конца `fs.readFile`) заменить на:

```js
  // вход браузера владельца по одноразовому токену: cookie + redirect (L-9)
  const ott = url.searchParams.get('ott');
  if (ott !== null) {
    if (!loginTokens.consume(ott)) { res.writeHead(401); res.end(); return; }
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `bridgeToken=${OWNER_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      ...SEC_HEADERS,
    });
    res.end();
    return;
  }
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
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SEC_HEADERS });
    res.end(data);
  });
```

- [ ] **Step 5: WebSocket — авторизация до апгрейда, лимиты (M-3, H-1)**

Заменить блок от `const wss = new WebSocketServer({ noServer: true });` до строки `ws.deviceId = dev ? dev.id : (isLocal(req) ? 'local' : null);` включительно на:

```js
const MAX_WS_CLIENTS = 64;
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
function handleUpgrade(req, sock, head) {
  const url = new URL(req.url, 'http://x');
  const reject = (code) => { try { sock.end(`HTTP/1.1 ${code} x\r\nConnection: close\r\n\r\n`); } catch { /* */ } sock.destroy(); };
  if (url.pathname !== '/ws') return reject(404);
  if (!originAllowed(req.headers.origin, CONFIG.port)) return reject(403);
  const who = principal(req);
  if (!who) return reject(401);
  if (allClients.size >= MAX_WS_CLIENTS) return reject(503);
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req, who));
}
server.on('upgrade', handleUpgrade);
tunnelServer.on('upgrade', handleUpgrade);
const allClients = new Set();
```

…(функции `broadcast`, `broadcastSessions`, `devicesMsg` без изменений)…

```js
wss.on('connection', (ws, req, who) => {
  ws.on('error', () => { /* необработанная ошибка ws не должна ронять мост */ });
  ws.deviceId = who === 'owner' ? 'local' : who.id;
```

(значение `'local'` сохраняется как имя роли владельца, чтобы не трогать остальные проверки `ws.deviceId === 'local'` в этом подплане.)

В обработчике `ws.on('message', (raw) => {` заменить первые строки на:

```js
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    const m = V.wsMessage(parsed);
    if (!m) return;
    const sid = V.sessionId(m.id);
    const s = sid ? sessions.get(sid) : null;
```

В ветке `create` заменить `title: m.title` на `title: V.cleanTitle(m.title)`, `cwd: m.cwd` на `cwd: V.str(m.cwd, 1024)`, `args: m.args` на `args: Array.isArray(m.args) && m.args.every((a) => typeof a === 'string') ? m.args : []`, `command: m.command` на `command: V.str(m.command, 1024)`.

В ветке `input`/`scroll`: `keeperSend(s, { t: 'in', d: m.data })` → `const d = V.str(m.data, 65536); if (d !== null) keeperSend(s, { t: 'in', d });`.

В ветке `resize`/`attach`: `m.cols`/`m.rows` пропускать через `V.int(m.cols, 1, 1000)` / `V.int(m.rows, 1, 1000)`.

В ветке `registerNode`: `const nid = (m.nodeId || '').trim().toLowerCase();` → `const nid = V.nodeId(m.nodeId) || '';`.

Добавить новые ветки (только владелец):

```js
      case 'issueLoginToken':
        if (ws.deviceId === 'local') ws.send(JSON.stringify({ type: 'loginToken', token: loginTokens.issue(), port: CONFIG.port }));
        break;
      case 'rotateOwnerToken':
        if (ws.deviceId === 'local') {
          OWNER_TOKEN = T.rotateOwnerToken(DATA.ownerToken);
          for (const c of allClients) if (c.deviceId === 'local') { try { c.close(4401, 'owner token rotated'); } catch { /* */ } }
        }
        break;
```

Удалить функции `procIpv4`, `norm4`, `peerUid`, `isLocal`, `authed`, `safeEqStr` и константу `SELF_UID` — все вызовы заменены выше. Проверить: `grep -n "isLocal\|authed(\|peerUid\|safeEqStr" bridge/server.js` → пусто.

- [ ] **Step 6: Тесты проходят**

Run: `cd bridge && node --test test/server-auth.test.js`
Expected: `# pass 5`.

- [ ] **Step 7: Commit**

```bash
git add bridge/server.js bridge/test/server-auth.test.js
git commit -m "feat(bridge): owner token auth, Origin check, auth before WS upgrade, ott login (D-1, P-1, M-2, M-3)"
```

---

### Task 11: `server.js` — сессии через keeper по pipe, пути D-7

**Files:**
- Modify: `bridge/server.js:229-467`
- Test: `bridge/test/server-sessions.test.js`

- [ ] **Step 1: Интеграционный тест сессии**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { pinnedTlsOptions } = require('../lib/cert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sess-'));
const port = 19790 + Math.floor(Math.random() * 500) * 3;
const env = { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TEST: '1' };
let proc, pin, owner;

function startBridge() {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore', windowsHide: true });
}
async function connect() {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers: { Authorization: 'Bearer ' + owner } });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return { ws, msgs, send: (o) => ws.send(JSON.stringify(o)) };
}

test.before(async () => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', claudeCommand: process.execPath,
    claudeArgs: ['-e', "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
    defaultCwd: home, projects: [home], env: {}, scrollbackBytes: 65536,
  }));
  startBridge();
  for (let i = 0; i < 100 && !fs.existsSync(path.join(home, 'owner.token')); i++) await sleep(200);
  await sleep(1500);
  owner = fs.readFileSync(path.join(home, 'owner.token'), 'utf8').trim();
  const der = fs.readFileSync(path.join(home, 'certs', 'bridge.cer'));
  pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), crypto.createHash('sha256').update(der).digest('hex'));
});
test.after(async () => {
  try { proc.kill(); } catch {}
  await sleep(300);
  fs.rmSync(home, { recursive: true, force: true });
});

test('session survives bridge restart', { timeout: 60000 }, async () => {
  let c = await connect();
  c.send({ type: 'create', cwd: home.toUpperCase(), args: [] });
  for (let i = 0; i < 50 && !c.msgs.find((m) => m.type === 'created'); i++) await sleep(100);
  const id = c.msgs.find((m) => m.type === 'created').id;
  c.send({ type: 'attach', id, cols: 80, rows: 24 });
  await sleep(1500);
  c.send({ type: 'input', id, data: 'one\r' });
  await sleep(800);
  assert.ok(c.msgs.some((m) => m.type === 'output' && m.data.includes('ECHO:one')));
  const listed = c.msgs.filter((m) => m.type === 'sessions').pop().sessions.find((s) => s.id === id);
  assert.strictEqual(listed.cwd, fs.realpathSync.native(home), 'cwd canonicalized (D-7)');
  c.ws.close();

  proc.kill();
  await sleep(800);
  startBridge();
  await sleep(4000);
  c = await connect();
  await sleep(500);
  const after = c.msgs.find((m) => m.type === 'sessions').sessions.find((s) => s.id === id);
  assert.ok(after && after.alive, 'session restored after restart');
  c.send({ type: 'attach', id, cols: 80, rows: 24 });
  await sleep(500);
  c.send({ type: 'input', id, data: 'two\r' });
  await sleep(800);
  assert.ok(c.msgs.some((m) => m.type === 'output' && m.data.includes('ECHO:two')));
  c.send({ type: 'kill', id });
  await sleep(1000);
  c.ws.close();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/server-sessions.test.js`
Expected: FAIL — сессия не создаётся (`created` не приходит или keeper ждёт `.sock`).

- [ ] **Step 3: Переписать блок сессий**

В блоке `// ---- sessions` заменить:

1. `const SESS_DIR = path.join(os.homedir(), '.claude-bridge', 'sessions'); fs.mkdirSync(...); try { fs.chmodSync(SESS_DIR, 0o700); } catch {}` → `const SESS_DIR = DATA.sessions;` и добавить `const K = require('./lib/keeper-channel');` к остальным require.

2. В `makeSession(meta)` добавить поля `pipe: meta.pipe, secret: meta.secret, hookToken: meta.hookToken, channel: null`; поле `sock` удалить.

3. `keeperSend`:

```js
function keeperSend(session, obj) {
  if (session.channel) session.channel.send(obj);
}
```

4. `connectKeeper` — полностью:

```js
function connectKeeper(session, retries) {
  K.connectAuthenticated(session.pipe, session.secret).then((ch) => {
    session.channel = ch;
    ch.socket.on('close', () => {
      if (session.channel === ch) { session.channel = null; dropSession(session, -1); }
    });
    ch.onMessage((m) => {
      if (m.t === 'hello') {
        session.pid = m.pid;
        session.cols = m.cols;
        session.rows = m.rows;
        session.buffer = [String(m.buffer || '')];
        session.bufferBytes = Buffer.byteLength(session.buffer[0]);
        if (m.buffer) {
          const shot = JSON.stringify({
            type: 'scrollback', id: session.id, data: m.buffer,
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
        dropSession(session, m.code);
      }
    });
  }).catch(() => {
    if (retries > 0) { setTimeout(() => connectKeeper(session, retries - 1), 300); return; }
    try { fs.unlinkSync(path.join(SESS_DIR, session.id + '.json')); } catch { /* */ }
    console.log(`  Сессия ${session.id}: хранитель не отвечает — meta убран`);
    dropSession(session, -1);
  });
}
```

5. Удалить `isUnderAllowedRoot` и `remoteCwd`; в `createSession` строку выбора каталога заменить на:

```js
  const dir = local
    ? P.resolveLocalCwd(cwd, CONFIG.defaultCwd)
    : P.resolveRemoteCwd(cwd, CONFIG.projects, CONFIG.defaultCwd);
```

6. В `createSession` перед `const meta = {` добавить генерацию секретов, в `meta` — поля, и заменить запуск keeper'а:

```js
  const secret = crypto.randomBytes(32).toString('hex');
  const hookToken = T.newToken();
```

```js
    pipe: K.pipeName(),
    secret,
    hookToken,
```

```js
  const childEnv = {
    ...process.env, ...CONFIG.env,
    CLAUDE_BRIDGE_SESSION: id,
    CLAUDE_BRIDGE_HOOK_TOKEN: hookToken,
    CLAUDE_BRIDGE_PORT: String(CONFIG.port),
    CLAUDE_BRIDGE_CERT_FP: FINGERPRINT,
    CLAUDE_BRIDGE_KEEPER_SECRET: secret,
    FORCE_COLOR: '3',
  };
  const metaPath = path.join(SESS_DIR, id + '.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const child = spawn(process.execPath, [path.join(__dirname, 'keeper.js'), metaPath], {
    detached: true, windowsHide: true, stdio: 'ignore', env: childEnv,
  });
  child.unref();
```

(`CLAUDE_BRIDGE_KEEPER_SECRET` keeper удаляет из окружения до запуска агента — задача 8.)

7. `restoreSessions` — убрать проверку `.sock`:

```js
function restoreSessions() {
  let restored = 0;
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      if (!V.sessionId(meta.id) || !meta.pipe || !meta.secret) continue;
      const n = parseInt(String(meta.id).slice(1), 10);
      if (n > seq) seq = n;
      const session = makeSession(meta);
      sessions.set(meta.id, session);
      connectKeeper(session, 3);
      restored++;
    } catch { /* битый meta — пропускаем */ }
  }
  if (restored) console.log(`  Восстановлено живых сессий: ${restored}`);
}
```

8. В `sessionList()` поле `cwd` оставить (уже канонический путь).

- [ ] **Step 4: Тест проходит**

Run: `cd bridge && node --test test/server-sessions.test.js`
Expected: `# pass 1`.

- [ ] **Step 5: Весь набор**

Run: `cd bridge && npm test`
Expected: все тесты `pass`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add bridge/server.js bridge/test/server-sessions.test.js
git commit -m "feat(bridge): sessions via authenticated pipes, canonical cwd (D-7, D-11)"
```

---

### Task 12: Хук Claude Code на Node (P-4, P-6)

**Files:**
- Create: `bridge/hooks/bridge-hook.js`
- Delete: `bridge/hooks/bridge-hook.sh`
- Test: `bridge/test/hook.test.js`

- [ ] **Step 1: Тест** — хук без `CLAUDE_BRIDGE_SESSION` молча выходит с кодом 0; с переменными шлёт запрос с `Authorization: Bearer` и `X-Bridge-Session` на заданный порт и проверяет отпечаток.

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync, spawn } = require('child_process');
const { loadOrCreateCert } = require('../lib/cert');

const HOOK = path.join(__dirname, '..', 'hooks', 'bridge-hook.js');

test('no bridge session -> exit 0, no output', () => {
  const env = { ...process.env };
  delete env.CLAUDE_BRIDGE_SESSION;
  const r = spawnSync(process.execPath, [HOOK], { input: '{}', env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('posts event with token and pins the certificate', { timeout: 60000 }, async () => {
  const cert = loadOrCreateCert(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hookcert-')));
  let got = null;
  const srv = https.createServer(cert.tls, (req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { got = { auth: req.headers.authorization, sid: req.headers['x-bridge-session'], body: b }; res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const run = (fp) => new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_BRIDGE_SESSION: 's1-abcdef', CLAUDE_BRIDGE_HOOK_TOKEN: 'a'.repeat(64),
        CLAUDE_BRIDGE_PORT: String(srv.address().port), CLAUDE_BRIDGE_CERT_FP: fp },
    });
    p.stdin.end('{"hook_event_name":"Stop"}');
    p.on('exit', resolve);
  });
  assert.strictEqual(await run('0'.repeat(64)), 0);
  assert.strictEqual(got, null, 'wrong fingerprint -> nothing sent');
  assert.strictEqual(await run(cert.fingerprint), 0);
  assert.deepStrictEqual(got, { auth: 'Bearer ' + 'a'.repeat(64), sid: 's1-abcdef', body: '{"hook_event_name":"Stop"}' });
  srv.close();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/hook.test.js`
Expected: FAIL — нет `hooks/bridge-hook.js`.

- [ ] **Step 3: Реализация** — `bridge/hooks/bridge-hook.js`:

```js
#!/usr/bin/env node
'use strict';
// Хук Claude Code -> мост. Вне bridge-сессии молча выходит. Никогда не мешает
// работе Claude: любые ошибки проглатываются, код выхода всегда 0.
// Регистрация (P-6) — exec-форма: {"type":"command","command":"node","args":["<путь>\\bridge-hook.js"]}
const https = require('https');

const sid = process.env.CLAUDE_BRIDGE_SESSION;
const token = process.env.CLAUDE_BRIDGE_HOOK_TOKEN;
const port = parseInt(process.env.CLAUDE_BRIDGE_PORT || '8790', 10);
const fp = (process.env.CLAUDE_BRIDGE_CERT_FP || '').toLowerCase();
if (!sid || !token || !fp) process.exit(0);

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { body += d; if (body.length > 1e6) process.exit(0); });
process.stdin.on('end', () => {
  const req = https.request({
    host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 2000,
    rejectUnauthorized: false, // самоподписанный: доверие — только по отпечатку ниже
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Bridge-Session': sid,
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('socket', (sock) => {
    sock.on('secureConnect', () => {
      const got = String(sock.getPeerCertificate().fingerprint256 || '').replace(/:/g, '').toLowerCase();
      if (got !== fp) { req.destroy(); process.exit(0); }
      req.end(body);
    });
  });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
});
```

(Тело отправляется только после проверки отпечатка в `secureConnect`, поэтому `req.end` вызывается внутри обработчика.)

Удалить `bridge/hooks/bridge-hook.sh`.

- [ ] **Step 4: Тест проходит**

Run: `cd bridge && node --test test/hook.test.js`
Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
git add bridge/hooks/bridge-hook.js bridge/test/hook.test.js
git rm bridge/hooks/bridge-hook.sh
git commit -m "feat(bridge): Node hook with session token and cert pinning (P-4, P-6, M-8)"
```

---

### Task 13: Сеть офиса и туннель на сервере (P-7, P-4)

**Files:**
- Modify: `bridge/server.js` (UDP-маяк, `listen`, туннель)
- Modify: `bridge/config.example.json`

- [ ] **Step 1: Маяк без hostname (P-7)** — в обработчике `beacon.on('message', …)` объект ответа:

```js
    const reply = JSON.stringify({ claudeBridge: true, port: CONFIG.port, fp: FINGERPRINT });
```

и создание сокета без `reuseAddr`: `const beacon = dgram.createSocket({ type: 'udp4' });`.

- [ ] **Step 2: Интерфейс по умолчанию — LAN, не `0.0.0.0` (P-7, L-11)** — заменить `server.listen(CONFIG.port, CONFIG.host, () => {` на:

```js
const LISTEN_HOST = (!CONFIG.host || CONFIG.host === 'auto') ? lanAddress() : CONFIG.host;
server.listen(CONFIG.port, LISTEN_HOST, () => {
```

Владелец подключается к `127.0.0.1`, поэтому, если `LISTEN_HOST` — не `0.0.0.0` и не `127.0.0.1`, дополнительно слушать loopback тем же обработчиком:

```js
const ownerServer = https.createServer(TLS, httpHandler);
ownerServer.on('upgrade', handleUpgrade);
if (LISTEN_HOST !== '0.0.0.0' && LISTEN_HOST !== '127.0.0.1') ownerServer.listen(CONFIG.port, '127.0.0.1');
```

(`isOwner` проверяет `localPort === CONFIG.port` — loopback-сервер на том же номере порта проходит.)

- [ ] **Step 3: Старт без QR и без кода (P-9), тестовый режим** — внутри колбэка `listen` удалить вывод QR/кода (`qrcode.generate…`, строки про код) и публикацию mDNS обернуть в `if (!process.env.CLAUDE_BRIDGE_TEST)`. Вместо QR печатать: `console.log('  Добавить устройство: claude-mobile --qr');`. Удалить `require('qrcode-terminal')` из `server.js`.

- [ ] **Step 4: Туннель (P-4)** — константы и гашение старых процессов:

```js
const INET_FILE = DATA.internet;
const TUNNEL_BIN = path.join(__dirname, 'bin', 'claude-tunnel.exe');
const ALLOW_FILE = path.join(DATA.certs, 'tunnel-allow.txt');
```

в `startTunnel`: `spawnSync('pkill', …)` → `spawnSync('taskkill', ['/IM', 'claude-tunnel.exe', '/F'], { windowsHide: true });`, `--secret-file` → `path.join(DATA.certs, 'iroh.key')`, в `spawn(TUNNEL_BIN, …)` добавить `windowsHide: true`. В `writeAllowFile` убрать `{ mode: 0o600 }`. В `setInternet` путь — `INET_FILE`.

- [ ] **Step 5: `config.example.json`**

```json
{
  "port": 8790,
  "host": "auto",
  "claudeCommand": "claude",
  "claudeArgs": [],
  "defaultCwd": "~",
  "projects": [],
  "env": {},
  "scrollbackBytes": 1048576,
  "mdnsName": "claude-bridge",
  "sttPython": "py",
  "sttPythonArgs": ["-3.11"],
  "sttModel": "large-v3",
  "sttLanguage": "ru"
}
```

и в `ensureStt` запуск: `spawn(CONFIG.sttPython || 'py', [...(CONFIG.sttPythonArgs || []), path.join(__dirname, 'stt.py')], { …, windowsHide: true })`.

- [ ] **Step 6: Прогнать весь набор**

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add bridge/server.js bridge/config.example.json
git commit -m "feat(bridge): LAN-only listen, beacon without hostname, Windows tunnel/STT spawn (P-7, P-4)"
```

---

### Task 14: `claude-mobile` (attach.js) и подтверждения P-9

**Files:**
- Modify: `bridge/attach.js`
- Modify: `bridge/server.js` (ветки `pairinfo`, `setInternet`)
- Create: `bridge/claude-mobile.cmd`

- [ ] **Step 1: Подключение с токеном и пиннингом** — заменить строки 18–20 и 57–58 `attach.js`:

```js
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, 'node_modules', 'ws'));
const { ensureDataDirs } = require('./lib/datadir');
const { pinnedTlsOptions } = require('./lib/cert');

const DATA = ensureDataDirs();
const PORT = JSON.parse(fs.readFileSync(DATA.config, 'utf8')).port || 8790;
const BRIDGE = `wss://127.0.0.1:${PORT}/ws`;
```

```js
const der = fs.readFileSync(path.join(DATA.certs, 'bridge.cer'));
const ws = new WebSocket(BRIDGE, {
  ...pinnedTlsOptions(new crypto.X509Certificate(der).toString(),
    crypto.createHash('sha256').update(der).digest('hex')),
  headers: { Authorization: 'Bearer ' + fs.readFileSync(DATA.ownerToken, 'utf8').trim() },
});
```

- [ ] **Step 2: Размер окна** — `process.on('SIGWINCH', …)` → `process.stdout.on('resize', () => { send({ type: 'resize', id: sid, cols: process.stdout.columns, rows: process.stdout.rows }); });`.

- [ ] **Step 3: `--open` и `--rotate-token`** — в `USAGE` добавить строки:

```
  claude-mobile --open      открыть веб-интерфейс моста в браузере (одноразовая ссылка)
  claude-mobile --rotate-token  перевыпустить токен владельца
```

в ветке `case 'sessions':` перед `else if (args[0] === '--qr')` добавить:

```js
      } else if (args[0] === '--open') {
        send({ type: 'issueLoginToken' });
      } else if (args[0] === '--rotate-token') {
        send({ type: 'rotateOwnerToken' });
        console.log('Токен владельца перевыпущен; открытые вкладки браузера нужно открыть заново (--open).');
        setTimeout(() => process.exit(0), 300);
```

и новый `case`:

```js
    case 'loginToken': {
      const url = `https://127.0.0.1:${m.port}/?ott=${m.token}`;
      require('child_process').spawn('cmd.exe', ['/d', '/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      console.log('Открываю веб-интерфейс моста (ссылка одноразовая, действует 60 с).');
      setTimeout(() => process.exit(0), 300);
      break;
    }
```

- [ ] **Step 4: Подтверждения P-9 на клиенте** — функция и её использование для `--qr` и переключения интернета:

```js
function confirmHuman(question, onYes) {
  // P-9: только живой человек в интерактивной консоли. Агент запускает команды без TTY.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die('Эта операция требует подтверждения в интерактивной консоли.', 1);
    return;
  }
  const q = readline.createInterface({ input: process.stdin, output: process.stdout });
  q.question(question + ' [y/N]: ', (ans) => {
    q.close();
    if (/^[yд]/i.test(ans.trim())) onYes(); else die('Отменено.');
  });
}
```

`else if (args[0] === '--qr') { send({ type: 'pairinfo' }); }` → `else if (args[0] === '--qr') { confirmHuman('Выпустить код сопряжения нового устройства?', () => send({ type: 'pairinfo', confirmed: true })); }`.

В `deviceTui` ветку `i`: `send({ type: 'setInternet', … })` обернуть в `confirmHuman('Изменить доступ через интернет?', () => { send({ type: 'setInternet', enabled: !(inetState && inetState.enabled), confirmed: true }); setTimeout(…, 400); });`.

На сервере в ветках `pairinfo` и `setInternet` условие `if (ws.deviceId === 'local')` → `if (ws.deviceId === 'local' && m.confirmed === true)`. Ограничение: агент с токеном владельца может отправить `confirmed:true` напрямую по WS — P-9 в этом виде защищает от неинтерактивных запусков `claude-mobile`, но не от прямого WS-клиента (см. вопрос F-4 в итоговом отчёте).

После успешного `/pair` (сервер) — уведомить сопряжённые устройства:

```js
      broadcast({ type: 'notify', id: '', event: 'DevicePaired', message: `Сопряжено новое устройство: ${safeName}`, title: 'Claude Bridge', at: Date.now() });
```

- [ ] **Step 5: Шим** — `bridge/claude-mobile.cmd`:

```bat
@echo off
node "%~dp0attach.js" %*
```

- [ ] **Step 6: Ручная проверка** (мост запущен с реальным каталогом данных)

Run: `node bridge/server.js` в одном окне; в другом `bridge\claude-mobile.cmd -l`
Expected: `Сессий нет.`
Run: `echo y | bridge\claude-mobile.cmd --qr`
Expected: `Эта операция требует подтверждения в интерактивной консоли.` (stdin не TTY).
Run: `bridge\claude-mobile.cmd --qr` и ответить `y`
Expected: QR и код сопряжения.

- [ ] **Step 7: Commit**

```bash
git add bridge/attach.js bridge/server.js bridge/claude-mobile.cmd
git commit -m "feat(bridge): claude-mobile with owner token, pinning, --open, --rotate-token, TTY confirmations (P-1, P-9)"
```

---

### Task 15: Автозапуск без консоли (P-4)

**Files:**
- Create: `bridge/start-bridge.js`

- [ ] **Step 1: Реализация** — `bridge/start-bridge.js`:

```js
#!/usr/bin/env node
'use strict';
// Точка входа для Планировщика задач: поднимает мост отсоединённым скрытым
// процессом и сразу выходит. Повторный запуск при уже работающем мосте — no-op
// (порт занят -> server.js завершится с ошибкой в логе).
const path = require('path');
const { spawn } = require('child_process');

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
  cwd: __dirname,
});
child.unref();
process.exit(0);
```

- [ ] **Step 2: Ручная проверка**

Run: `node bridge/start-bridge.js` (из обычной консоли)
Expected: команда сразу возвращает управление; в `%LOCALAPPDATA%\ClaudeBridge\logs\bridge.log` появляется строка `Claude Bridge запущен`; `bridge\claude-mobile.cmd -l` отвечает.
Run: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -like '*server.js*' | % { Stop-Process -Id $_.ProcessId }`
Expected: мост остановлен.

- [ ] **Step 3: Commit**

```bash
git add bridge/start-bridge.js
git commit -m "feat(bridge): detached hidden launcher for Task Scheduler (P-4)"
```

(Регистрация задачи Планировщика, брандмауэр, хук в `settings.json` — подплан 4, `install.ps1`.)

---

## Поправки по итогам ревью (2026-10-31) — имеют приоритет над кодом задач выше

| Задача | Поправка | Причина |
|---|---|---|
| 1 | Скрипт `test`: `node --test --test-concurrency=1 "test/*.test.js"`. | Node 24 трактует каталог `test/` как модуль. |
| 3 | `resolveRemoteCwd`/`resolveLocalCwd` принимают только **каталог** (`canonicalDir`); `expandConfigPath` возвращает `null` для относительных путей и голой буквы диска. | Ревью I-1, I-2. |
| 4 | `loadOrCreateOwnerToken`: ротация только при ENOENT/невалидном содержимом, создание с `flag:'wx'`; `OneTimeTokens(ttl, now)`. | Ревью, мелкие правки. |
| 5 | Генерация сертификата: таймаут 120 с, учёт `r.error`, временные имена + rename, проверка пары `tls.createSecureContext` при загрузке, ошибки PowerShell в UTF-8. Пиннинговые клиенты — только с новым соединением (`agent:false`/ws). | Ревью I-3; keep-alive обходит проверку отпечатка. |
| 6 | Проверка `typeof === 'string'` для nonce/mac, try/catch до аутентификации, лимит строки до аутентификации ~4 КБ, `if (socket.destroyed) return`. | Ревью I-1, M-1, M-2 (keeper падал от `{"nonce":{"toString":1}}`). |
| 7 | **`.cmd`-шимы:** аргументы node-pty — **одной строкой** `/d /s /c "<экранированная команда>"`, экранирование по алгоритму cross-spawn (кавычки MSVCRT + `^`-экранирование метасимволов, для шимов дважды). Тест — реальный запуск через node-pty. | Ревью C-1: с массивом аргументов node-pty экранирует кавычки как `\"` и шимы `claude.cmd`/`opencode.cmd`/`npm.cmd` не запускаются. Адаптеры `claude`/`opencode` (подплан 2) запускают `.exe` напрямую. |
| 8 | Секрет обязан быть 64 hex, иначе выход; порядок `listen` → spawn; ошибки старта — в `logs/keeper-<id>.log`, meta удаляется; `srv.maxConnections = 16`; `hello` ограничен ~6 МБ JSON; тест убивает keeper в `t.after`, ожидания через опрос, проверка отсутствия секрета в env агента. | Ревью I-2, I-3, I-4, M-7. |
| 9 | `log.js`: ротация в отдельном try, перевод строк в сообщении экранируется; `cleanTitle` убирает bidi/zero-width и режет по кодовым точкам; `pairBody.name` очищается и ограничивается 64 символами. | Ревью M-5, M-6. |
| 11 | В `restoreSessions` проверять `meta.pipe` по `^\\\.\pipe\claude-bridge-[0-9a-f]{32}$` и `meta.secret` по `^[0-9a-f]{64}$`. | Ревью M-3: UNC в `meta.pipe` заставил бы мост пойти по SMB и отдать NTLM. |
| 10–11 | Браузер получает в cookie отдельный токен в памяти (не токен владельца); ott→cookie только GET+loopback+основной порт; переопределение порта моста — `CLAUDE_BRIDGE_LISTEN_PORT`; туннельный сервер слушает только при включённом интернете; `keeperPid` в meta. | Ревью задач 10–11, D-16. |
| 13 | LAN-адрес — `lib/lan.js` (D-17); в `CLAUDE_BRIDGE_TEST` туннель не запускается; `requestTimeout` 120 с. | Эвристика плана выбирала VPN-адаптер; тесты не должны ходить в iroh и гасить туннель пользователя. |
| 15 | Маяк, туннель, mDNS и `restoreSessions` стартуют в `onListening()` — только после занятия всех портов. | Второй экземпляр моста до падения на EADDRINUSE гасил туннель и цеплялся к keeper'ам первого. |

## Самопроверка плана

- **Покрытие:** D-1 (T4, T10, T14), D-7 (T3, T11), D-8 (T2: данные в профиле, без ACL-кода), D-9 (без Linux/миграции), D-11 (T6, T8, T11), P-1 (T2, T4, T10, T14), P-4 (T5, T7, T12, T13, T15), P-6 (T12 — регистрация в `install.ps1` в подплане 4), P-7 серверная часть (T13; QR-only — подплан 3), P-9 (T14, с оговоркой F-4), P-10: M-1 (T1), M-2/L-1/L-2/M-3 (T9, T10), L-8 (T9, T10), M-8 (T5, T12, T14). Вне подплана: D-3/D-4/D-5/D-10/D-12 (подплан 2), веб/Android (3), установщик/подпись/README (4).
- **Открытый вопрос F-4:** P-9 «подтверждение в консоли» не защищает от агента, который сам откроет WS с токеном владельца (файл читается тем же пользователем). Нужен внеполосный канал подтверждения — вынести пользователю.
