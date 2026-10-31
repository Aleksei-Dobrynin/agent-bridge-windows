# Распространение в команде — план реализации (подплан 4 из 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** член команды ставит мост на свой личный Windows-ПК одной командой `install.ps1` (зависимости моста, каталог данных, автозапуск при входе, хук Claude Code в пользовательском `settings.json`, `claude-mobile` в PATH, по желанию — правила брандмауэра) и снимает всё обратно `uninstall.ps1`; телефон получает release-APK, подписанный ключом команды, с проверяемыми SHA-256 артефактов и сертификата подписи; README и ARCHITECTURE описывают Windows-версию. Попутно `claude-mobile` при отсоединении возвращает консоли обычный режим ввода (`\x1b[?9001l`).

**Architecture:** всё, что проверяется без побочных эффектов, вынесено из сценариев установки: слияние хуков — `bridge/tools/install-hooks.js` (Node, тесты `node:test`), чистые функции установщика — `bridge/tools/install-lib.ps1` (проверки `bridge/tools/test-install-lib.ps1`, запускаемые из `node:test`). `install.ps1` / `uninstall.ps1` в корне репозитория — тонкие сценарии с `-DryRun` и переопределениями `-DataRoot` / `-SettingsPath`; автоматические проверки запускают их **только** на временных каталогах с `-SkipTask -SkipPath -SkipNpm -NoStart` (нестандартный `-DataRoot` без этих ключей установщик отвергает). Реальная установка (задача Планировщика, PATH, `%USERPROFILE%\.claude\settings.json`, брандмауэр) — последняя ручная задача пользователя. Релиз — `tools/release.ps1`: собирает артефакты в `dist/`, пишет `SHA256SUMS.txt` и `RELEASE_NOTES.md`.

**Tech Stack:** Windows PowerShell 5.1 (модуль ScheduledTasks, `netsh advfirewall`, реестр `HKCU\Environment`), Node.js ≥ 20 (`node:test`), Gradle 8.7 + AGP 8.5.2, JDK 17 (Temurin), Android SDK build-tools 34.0.0 (`apksigner`, `aapt`), Android NDK, Rust 1.99.1 (`x86_64-pc-windows-msvc`, `aarch64-linux-android`).

**Источник решений:** `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md` («реестр») — P-4 (автозапуск, брандмауэр, шим `claude-mobile`), P-6 (хук в пользовательском `settings.json`), P-8 (APK, Gradle, бинари туннеля, установщик, README), D-8 (не для общих компьютеров), D-9 (скоуп), ограничения D-21, D-22.1, D-23.7. Подпланы 1–3: `2026-10-31-windows-bridge-core.md`, `2026-10-31-agent-adapters.md`, `2026-10-31-clients.md`.

**Предпосылки:**
- Подпланы 1–2 выполнены; `cd bridge && npm test` → `# fail 0`.
- Задачи 1–5 от подплана 3 не зависят, но создают и правят файлы в `bridge/test/` (только **новые** файлы) и `bridge/attach.js`, `bridge/lib/win32-input.js`. Если подплан 3 выполняется параллельно — перед коммитом `git status` и не включать в коммит чужие изменения (`bridge/web/*` и т.п.).
- Задачи 6–15 — **после** подплана 3 (Android-код, веб-клиент и протокол в ARCHITECTURE.md должны описывать уже сделанное).

**Не делаем:** службу Windows (P-4: session 0 ломает ConPTY); установку Node/Claude Code/opencode установщиком (только проверка); подпись Windows-бинарей (Authenticode); автообновление; публикацию релиза (канал распространения — открытый вопрос, см. «Самопроверку»); совместимость со старыми данными (D-9).

**Окружение машины (проверено 2026-10-31):**
- Rust 1.99.1 — `%USERPROFILE%\.cargo\bin` (в PATH Git Bash его нет, команды ниже вызывают `cargo.exe`/`rustup.exe` по полному пути); установлен только target `x86_64-pc-windows-msvc`.
- Android SDK `C:\Users\doale\AppData\Local\Android\Sdk`: `build-tools\34.0.0`, `platforms\android-34`, `cmdline-tools\latest` (есть `sdkmanager.bat`), **NDK нет**; `android/local.properties` создан.
- JDK 17 — `C:\Users\doale\AppData\Local\Programs\Temurin\jdk-17` (не в PATH; `java` в PATH нет).
- Gradle не установлен; `%USERPROFILE%\.gradle\wrapper\dists` нет.
- `android/gradle/wrapper/gradle-wrapper.jar` — `Implementation-Version: 4.4.1`, SHA-256 `1fca1b1af7c3ed6cb9059346aaa89179c82abf11252837115e546c4da38e8b0c`; в `gradle-wrapper.properties` нет `distributionSha256Sum`; `gradlew.bat` в `android/` нет.
- `bridge/bin/claude-tunnel.exe` собран (`f366001`, SHA-256 `24bcce34…8df8144`), каталог `bridge/bin/` в `.gitignore`.
- `origin` = `https://github.com/Aleksei-Dobrynin/agent-bridge-windows`.

**Кодировка PowerShell-скриптов (обязательно для всех новых `.ps1`):** Windows PowerShell 5.1 читает файл без BOM в кодировке ANSI (cp1251) — русские строки ломаются. Каждый `.ps1` после записи переводится в UTF-8 с BOM и проверяется:

```powershell
$p = (Resolve-Path '<файл>.ps1').Path
$t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding $true))
([IO.File]::ReadAllBytes($p)[0..2]) -join ','   # Expected: 239,187,191
```

Тест `bridge/test/install-lib.test.js` (задача 3) проверяет BOM у всех `.ps1` в корне, `bridge/tools/` и `tools/`.

**Коммиты:** после каждой задачи с зелёными проверками, в ветке `feature/windows-multi-agent`, без push; трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

## Карта файлов

| Файл | Ответственность |
|---|---|
| `bridge/lib/win32-input.js` | Константа `MODE_OFF` = `\x1b[?9001l` |
| `bridge/attach.js` | При выходе из raw-режима — `MODE_OFF` в консоль |
| `bridge/test/fixtures/attach-then-echo.js` (новый) | `claude-mobile`, затем `raw-echo` в той же консоли (ConPTY) |
| `bridge/test/attach-detach.test.js` (новый) | После Ctrl+\ следующая программа получает обычные клавиши |
| `bridge/tools/install-hooks.js` (новый) | P-6: слияние/удаление хука моста в `settings.json`, бэкап, `--dry-run`, `status` |
| `bridge/test/install-hooks.test.js` (новый) | Тесты слияния, удаления, CLI на временных файлах |
| `bridge/tools/install-lib.ps1` (новый) | Чистые функции установщика: PATH, шим, задача, брандмауэр, порт, процессы |
| `bridge/tools/test-install-lib.ps1` (новый) | Проверки `install-lib.ps1` (код выхода 0/1) |
| `bridge/tools/firewall.ps1` (новый) | Правила брандмауэра (add/remove), запускается с повышением прав |
| `bridge/test/install-lib.test.js` (новый) | BOM всех `.ps1` + запуск `test-install-lib.ps1` |
| `install.ps1` (новый, корень) | Установка (P-4, P-6, P-8) |
| `uninstall.ps1` (новый, корень) | Удаление |
| `bridge/test/installer.test.js` (новый) | `install.ps1`/`uninstall.ps1` только на временных путях |
| `android/gradle/wrapper/*`, `android/gradlew`, `android/gradlew.bat` | Wrapper Gradle 8.7 с `distributionSha256Sum` (если ещё не сделано подпланом 3) |
| `android/app/build.gradle` | Подпись release ключом команды из свойств Gradle, `debuggable false` |
| `tools/release.ps1` (новый) | Сборка артефактов в `dist/`, `SHA256SUMS.txt`, `RELEASE_NOTES.md` |
| `.gitignore` | `dist/` |
| `README.md`, `README.en.md` | Переписать под Windows и скоуп D-9 |
| `ARCHITECTURE.md` | Новая архитектура Windows-версии + известные ограничения |
| `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md` | Статус реализации P-4/P-6/P-8 (только факты) |

---

### Task 1: `claude-mobile` возвращает консоли обычный режим ввода при отсоединении

Живая проверка D-23: Claude Code выводит `\x1b[?9001h` (win32-input-mode); через вывод `claude-mobile` он включает этот режим **в консоли пользователя**, и после отсоединения (Ctrl+\) следующая программа в той же консоли получает клавиши как `\x1b[…_`. Исправление: при выходе из raw-режима `claude-mobile` пишет `\x1b[?9001l`.

**Files:**
- Modify: `bridge/lib/win32-input.js`, `bridge/attach.js`, `bridge/test/win32-input.test.js`
- Create: `bridge/test/fixtures/attach-then-echo.js`, `bridge/test/attach-detach.test.js`

- [ ] **Step 1: Фикстура — `claude-mobile`, затем `raw-echo` в той же консоли**

`bridge/test/fixtures/attach-then-echo.js`:

```js
'use strict';
// claude-mobile в общей консоли (stdio inherit), после его выхода — raw-echo в ТОЙ ЖЕ консоли:
// так видно, в каком режиме ввода claude-mobile оставил консоль (задача 1 подплана 4).
const path = require('path');
const { spawnSync } = require('child_process');

const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'attach.js'), ...process.argv.slice(2)],
  { stdio: 'inherit' });
process.stdout.write('[attach exit ' + r.status + ']\r\n');
require('./raw-echo.js');
```

- [ ] **Step 2: Тест поведения**

`bridge/test/attach-detach.test.js`:

```js
'use strict';
// Задача 1 подплана 4: claude-mobile при отсоединении выключает win32-input-mode своей консоли
// (\x1b[?9001l). Иначе после \x1b[?9001h от агента (Claude Code) следующая программа в этой
// консоли получает клавиши как \x1b[Vk;Sc;Uc;Kd;Cs;Rc_ (живая проверка D-23).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const pty = require('../node_modules/node-pty');
const H = require('./helpers/bridge');

test.after(() => setTimeout(() => process.exit(0), 300).unref()); // node-pty держит цикл событий

const WRAPPER = path.join(__dirname, 'fixtures', 'attach-then-echo.js');
let b;
test.before(async () => {
  b = await H.startTestBridge({
    prefix: 'cb-det-',
    config: { defaultAgent: 'echo', agents: { echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [H.FAKE_AGENT] } } },
  });
});
test.after(() => b && b.stop());

const until = async (fn, ms, what) => assert.ok(await H.waitFor(fn, ms), 'не дождались: ' + what);

test('after Ctrl+\\ the next program in the same console gets plain keys (\\x1b[?9001l on detach)', { timeout: 90000 }, async () => {
  const env = { ...process.env, CLAUDE_BRIDGE_HOME: b.home };
  const term = pty.spawn(process.execPath, [WRAPPER, '--agent', 'echo', '--w32-input'],
    { name: 'xterm', cols: 200, rows: 50, cwd: b.cwd, env });
  let raw = '';
  term.onData((d) => { raw += d; });
  const out = () => H.stripAnsi(raw);
  const got = () => out().match(/\[got [0-9a-f]+\]/g) || [];
  try {
    await until(() => /ARGV:\["--w32-input"\]/.test(out()), 20000, 'агент запущен: ' + out());
    term.write('\x1c'); // Ctrl+\ — консоль уже в win32-input-mode (D-23.2)
    await until(() => /\[attach exit 0\]/.test(out()) && /\[raw true\]/.test(out()), 15000,
      'claude-mobile отсоединился, raw-echo запущен: ' + JSON.stringify(out().slice(-300)));
    term.write('Z');
    await until(() => got().length > 0, 10000, 'raw-echo получил ввод');
    await H.sleep(300); // отпускание клавиши в win32-input-mode приходит второй порцией
    assert.deepStrictEqual(got(), ['[got 5a]'], 'консоль осталась в win32-input-mode: ' + JSON.stringify(out().slice(-300)));
  } finally {
    try { term.kill(); } catch { /* вышел */ }
  }
});
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `cd bridge && node --test test/attach-detach.test.js`
Expected: FAIL на `deepStrictEqual`: `got()` содержит `[got 1b5b39303b…]` (клавиша «Z» = символ 90 в кодировке win32-input-mode).
Если тест **проходит** до исправления (ConPTY node-pty сбрасывает режим сам при выходе процесса) — записать это в отчёт по задаче, тест оставить как регрессионный и всё равно выполнить шаги 4–5 (дефект найден в живой проверке в Windows Terminal).

- [ ] **Step 4: Константа в `win32-input.js`**

В `bridge/lib/win32-input.js` после константы `ESC` добавить:

```js
/** Выключить win32-input-mode консоли: claude-mobile пишет его при отсоединении — агент мог
 *  включить режим в консоли пользователя через свой вывод (\x1b[?9001h от Claude Code). */
const MODE_OFF = '\x1b[?9001l';
```

и заменить строку экспорта:

```js
module.exports = { ESC, MODE_OFF, isCtrlBackslash };
```

В `bridge/test/win32-input.test.js` добавить в конец:

```js
test('MODE_OFF switches win32-input-mode off', () => {
  assert.strictEqual(W32.MODE_OFF, '\x1b[?9001l');
});
```

- [ ] **Step 5: `cleanup()` в `attach.js`**

В `bridge/attach.js` заменить функцию `cleanup`:

```js
function cleanup() {
  if (raw && process.stdin.isTTY) {
    raw = false;
    try { process.stdin.setRawMode(false); } catch { /* консоль уже закрыта */ }
    // агент мог включить в этой консоли win32-input-mode (\x1b[?9001h проходит через наш вывод):
    // без выключения следующая программа в консоли получает клавиши как \x1b[…_
    if (process.stdout.isTTY) {
      try { process.stdout.write(W32.MODE_OFF); } catch { /* консоль уже закрыта */ }
    }
  }
}
```

- [ ] **Step 6: Проверить**

Run: `cd bridge && node --test test/attach-detach.test.js test/win32-input.test.js test/attach-agent.test.js`
Expected: `# fail 0`.
Если `attach-detach` всё ещё видит `1b5b…`: запись ушла, но не дошла до консоли до `process.exit` (на Windows запись в TTY асинхронна) — заменить вызов на `require('fs').writeSync(process.stdout.fd, W32.MODE_OFF)` и повторить.

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add bridge/lib/win32-input.js bridge/attach.js bridge/test/win32-input.test.js bridge/test/fixtures/attach-then-echo.js bridge/test/attach-detach.test.js
git commit -m "fix(bridge): claude-mobile switches win32-input-mode off on detach"
```

---

### Task 2: `install-hooks.js` — хук моста в `settings.json` (P-6)

Установщик **один раз** добавляет хук моста в пользовательский `%USERPROFILE%\.claude\settings.json`: слияние с существующими хуками, бэкап файла (P-6). Набор событий и exec-форма — из `bridge/tools/hook-settings.js` (8 событий: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` с `matcher: "*"`; `Notification`, `UserPromptSubmit`, `Stop`).

Правила:
- «Запись хука моста» — элемент `hooks[*][*].hooks[*]`, у которого в `args` есть путь с именем файла `bridge-hook.js` (любой каталог: репозиторий могли перенести).
- `install`: если ровно по одной записи моста с текущим путём на каждом из 8 событий — ничего не делать; иначе снять все записи моста и добавить в конец каждого события группу из `hookSettings()`. Хуки пользователя и прочие ключи не трогаются.
- `uninstall`: снять все записи моста; группа, состоявшая только из них, удаляется; событие удаляется, только если опустело из-за снятия; `hooks` — тоже.
- Невалидный JSON, корень не объект, `hooks` не объект, `hooks.<событие>` не массив — отказ, файл не меняется (код 1).
- Перед записью существующего файла — копия `settings.json.bak-<ISO-время>`; запись — через временный файл и `rename`.

**Files:**
- Create: `bridge/tools/install-hooks.js`
- Test: `bridge/test/install-hooks.test.js`

- [ ] **Step 1: Тест**

`bridge/test/install-hooks.test.js`:

```js
'use strict';
// Задача 2 подплана 4 (P-6): хук моста в пользовательском settings.json Claude Code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookSettings } = require('../tools/hook-settings');
const IH = require('../tools/install-hooks');

const CLI = path.join(__dirname, '..', 'tools', 'install-hooks.js');
const HOOK = 'C:\\repo\\bridge\\hooks\\bridge-hook.js';
const USER_STOP = { hooks: [{ type: 'command', command: 'echo user-hook' }] };
const clone = (o) => JSON.parse(JSON.stringify(o));

test('merge into empty settings adds the exec-form hook for every event', () => {
  const r = IH.mergeBridgeHooks({}, HOOK);
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.settings, hookSettings(HOOK));
  assert.strictEqual(IH.isInstalled(r.settings, HOOK), true);
});

test('merge keeps user keys and user hooks first; second merge changes nothing', () => {
  const user = { model: 'opus', hooks: { Stop: [clone(USER_STOP)] } };
  const r = IH.mergeBridgeHooks(clone(user), HOOK);
  assert.strictEqual(r.settings.model, 'opus');
  assert.deepStrictEqual(r.settings.hooks.Stop, [USER_STOP, ...hookSettings(HOOK).hooks.Stop]);
  const again = IH.mergeBridgeHooks(clone(r.settings), HOOK);
  assert.strictEqual(again.changed, false);
  assert.deepStrictEqual(again.settings, r.settings);
});

test('merge replaces bridge entries with an old path (repository moved)', () => {
  const old = hookSettings('D:\\old\\bridge\\hooks\\bridge-hook.js');
  old.hooks.Stop.unshift(clone(USER_STOP));
  const r = IH.mergeBridgeHooks(old, HOOK);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.replaced, 8);
  assert.strictEqual(JSON.stringify(r.settings).includes('old'), false);
  assert.deepStrictEqual(r.settings.hooks.Stop[0], USER_STOP);
  assert.strictEqual(IH.isInstalled(r.settings, HOOK), true);
});

test('path comparison ignores case and slash style', () => {
  const s = hookSettings('c:/REPO/bridge/hooks/bridge-hook.js');
  assert.strictEqual(IH.isInstalled(s, HOOK), true);
});

test('remove takes out only bridge entries; mixed group keeps the user hook', () => {
  const s = IH.mergeBridgeHooks({ model: 'x', hooks: { Stop: [clone(USER_STOP)] } }, HOOK).settings;
  s.hooks.Notification[0].hooks.unshift({ type: 'command', command: 'echo n' });
  const r = IH.removeBridgeHooks(s);
  assert.strictEqual(r.removed, 8);
  assert.deepStrictEqual(r.settings, {
    model: 'x',
    hooks: { Stop: [USER_STOP], Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }] },
  });
});

test('remove of the only hooks deletes the hooks key; untouched empty events stay', () => {
  assert.deepStrictEqual(IH.removeBridgeHooks(hookSettings(HOOK)).settings, {});
  const s = hookSettings(HOOK);
  s.hooks.SessionStart = [];
  assert.deepStrictEqual(IH.removeBridgeHooks(s).settings, { hooks: { SessionStart: [] } });
});

test('malformed settings are refused', () => {
  for (const bad of [[], 'x', { hooks: [] }, { hooks: { Stop: {} } }]) {
    assert.throws(() => IH.mergeBridgeHooks(bad, HOOK), Error, JSON.stringify(bad));
    assert.throws(() => IH.removeBridgeHooks(bad), Error, JSON.stringify(bad));
  }
});

// ---- CLI на временных файлах

function tmpSettings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ih-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'claude', 'settings.json') };
}
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: r.stdout + r.stderr };
}
const backups = (dir) => fs.readdirSync(path.join(dir, 'claude')).filter((f) => f.startsWith('settings.json.bak-'));

test('CLI install creates a missing file without a backup; status reflects it', (t) => {
  const { dir, file } = tmpSettings(t);
  assert.strictEqual(cli('status', '--settings', file).status, 2);
  const r = cli('install', '--settings', file);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /Хук моста добавлен/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), hookSettings(IH.HOOK));
  assert.deepStrictEqual(backups(dir), []);
  assert.strictEqual(cli('status', '--settings', file).status, 0);
});

test('CLI install backs up an existing file once; repeat is a no-op', (t) => {
  const { dir, file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  const original = '\uFEFF' + JSON.stringify({ model: 'opus', hooks: { Stop: [USER_STOP] } });
  fs.writeFileSync(file, original);
  assert.strictEqual(cli('install', '--settings', file).status, 0);
  const b = backups(dir);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'claude', b[0]), 'utf8'), original, 'backup is byte-identical');
  const after = fs.readFileSync(file, 'utf8');
  const r = cli('install', '--settings', file);
  assert.match(r.out, /уже установлен/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), after);
  assert.strictEqual(backups(dir).length, 1);
});

test('CLI --dry-run writes nothing', (t) => {
  const { dir, file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{}');
  const r = cli('install', '--settings', file, '--dry-run');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /\[dry-run\] Хук моста будет добавлен/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepStrictEqual(backups(dir), []);
});

test('CLI uninstall restores the user content', (t) => {
  const { file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  const user = { model: 'opus', hooks: { Stop: [USER_STOP] } };
  fs.writeFileSync(file, JSON.stringify(user));
  assert.strictEqual(cli('install', '--settings', file).status, 0);
  const r = cli('uninstall', '--settings', file);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /Хук моста удалён/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), user);
  assert.match(cli('uninstall', '--settings', file).out, /Хука моста нет/);
});

test('CLI refuses broken JSON and leaves the file as is', (t) => {
  const { dir, file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{ "hooks": ');
  const r = cli('install', '--settings', file);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /файл не изменён/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "hooks": ');
  assert.deepStrictEqual(backups(dir), []);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd bridge && node --test test/install-hooks.test.js`
Expected: FAIL — `Cannot find module '../tools/install-hooks'`.

- [ ] **Step 3: Реализация**

`bridge/tools/install-hooks.js`:

```js
#!/usr/bin/env node
'use strict';
// P-6: хук моста в пользовательском settings.json Claude Code (exec-форма из hook-settings.js).
// Установка сливает записи с хуками пользователя и идемпотентна; перед записью существующего
// файла — резервная копия. Удаление снимает только записи хука моста (в args есть файл
// bridge-hook.js из любого каталога) — хуки пользователя и прочие ключи не трогаются.
//
//   node tools/install-hooks.js install   [--settings <файл>] [--dry-run]
//   node tools/install-hooks.js uninstall [--settings <файл>] [--dry-run]
//   node tools/install-hooks.js status    [--settings <файл>]      код 0 — установлен, 2 — нет
// Файл по умолчанию — %USERPROFILE%\.claude\settings.json. Код 1 — ошибка, файл не изменён.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookSettings } = require('./hook-settings');

const HOOK = path.join(__dirname, '..', 'hooks', 'bridge-hook.js');
const DEFAULT_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const USAGE = 'node tools/install-hooks.js install|uninstall|status [--settings <файл>] [--dry-run]';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const normPath = (p) => path.win32.normalize(p).toLowerCase();

/** Запись хука моста: в args — путь к bridge-hook.js (каталог любой). */
function isBridgeEntry(h) {
  return isObj(h) && Array.isArray(h.args) &&
    h.args.some((a) => typeof a === 'string' && path.win32.basename(a).toLowerCase() === 'bridge-hook.js');
}

function checkShape(settings) {
  if (!isObj(settings)) throw new Error('корень настроек — не JSON-объект');
  if (settings.hooks === undefined) return;
  if (!isObj(settings.hooks)) throw new Error('ключ hooks — не объект');
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${ev} — не массив`);
  }
}

const entriesOf = (groups) => (groups || []).flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []));

/** На каждом событии моста — ровно одна запись моста, exec-форма с этим путём. */
function isInstalled(settings, hookPath = HOOK) {
  checkShape(settings);
  const hooks = settings.hooks || {};
  return Object.keys(hookSettings(hookPath).hooks).every((ev) => {
    const ours = entriesOf(hooks[ev]).filter(isBridgeEntry);
    return ours.length === 1 && ours[0].type === 'command' && ours[0].command === 'node' &&
      ours[0].args.length === 1 && normPath(ours[0].args[0]) === normPath(hookPath);
  });
}

function removeBridgeHooks(settings) {
  checkShape(settings);
  const out = JSON.parse(JSON.stringify(settings));
  let removed = 0;
  if (!out.hooks) return { settings: out, removed };
  for (const ev of Object.keys(out.hooks)) {
    const before = removed;
    const kept = [];
    for (const g of out.hooks[ev]) {
      if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isBridgeEntry(h));
      removed += g.hooks.length - rest.length;
      // группа только из хука моста удаляется целиком; пустая группа пользователя остаётся как была
      if (rest.length || !g.hooks.length) kept.push(rest.length === g.hooks.length ? g : { ...g, hooks: rest });
    }
    if (removed > before && !kept.length) delete out.hooks[ev];
    else out.hooks[ev] = kept;
  }
  if (removed && !Object.keys(out.hooks).length) delete out.hooks;
  return { settings: out, removed };
}

function mergeBridgeHooks(settings, hookPath = HOOK) {
  if (isInstalled(settings, hookPath)) return { settings, changed: false, replaced: 0 };
  const { settings: out, removed } = removeBridgeHooks(settings); // записи со старым путём
  const want = hookSettings(hookPath).hooks;
  out.hooks = out.hooks || {};
  for (const ev of Object.keys(want)) out.hooks[ev] = [...(out.hooks[ev] || []), ...want[ev]];
  return { settings: out, changed: true, replaced: removed };
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, settings: {} };
    throw e;
  }
  text = text.replace(/^\uFEFF/, '');
  const settings = text.trim() ? JSON.parse(text) : {};
  checkShape(settings);
  return { exists: true, settings };
}

function backupName(file, now = new Date()) {
  return `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/** Записать настройки; существующий файл сначала копируется. Возвращает путь копии или null. */
function writeSettings(file, settings, exists) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (exists) {
    backup = backupName(file);
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backup;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let file = DEFAULT_SETTINGS;
  let dry = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--settings' && rest[i + 1]) file = path.resolve(rest[++i]);
    else if (rest[i] === '--dry-run') dry = true;
    else { console.error(`Неизвестный аргумент: ${rest[i]}\n${USAGE}`); return 1; }
  }
  if (!['install', 'uninstall', 'status'].includes(cmd)) { console.error(USAGE); return 1; }
  const pre = dry ? '[dry-run] ' : '';
  try {
    const cur = readSettings(file);
    if (cmd === 'status') {
      const ok = isInstalled(cur.settings);
      console.log(`Хук моста ${ok ? 'установлен' : 'не установлен'}: ${file}`);
      return ok ? 0 : 2;
    }
    if (cmd === 'install') {
      const r = mergeBridgeHooks(cur.settings);
      if (!r.changed) { console.log(`Хук моста уже установлен: ${file}`); return 0; }
      const old = r.replaced ? ` (записей со старым путём: ${r.replaced})` : '';
      if (dry) { console.log(`${pre}Хук моста будет добавлен в ${file}${old}`); return 0; }
      const backup = writeSettings(file, r.settings, cur.exists);
      console.log(`Хук моста добавлен в ${file}${old}`);
      if (backup) console.log(`Резервная копия: ${backup}`);
      return 0;
    }
    const r = removeBridgeHooks(cur.settings);
    if (!r.removed) { console.log(`Хука моста нет: ${file}`); return 0; }
    if (dry) { console.log(`${pre}Хук моста будет удалён из ${file} (записей: ${r.removed})`); return 0; }
    const backup = writeSettings(file, r.settings, true);
    console.log(`Хук моста удалён из ${file} (записей: ${r.removed})`);
    console.log(`Резервная копия: ${backup}`);
    return 0;
  } catch (e) {
    console.error(`Ошибка: ${file}: ${e.message} — файл не изменён`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { HOOK, DEFAULT_SETTINGS, isBridgeEntry, isInstalled, removeBridgeHooks, mergeBridgeHooks,
  readSettings, writeSettings, backupName, main };
```

- [ ] **Step 4: Проверить**

Run: `cd bridge && node --test test/install-hooks.test.js test/hook-settings.test.js`
Expected: `# fail 0`.

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bridge/tools/install-hooks.js bridge/test/install-hooks.test.js
git commit -m "feat(bridge): install-hooks merges the bridge hook into user settings.json (P-6)"
```

---

### Task 3: `install-lib.ps1` — чистые функции установщика

**Files:**
- Create: `bridge/tools/install-lib.ps1`, `bridge/tools/test-install-lib.ps1`
- Test: `bridge/test/install-lib.test.js`

- [ ] **Step 1: Тест-обёртка `node:test`**

`bridge/test/install-lib.test.js`:

```js
'use strict';
// Задача 3 подплана 4: чистые функции PowerShell-установщика (tools/test-install-lib.ps1) и
// кодировка .ps1 — UTF-8 с BOM (Windows PowerShell 5.1 читает файл без BOM как ANSI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function ps1Files() {
  const out = [];
  for (const d of ['', path.join('bridge', 'tools'), 'tools']) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.toLowerCase().endsWith('.ps1')) out.push(path.join(dir, f));
  }
  return out;
}

test('every .ps1 is UTF-8 with BOM', () => {
  const files = ps1Files();
  assert.ok(files.some((f) => f.endsWith('install-lib.ps1')), 'install-lib.ps1 found');
  for (const f of files) assert.deepStrictEqual([...fs.readFileSync(f).subarray(0, 3)], [0xef, 0xbb, 0xbf], f);
});

test('install-lib.ps1 pure functions (test-install-lib.ps1)', { timeout: 120000 }, () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'bridge', 'tools', 'test-install-lib.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 110000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /passes: \d+, fails: 0/);
});
```

- [ ] **Step 2: Проверки функций**

`bridge/tools/test-install-lib.ps1`:

```powershell
# Проверки чистых функций install-lib.ps1 (запускается из bridge/test/install-lib.test.js).
# Код выхода 0 — все проверки прошли, 1 — есть провалы (строки FAIL в выводе).
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
. (Join-Path $PSScriptRoot 'install-lib.ps1')

$script:pass = 0
$script:fail = 0
function Check([string]$What, $Actual, $Expected) {
  if ($Actual -ceq $Expected) { $script:pass++ }
  else { $script:fail++; Write-Output "FAIL $What`n  expected: [$Expected]`n  actual:   [$Actual]" }
}

Check 'node v24' (Test-CbNodeVersion -VersionText 'v24.8.0') $true
Check 'node v20' (Test-CbNodeVersion -VersionText 'v20.0.0') $true
Check 'node v18' (Test-CbNodeVersion -VersionText 'v18.19.1') $false
Check 'node garbage' (Test-CbNodeVersion -VersionText 'garbage') $false

Check 'same path: case, slash' (Test-CbSamePath -A 'C:\CB\bin\' -B 'c:\cb\BIN') $true
Check 'same path: different' (Test-CbSamePath -A 'C:\CB\bin' -B 'C:\CB\bin2') $false

Check 'path add to empty' (Add-CbPathEntry -PathValue '' -Entry 'C:\CB\bin') 'C:\CB\bin'
Check 'path add keeps %VAR%' (Add-CbPathEntry -PathValue 'C:\a;%USERPROFILE%\b;' -Entry 'C:\CB\bin') 'C:\a;%USERPROFILE%\b;C:\CB\bin'
Check 'path add idempotent' (Add-CbPathEntry -PathValue 'C:\a;c:\cb\BIN\' -Entry 'C:\CB\bin') 'C:\a;c:\cb\BIN\'
Check 'path remove' (Remove-CbPathEntry -PathValue 'C:\a;C:\CB\bin;%X%\c' -Entry 'c:\cb\bin\') 'C:\a;%X%\c'
Check 'path remove absent keeps text' (Remove-CbPathEntry -PathValue 'C:\a;;C:\b' -Entry 'C:\CB\bin') 'C:\a;;C:\b'
Check 'path remove the only entry' (Remove-CbPathEntry -PathValue 'C:\CB\bin' -Entry 'C:\CB\bin') ''

Check 'shim' (New-CbShimContent -AttachJs 'D:\r\bridge\attach.js') "@echo off`r`nnode `"D:\r\bridge\attach.js`" %*`r`n"

$t = Get-CbTaskSpec -NodeExe 'C:\Program Files\nodejs\node.exe' -BridgeDir 'D:\r\bridge'
Check 'task execute' $t.Execute 'C:\Program Files\nodejs\node.exe'
Check 'task argument' $t.Argument '"D:\r\bridge\start-bridge.js"'
Check 'task workdir' $t.WorkingDirectory 'D:\r\bridge'

$fw = Get-CbFirewallCommands -Port 8790 -Action add
Check 'fw add count' $fw.Count 4
Check 'fw delete tcp' ($fw[0] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-TCP'
Check 'fw add tcp' ($fw[1] -join ' ') 'advfirewall firewall add rule name=ClaudeBridge-TCP dir=in action=allow protocol=TCP localport=8790 profile=private'
Check 'fw delete udp' ($fw[2] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-UDP'
Check 'fw add udp' ($fw[3] -join ' ') 'advfirewall firewall add rule name=ClaudeBridge-UDP dir=in action=allow protocol=UDP localport=8791 profile=private'
$fr = Get-CbFirewallCommands -Port 9000 -Action remove
Check 'fw remove count' $fr.Count 2
Check 'fw remove udp' ($fr[1] -join ' ') 'advfirewall firewall delete rule name=ClaudeBridge-UDP'

Check 'cmdline match' (Test-CbCommandLineMatch -CommandLine '"C:\Program Files\nodejs\node.exe" D:\R\Bridge\keeper.js C:\x\s1.json' -Script 'd:\r\bridge\keeper.js') $true
Check 'cmdline other repo' (Test-CbCommandLineMatch -CommandLine 'node D:\other\bridge\keeper.js' -Script 'D:\r\bridge\keeper.js') $false
Check 'cmdline null' (Test-CbCommandLineMatch -CommandLine $null -Script 'D:\r\bridge\keeper.js') $false

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('cb-lib-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Check 'port: no config' (Get-CbBridgePort -ConfigPath (Join-Path $tmp 'none.json')) 8790
  Set-Content -LiteralPath (Join-Path $tmp 'c.json') -Value '{"port": 9100}' -Encoding ASCII
  Check 'port: from config' (Get-CbBridgePort -ConfigPath (Join-Path $tmp 'c.json')) 9100
  Set-Content -LiteralPath (Join-Path $tmp 'n.json') -Value '{"host": "auto"}' -Encoding ASCII
  Check 'port: default' (Get-CbBridgePort -ConfigPath (Join-Path $tmp 'n.json')) 8790
  Set-Content -LiteralPath (Join-Path $tmp 'bad.json') -Value '{"port": 70000}' -Encoding ASCII
  $threw = $false
  try { Get-CbBridgePort -ConfigPath (Join-Path $tmp 'bad.json') | Out-Null } catch { $threw = $true }
  Check 'port: invalid throws' $threw $true
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force
}

Write-Output "passes: $($script:pass), fails: $($script:fail)"
if ($script:fail) { exit 1 }
```

- [ ] **Step 3: Перевести в UTF-8 с BOM и убедиться, что проверки падают**

Перевести `bridge/tools/test-install-lib.ps1` в UTF-8 с BOM (команда из раздела «Кодировка» в начале плана).

Run: `cd bridge && node --test test/install-lib.test.js`
Expected: FAIL — `install-lib.ps1 found` (файла нет) и ненулевой код `test-install-lib.ps1`.

- [ ] **Step 4: Реализация**

`bridge/tools/install-lib.ps1`:

```powershell
# Функции установщика Claude Bridge (P-4, P-6, P-8). Подключается dot-source'ом из install.ps1,
# uninstall.ps1, firewall.ps1. Чистые функции (без побочных эффектов) проверяет test-install-lib.ps1;
# побочные эффекты — только у Get-/Set-CbUserPath, Send-CbEnvironmentChanged, Find-CbBridgeProcess.

# Правила брандмауэра (P-4): вход TCP <port> и UDP <port+1> (маяк), только профиль «Частная сеть».
$script:CbFirewallRules = @(
  @{ Name = 'ClaudeBridge-TCP'; Protocol = 'TCP'; Offset = 0 },
  @{ Name = 'ClaudeBridge-UDP'; Protocol = 'UDP'; Offset = 1 }
)

function Test-CbNodeVersion {
  param([Parameter(Mandatory)][string]$VersionText, [int]$MinMajor = 20)
  if ($VersionText.Trim() -notmatch '^v?(\d+)\.') { return $false }
  return ([int]$Matches[1] -ge $MinMajor)
}

function Test-CbSamePath {
  param([AllowEmptyString()][string]$A, [AllowEmptyString()][string]$B)
  $na = $A.Trim().Trim('"').TrimEnd('\').ToLowerInvariant()
  $nb = $B.Trim().Trim('"').TrimEnd('\').ToLowerInvariant()
  return ($na -ceq $nb)
}

# PATH пользователя как строка (REG_EXPAND_SZ, %VAR% не раскрываются): добавить каталог, если его нет.
function Add-CbPathEntry {
  param([AllowEmptyString()][string]$PathValue, [Parameter(Mandatory)][string]$Entry)
  foreach ($p in ($PathValue -split ';')) {
    if ($p.Trim() -and (Test-CbSamePath -A $p -B $Entry)) { return $PathValue }
  }
  $base = $PathValue.TrimEnd(';')
  if ($base) { return "$base;$Entry" }
  return $Entry
}

function Remove-CbPathEntry {
  param([AllowEmptyString()][string]$PathValue, [Parameter(Mandatory)][string]$Entry)
  $kept = @($PathValue -split ';' | Where-Object { -not ($_.Trim() -and (Test-CbSamePath -A $_ -B $Entry)) })
  return ($kept -join ';')
}

# Шим claude-mobile.cmd (P-4): node из PATH, как у bridge\claude-mobile.cmd.
function New-CbShimContent {
  param([Parameter(Mandatory)][string]$AttachJs)
  return "@echo off`r`nnode `"$AttachJs`" %*`r`n"
}

# Действие задачи Планировщика (P-4): node start-bridge.js из каталога моста.
function Get-CbTaskSpec {
  param([Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$BridgeDir)
  return @{
    Execute          = $NodeExe
    Argument         = ('"{0}"' -f (Join-Path $BridgeDir 'start-bridge.js'))
    WorkingDirectory = $BridgeDir
  }
}

# Аргументы netsh: сначала удалить одноимённое правило (повторная установка), затем добавить.
function Get-CbFirewallCommands {
  param([Parameter(Mandatory)][int]$Port, [ValidateSet('add', 'remove')][string]$Action = 'add')
  $cmds = @()
  foreach ($r in $script:CbFirewallRules) {
    $cmds += , @('advfirewall', 'firewall', 'delete', 'rule', "name=$($r.Name)")
    if ($Action -eq 'add') {
      $cmds += , @('advfirewall', 'firewall', 'add', 'rule', "name=$($r.Name)", 'dir=in', 'action=allow',
        "protocol=$($r.Protocol)", "localport=$($Port + $r.Offset)", 'profile=private')
    }
  }
  return , $cmds
}

# Порт моста из config.json каталога данных (как server.js: целое 1..65533, нет ключа — 8790).
function Get-CbBridgePort {
  param([Parameter(Mandatory)][string]$ConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return 8790 }
  $cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not ($cfg.PSObject.Properties.Name -contains 'port')) { return 8790 }
  $p = 0
  if ([int]::TryParse([string]$cfg.port, [ref]$p) -and $p -ge 1 -and $p -le 65533) { return $p }
  throw "Неверный port в $ConfigPath (нужно целое 1..65533)"
}

function Test-CbCommandLineMatch {
  param([AllowNull()][AllowEmptyString()][string]$CommandLine, [Parameter(Mandatory)][string]$Script)
  if (-not $CommandLine) { return $false }
  return $CommandLine.ToLowerInvariant().Contains($Script.ToLowerInvariant())
}

# Процессы node.exe этого репозитория: server — мост, keeper — хранители сессий.
function Find-CbBridgeProcess {
  param([Parameter(Mandatory)][string]$BridgeDir, [Parameter(Mandatory)][ValidateSet('server', 'keeper')][string]$Kind)
  $script = Join-Path $BridgeDir ($Kind + '.js')
  return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-CbCommandLineMatch -CommandLine $_.CommandLine -Script $script })
}

# Нативная команда (npm, node, netsh): её stderr — не ошибка PowerShell. При $ErrorActionPreference='Stop'
# Windows PowerShell 5.1 с перенаправленными потоками может превратить строку stderr в NativeCommandError.
# Код выхода — в $LASTEXITCODE, проверяет вызывающий.
function Invoke-CbNative {
  param([Parameter(Mandatory)][scriptblock]$Block)
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $eap }
}

function Test-CbElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# PATH пользователя — напрямую из реестра, без раскрытия %VAR% (иначе запись назад потеряла бы их).
function Get-CbUserPath {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if ($null -eq $k) { return '' }
  try { return [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $k.Close() }
}

function Set-CbUserPath {
  param([AllowEmptyString()][string]$Value)
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try { $k.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
  finally { $k.Close() }
  Send-CbEnvironmentChanged
}

# WM_SETTINGCHANGE "Environment": Проводник и новые окна консоли увидят новый PATH без выхода из системы.
function Send-CbEnvironmentChanged {
  if (-not ('CbNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CbNative {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
  }
  $result = [UIntPtr]::Zero
  [void][CbNative]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
```

Перевести `bridge/tools/install-lib.ps1` в UTF-8 с BOM.

- [ ] **Step 5: Проверить**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File bridge\tools\test-install-lib.ps1`
Expected: последняя строка `passes: 30, fails: 0`, код выхода 0.

Run: `cd bridge && node --test test/install-lib.test.js`
Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add bridge/tools/install-lib.ps1 bridge/tools/test-install-lib.ps1 bridge/test/install-lib.test.js
git commit -m "feat(install): pure installer helpers for PATH, shim, task, firewall (P-4, P-8)"
```

---

### Task 4: `install.ps1` и `firewall.ps1`

Шаги установки (P-8): проверка Node ≥ 20 (обязательно), Claude Code и opencode (предупреждение, если нет); `npm ci` в `bridge\`; каталог данных и `config.json` из примера; шим `claude-mobile.cmd` в `<каталог данных>\bin` и этот каталог в PATH пользователя (P-4); хук в `settings.json` (P-6, задача 2); задача Планировщика «при входе пользователя», в сеансе пользователя, не служба (P-4); правила брандмауэра — только с `-Firewall`, повышение прав через UAC только для них (P-4); запуск моста.

Защита от поломки реальной системы при проверках: нестандартный `-DataRoot` разрешён только вместе с `-SkipTask -SkipPath` (или `-DryRun`), и с ним установщик не трогает процессы моста и не запускает мост.

`npm ci` удаляет `bridge\node_modules`, а работающие мост и keeper'ы держат открытыми файлы `node-pty`: работающий мост установщик останавливает (сессии переживают рестарт), а при живых keeper'ах отказывается (`-SkipNpm` — обойти).

**Files:**
- Create: `install.ps1`, `bridge/tools/firewall.ps1`
- Test: `bridge/test/installer.test.js`

- [ ] **Step 1: Тест (только временные пути)**

`bridge/test/installer.test.js`:

```js
'use strict';
// Задачи 4–5 подплана 4: install.ps1 / uninstall.ps1 только на временных каталогах
// (-DataRoot, -SettingsPath, -SkipTask -SkipPath, -SkipNpm, -NoStart): реальные настройки
// пользователя, PATH, Планировщик, брандмауэр и процессы моста не трогаются.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookSettings } = require('../tools/hook-settings');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'bridge', 'hooks', 'bridge-hook.js');
const USER = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } };

function ps(script, args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, script), ...args], { encoding: 'utf8', windowsHide: true, timeout: 240000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function sandbox(t, withUserSettings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-inst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = { dir, data: path.join(dir, 'data'), settings: path.join(dir, 'claude', 'settings.json') };
  if (withUserSettings) {
    fs.mkdirSync(path.dirname(s.settings), { recursive: true });
    fs.writeFileSync(s.settings, JSON.stringify(USER));
  }
  s.safe = ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipTask', '-SkipPath'];
  return s;
}
const backups = (s) => fs.readdirSync(path.dirname(s.settings)).filter((f) => f.startsWith('settings.json.bak-'));

test('install.ps1 into temp paths: data dir, config, shim, hook; repeat changes nothing', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  const r = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.strictEqual(r.status, 0, r.out);
  for (const sub of ['sessions', 'logs', 'certs', 'bin']) assert.ok(fs.statSync(path.join(s.data, sub)).isDirectory(), sub);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.data, 'config.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge', 'config.example.json'), 'utf8')));
  assert.strictEqual(fs.readFileSync(path.join(s.data, 'bin', 'claude-mobile.cmd'), 'latin1'),
    `@echo off\r\nnode "${path.join(ROOT, 'bridge', 'attach.js')}" %*\r\n`);
  const st = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
  assert.strictEqual(st.model, 'opus');
  assert.deepStrictEqual(st.hooks.Stop[0], USER.hooks.Stop[0]);
  for (const [ev, groups] of Object.entries(hookSettings(HOOK).hooks)) assert.deepStrictEqual(st.hooks[ev].slice(-1), groups, ev);
  assert.strictEqual(backups(s).length, 1);

  const before = fs.readFileSync(s.settings, 'utf8');
  const r2 = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.strictEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /Конфиг уже есть/);
  assert.match(r2.out, /уже установлен/);
  assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), before);
  assert.strictEqual(backups(s).length, 1);
});

test('install.ps1 -DryRun (with npm and firewall steps) changes nothing', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  const r = ps('install.ps1', [...s.safe, '-DryRun', '-Firewall', '-NoStart']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /\[dry-run\] npm ci/);
  assert.match(r.out, /\[dry-run\] Хук моста будет добавлен/);
  assert.match(r.out, /\[dry-run\] netsh advfirewall firewall add rule name=ClaudeBridge-TCP .*localport=8790 profile=private/);
  assert.match(r.out, /\[dry-run\] netsh advfirewall firewall add rule name=ClaudeBridge-UDP .*localport=8791 profile=private/);
  assert.ok(!fs.existsSync(s.data), 'no data dir');
  assert.ok(!fs.existsSync(s.settings), 'no settings');
});

test('install.ps1 refuses a custom -DataRoot without -SkipTask -SkipPath', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  const r = ps('install.ps1', ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipNpm', '-NoStart']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /только для проверки/);
  assert.ok(!fs.existsSync(s.data));
  assert.ok(!fs.existsSync(s.settings));
});

test('install.ps1 stops on a broken settings.json and leaves it as is', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  fs.mkdirSync(path.dirname(s.settings), { recursive: true });
  fs.writeFileSync(s.settings, '{ "hooks": ');
  const r = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /файл не изменён/);
  assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), '{ "hooks": ');
  assert.deepStrictEqual(backups(s), []);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd bridge && node --test test/installer.test.js`
Expected: FAIL — `install.ps1` не найден (ненулевой код, сообщение PowerShell о несуществующем файле).

- [ ] **Step 3: `firewall.ps1`**

`bridge/tools/firewall.ps1`:

```powershell
# Правила брандмауэра моста (P-4): вход TCP <port> и UDP <port+1> только в профиле «Частная сеть».
# Нужны права администратора: install.ps1 / uninstall.ps1 запускают этот файл с повышением (UAC).
param(
  [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Action,
  [int]$Port = 8790,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
. (Join-Path $PSScriptRoot 'install-lib.ps1')

foreach ($c in (Get-CbFirewallCommands -Port $Port -Action $Action)) {
  if ($DryRun) { Write-Output ('[dry-run] netsh ' + ($c -join ' ')); continue }
  Invoke-CbNative { & netsh @c } | Out-Null
  # delete без совпадений возвращает 1 — это нормально (правила ещё не было)
  if ($c[2] -ne 'delete' -and $LASTEXITCODE -ne 0) { throw "netsh $($c -join ' ') завершился с кодом $LASTEXITCODE" }
}
if (-not $DryRun) {
  if ($Action -eq 'add') { Write-Output "Правила брандмауэра добавлены: TCP $Port, UDP $($Port + 1), профиль «Частная сеть»" }
  else { Write-Output 'Правила брандмауэра ClaudeBridge-TCP / ClaudeBridge-UDP удалены' }
}
```

- [ ] **Step 4: `install.ps1`**

`install.ps1` (корень репозитория):

```powershell
<#
.SYNOPSIS
  Установка Claude Bridge на личный Windows-ПК (P-4, P-6, P-8).
.DESCRIPTION
  Проверка Node.js / Claude Code / opencode, npm ci в bridge\, каталог данных и config.json,
  шим claude-mobile в PATH пользователя, хук Claude Code в settings.json пользователя (с резервной
  копией), задача Планировщика «при входе», запуск моста. -Firewall — правила брандмауэра (UAC).
  Повторный запуск безопасен (обновление после git pull).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Firewall
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'),
  [string]$SettingsPath = (Join-Path $env:USERPROFILE '.claude\settings.json'),
  [string]$TaskName = 'ClaudeBridge',
  [switch]$Firewall,
  [switch]$SkipNpm,
  [switch]$SkipTask,
  [switch]$SkipPath,
  [switch]$SkipHook,
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$prevEncoding = [Console]::OutputEncoding
$failed = $false
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  . (Join-Path $PSScriptRoot 'bridge\tools\install-lib.ps1')

  $RepoRoot = $PSScriptRoot
  $BridgeDir = Join-Path $RepoRoot 'bridge'
  $DataRoot = [IO.Path]::GetFullPath($DataRoot)
  $CustomData = -not (Test-CbSamePath -A $DataRoot -B (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'))
  $BinDir = Join-Path $DataRoot 'bin'
  $Shim = Join-Path $BinDir 'claude-mobile.cmd'
  $Config = Join-Path $DataRoot 'config.json'
  $Pre = if ($DryRun) { '[dry-run] ' } else { '' }
  function Say([string]$Text) { Write-Output ($Pre + $Text) }

  if ($CustomData -and -not $DryRun -and -not ($SkipTask -and $SkipPath)) {
    throw "Нестандартный -DataRoot ($DataRoot) — только для проверки: задача Планировщика и PATH о нём не знают. Добавьте -SkipTask -SkipPath или -DryRun."
  }
  Write-Output "Claude Bridge: установка из $RepoRoot"

  # 1. Проверки
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { throw 'Node.js не найден в PATH (нужна версия 20 или новее): https://nodejs.org/' }
  $nodeVersion = ([string](& $node.Source -v)).Trim()
  if (-not (Test-CbNodeVersion -VersionText $nodeVersion)) { throw "Нужен Node.js 20 или новее, найден $nodeVersion" }
  Write-Output "  Node.js $nodeVersion — $($node.Source)"
  foreach ($agent in @(@{ Cmd = 'claude'; Name = 'Claude Code' }, @{ Cmd = 'opencode'; Name = 'opencode' })) {
    $c = Get-Command $agent.Cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { Write-Output "  $($agent.Name): $($c.Source)" }
    else { Write-Warning "$($agent.Name) не найден в PATH — этот агент будет недоступен мосту" }
  }

  # 2. Зависимости моста
  if (-not $SkipNpm) {
    if (-not $CustomData) {
      $keepers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind keeper)
      if ($keepers.Count) {
        $msg = "Живые сессии моста ($($keepers.Count)) держат файлы bridge\node_modules — завершите их (выйдите из агентов) или запустите install.ps1 -SkipNpm"
        if ($DryRun) { Write-Warning $msg } else { throw $msg }
      }
      $servers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind server)
      if ($servers.Count) {
        Say "Останавливаю работающий мост (PID $(($servers | ForEach-Object { $_.ProcessId }) -join ', ')) — сессии не затрагиваются"
        if (-not $DryRun) { $servers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Milliseconds 500 }
      }
    }
    Say 'npm ci в bridge\ (зависимости моста)'
    if (-not $DryRun) {
      Push-Location $BridgeDir
      try {
        Invoke-CbNative { & npm ci --no-audit --no-fund }
        if ($LASTEXITCODE -ne 0) { throw "npm ci завершился с кодом $LASTEXITCODE" }
      } finally { Pop-Location }
    }
  }

  # 3. Каталог данных и конфиг (мост сделал бы то же при первом старте)
  foreach ($sub in @('', 'sessions', 'logs', 'certs', 'bin')) {
    $d = if ($sub) { Join-Path $DataRoot $sub } else { $DataRoot }
    if (-not (Test-Path -LiteralPath $d)) {
      Say "Каталог $d"
      if (-not $DryRun) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
  }
  if (Test-Path -LiteralPath $Config) { Write-Output "  Конфиг уже есть: $Config (не изменяется)" }
  else {
    Say "Конфиг $Config (из bridge\config.example.json)"
    if (-not $DryRun) { Copy-Item -LiteralPath (Join-Path $BridgeDir 'config.example.json') -Destination $Config }
  }

  # 4. Шим claude-mobile (P-4); .cmd читается cmd.exe в OEM-кодировке
  Say "Шим claude-mobile: $Shim"
  if (-not $DryRun) {
    $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
    [IO.File]::WriteAllText($Shim, (New-CbShimContent -AttachJs (Join-Path $BridgeDir 'attach.js')), $oem)
  }

  # 5. PATH пользователя (P-4)
  if (-not $SkipPath) {
    $cur = Get-CbUserPath
    $new = Add-CbPathEntry -PathValue $cur -Entry $BinDir
    if ($new -ceq $cur) { Write-Output "  $BinDir уже в PATH пользователя" }
    else {
      Say "Добавляю $BinDir в PATH пользователя (действует в новых окнах консоли)"
      if (-not $DryRun) { Set-CbUserPath -Value $new }
    }
  }

  # 6. Хук Claude Code (P-6)
  if (-not $SkipHook) {
    $hookArgs = @((Join-Path $BridgeDir 'tools\install-hooks.js'), 'install', '--settings', $SettingsPath)
    if ($DryRun) { $hookArgs += '--dry-run' }
    Invoke-CbNative { & $node.Source @hookArgs }
    if ($LASTEXITCODE -ne 0) { throw "Хук Claude Code не установлен (код $LASTEXITCODE)" }
  }

  # 7. Задача Планировщика (P-4): при входе пользователя, в его сеансе, не служба
  if (-not $SkipTask) {
    $spec = Get-CbTaskSpec -NodeExe $node.Source -BridgeDir $BridgeDir
    $user = "$env:USERDOMAIN\$env:USERNAME"
    Say "Задача Планировщика «$TaskName»: при входе $user -> $($spec.Execute) $($spec.Argument)"
    if (-not $DryRun) {
      $action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Argument -WorkingDirectory $spec.WorkingDirectory
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
      try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
          -Settings $settings -Description 'Claude Bridge: мост телефон <-> агенты (P-4)' -Force | Out-Null
      } catch {
        throw "Не удалось зарегистрировать задачу Планировщика: $($_.Exception.Message). Если это отказ в доступе — повторите в PowerShell от администратора: install.ps1 -SkipNpm"
      }
    }
  }

  # 8. Брандмауэр (P-4, по желанию): повышение прав — только для этого шага
  if ($Firewall) {
    $port = Get-CbBridgePort -ConfigPath $Config
    $fwScript = Join-Path $BridgeDir 'tools\firewall.ps1'
    if ($DryRun) { & $fwScript -Action add -Port $port -DryRun }
    elseif (Test-CbElevated) { & $fwScript -Action add -Port $port }
    else {
      Write-Output '  Правила брандмауэра требуют прав администратора — Windows запросит подтверждение (UAC)'
      try {
        $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru `
          -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$fwScript`" -Action add -Port $port"
        if ($p.ExitCode -eq 0) { Write-Output "  Правила брандмауэра добавлены: TCP $port, UDP $($port + 1), профиль «Частная сеть»" }
        else { Write-Warning "Правила брандмауэра не добавлены (код $($p.ExitCode))" }
      } catch { Write-Warning "Правила брандмауэра не добавлены: $($_.Exception.Message)" }
    }
  }

  # 9. Запуск моста
  if ($NoStart -or $CustomData) { Write-Output '  Мост не запускается (-NoStart или нестандартный -DataRoot)' }
  else {
    Say 'Запускаю мост'
    if (-not $DryRun) {
      if (-not $SkipTask) { Start-ScheduledTask -TaskName $TaskName }
      else { & $node.Source (Join-Path $BridgeDir 'start-bridge.js') }
      $port = Get-CbBridgePort -ConfigPath $Config
      $deadline = (Get-Date).AddSeconds(30)
      $up = $false
      while (-not $up -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $up = [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) -and
          (@(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind server).Count -gt 0)
      }
      $log = Join-Path $DataRoot 'logs\bridge.log'
      if ($up) { Write-Output "  Мост слушает порт $port; лог: $log" }
      else { Write-Warning "Мост не начал слушать порт $port за 30 с — смотрите $log" }
    }
  }

  Write-Output ''
  Write-Output 'Готово. Дальше:'
  Write-Output '  1. Откройте НОВОЕ окно консоли (PATH обновлён) и выполните: claude-mobile --qr'
  Write-Output '  2. Отсканируйте QR в приложении Claude Bridge на телефоне.'
  Write-Output '  Сессия с зеркалом на телефон: claude-mobile (агент по умолчанию) или claude-mobile --agent opencode'
  Write-Output "  Конфиг: $Config"
} catch {
  # своё сообщение, пока вывод в UTF-8: необработанную ошибку PowerShell напечатал бы уже
  # после восстановления кодировки консоли (кириллица в перенаправленном выводе ломается)
  Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
  $failed = $true
} finally {
  try { [Console]::OutputEncoding = $prevEncoding } catch { }
}
if ($failed) { exit 1 }
```

Перевести `install.ps1` и `bridge/tools/firewall.ps1` в UTF-8 с BOM.

- [ ] **Step 5: Проверить**

Run: `cd bridge && node --test test/installer.test.js test/install-lib.test.js`
Expected: `# fail 0` (4 теста установщика + 2 теста библиотеки).

Run (ручной осмотр сухого прогона на реальных путях — ничего не меняет):
`powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun -Firewall`
Expected: строки `[dry-run] …` для `npm ci`, каталогов (если их нет), шима, PATH (если каталога нет в PATH), `[dry-run] Хук моста будет добавлен в C:\Users\<пользователь>\.claude\settings.json` (или «уже установлен»), задачи `ClaudeBridge`, `[dry-run] netsh … ClaudeBridge-TCP … localport=8790 …`, `[dry-run] Запускаю мост`; после прогона `git status` чист, `Get-ScheduledTask ClaudeBridge -ErrorAction SilentlyContinue` ничего не выводит, `node bridge\tools\install-hooks.js status` — код как до прогона.

- [ ] **Step 6: Commit**

```bash
git add install.ps1 bridge/tools/firewall.ps1 bridge/test/installer.test.js
git commit -m "feat(install): install.ps1 with dry run, logon task, PATH shim, hook, optional firewall (P-4, P-6, P-8)"
```

---

### Task 5: `uninstall.ps1`

Обратные шаги: задача Планировщика; работающий мост этого репозитория (keeper'ы не трогаются — живые сессии работают до выхода из агента); записи хука моста в `settings.json` (с резервной копией); каталог из PATH и шим; правила брандмауэра (`-Firewall`, UAC); каталог данных — только с `-RemoveData` (сопряжения, сертификат, токены: телефоны придётся сопрячь заново) и только если нет живых keeper'ов. `bridge\node_modules` и клон репозитория не удаляются. Защита для проверок — как в установщике.

**Files:**
- Create: `uninstall.ps1`
- Modify: `bridge/test/installer.test.js`

- [ ] **Step 1: Тест**

Добавить в конец `bridge/test/installer.test.js`:

```js
test('uninstall.ps1 reverses install on temp paths; -RemoveData removes the data dir', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  const inst = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.strictEqual(inst.status, 0, inst.out);
  const shim = path.join(s.data, 'bin', 'claude-mobile.cmd');

  const dry = ps('uninstall.ps1', [...s.safe, '-DryRun', '-RemoveData', '-Firewall']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] Хук моста будет удалён/);
  assert.match(dry.out, /\[dry-run\] netsh advfirewall firewall delete rule name=ClaudeBridge-TCP/);
  assert.ok(fs.existsSync(shim), 'dry run kept the shim');
  assert.ok(fs.existsSync(path.join(s.data, 'config.json')), 'dry run kept the data');

  const r = ps('uninstall.ps1', s.safe);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), USER);
  assert.ok(!fs.existsSync(shim), 'shim removed');
  assert.ok(fs.existsSync(path.join(s.data, 'config.json')), 'data kept without -RemoveData');

  const r2 = ps('uninstall.ps1', [...s.safe, '-RemoveData']);
  assert.strictEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /Хука моста нет/);
  assert.ok(!fs.existsSync(s.data), 'data dir removed');
});

test('uninstall.ps1 refuses a custom -DataRoot without -SkipTask -SkipPath', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  const r = ps('uninstall.ps1', ['-DataRoot', s.data, '-SettingsPath', s.settings]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /только для проверки/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), USER);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd bridge && node --test test/installer.test.js`
Expected: 2 новых теста FAIL (`uninstall.ps1` не найден), прежние 4 — pass.

- [ ] **Step 3: Реализация**

`uninstall.ps1` (корень репозитория):

```powershell
<#
.SYNOPSIS
  Удаление установки Claude Bridge (обратное install.ps1).
.DESCRIPTION
  Задача Планировщика, работающий мост, хук моста в settings.json (с резервной копией), шим и
  каталог в PATH; -Firewall — правила брандмауэра (UAC); -RemoveData — каталог данных
  (сопряжения, сертификат, токены). Живые сессии (keeper'ы) не завершаются.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'),
  [string]$SettingsPath = (Join-Path $env:USERPROFILE '.claude\settings.json'),
  [string]$TaskName = 'ClaudeBridge',
  [switch]$Firewall,
  [switch]$RemoveData,
  [switch]$SkipTask,
  [switch]$SkipPath,
  [switch]$SkipHook
)
$ErrorActionPreference = 'Stop'
$prevEncoding = [Console]::OutputEncoding
$failed = $false
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try {
  . (Join-Path $PSScriptRoot 'bridge\tools\install-lib.ps1')

  $BridgeDir = Join-Path $PSScriptRoot 'bridge'
  $DataRoot = [IO.Path]::GetFullPath($DataRoot)
  $CustomData = -not (Test-CbSamePath -A $DataRoot -B (Join-Path $env:LOCALAPPDATA 'ClaudeBridge'))
  $BinDir = Join-Path $DataRoot 'bin'
  $Shim = Join-Path $BinDir 'claude-mobile.cmd'
  $Config = Join-Path $DataRoot 'config.json'
  $Pre = if ($DryRun) { '[dry-run] ' } else { '' }
  function Say([string]$Text) { Write-Output ($Pre + $Text) }

  if ($CustomData -and -not $DryRun -and -not ($SkipTask -and $SkipPath)) {
    throw "Нестандартный -DataRoot ($DataRoot) — только для проверки. Добавьте -SkipTask -SkipPath или -DryRun."
  }
  $keepers = @()
  if (-not $CustomData) { $keepers = @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind keeper) }
  if ($RemoveData -and $keepers.Count -and -not $DryRun) {
    throw "Живые сессии моста ($($keepers.Count)) используют каталог данных — завершите их (выйдите из агентов) и повторите"
  }
  # порт — до удаления каталога данных
  $port = Get-CbBridgePort -ConfigPath $Config

  # 1. Задача Планировщика
  if (-not $SkipTask) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Say "Удаляю задачу Планировщика «$TaskName»"
      if (-not $DryRun) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    } else { Write-Output "  Задачи «$TaskName» нет" }
  }

  # 2. Процессы моста этого репозитория
  if ($CustomData) { Write-Output '  Процессы моста не затрагиваются (нестандартный -DataRoot)' }
  else {
    foreach ($s in @(Find-CbBridgeProcess -BridgeDir $BridgeDir -Kind server)) {
      Say "Останавливаю мост (PID $($s.ProcessId))"
      if (-not $DryRun) { Stop-Process -Id $s.ProcessId -Force }
    }
    if ($keepers.Count) { Write-Warning "Живые сессии ($($keepers.Count)) продолжают работать до выхода из агентов; мост больше не запустится" }
  }

  # 3. Хук Claude Code
  if (-not $SkipHook) {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { Write-Warning "Node.js не найден — удалите записи с bridge-hook.js из $SettingsPath вручную" }
    else {
      $hookArgs = @((Join-Path $BridgeDir 'tools\install-hooks.js'), 'uninstall', '--settings', $SettingsPath)
      if ($DryRun) { $hookArgs += '--dry-run' }
      Invoke-CbNative { & $node.Source @hookArgs }
      if ($LASTEXITCODE -ne 0) { throw "Хук Claude Code не удалён (код $LASTEXITCODE)" }
    }
  }

  # 4. PATH и шим
  if (-not $SkipPath) {
    $cur = Get-CbUserPath
    $new = Remove-CbPathEntry -PathValue $cur -Entry $BinDir
    if ($new -cne $cur) {
      Say "Убираю $BinDir из PATH пользователя"
      if (-not $DryRun) { Set-CbUserPath -Value $new }
    }
  }
  if (Test-Path -LiteralPath $Shim) {
    Say "Удаляю шим $Shim"
    if (-not $DryRun) {
      Remove-Item -LiteralPath $Shim -Force
      if (-not (Get-ChildItem -LiteralPath $BinDir -Force)) { Remove-Item -LiteralPath $BinDir -Force }
    }
  }

  # 5. Брандмауэр
  if ($Firewall) {
    $fwScript = Join-Path $BridgeDir 'tools\firewall.ps1'
    if ($DryRun) { & $fwScript -Action remove -Port $port -DryRun }
    elseif (Test-CbElevated) { & $fwScript -Action remove -Port $port }
    else {
      Write-Output '  Удаление правил брандмауэра требует прав администратора — Windows запросит подтверждение (UAC)'
      try {
        $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru `
          -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$fwScript`" -Action remove -Port $port"
        if ($p.ExitCode -ne 0) { Write-Warning "Правила брандмауэра не удалены (код $($p.ExitCode))" }
      } catch { Write-Warning "Правила брандмауэра не удалены: $($_.Exception.Message)" }
    }
  }

  # 6. Каталог данных
  if ($RemoveData) {
    if (Test-Path -LiteralPath $DataRoot) {
      Say "Удаляю каталог данных $DataRoot (сопряжения, сертификат, токены — телефоны придётся сопрячь заново)"
      if (-not $DryRun) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
    }
  } elseif (Test-Path -LiteralPath $DataRoot) {
    Write-Output "  Каталог данных сохранён: $DataRoot (удалить: uninstall.ps1 -RemoveData)"
  }
  Write-Output 'Готово. bridge\node_modules и клон репозитория не удалялись.'
} catch {
  # своё сообщение, пока вывод в UTF-8: необработанную ошибку PowerShell напечатал бы уже
  # после восстановления кодировки консоли (кириллица в перенаправленном выводе ломается)
  Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
  $failed = $true
} finally {
  try { [Console]::OutputEncoding = $prevEncoding } catch { }
}
if ($failed) { exit 1 }
```

Перевести `uninstall.ps1` в UTF-8 с BOM.

- [ ] **Step 4: Проверить**

Run: `cd bridge && node --test test/installer.test.js test/install-lib.test.js`
Expected: `# fail 0` (6 тестов установщика, 2 — библиотеки).

Run: `cd bridge && npm test`
Expected: `# fail 0`.

Run (только чтение реальной системы): `powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -DryRun -Firewall`
Expected: строки `[dry-run] …` либо «Задачи … нет» / «Хука моста нет»; после прогона `git status` чист, ничего в системе не изменилось.

- [ ] **Step 5: Commit**

```bash
git add uninstall.ps1 bridge/test/installer.test.js
git commit -m "feat(install): uninstall.ps1 reverses the installation (P-8)"
```

---

### Task 6: Wrapper Gradle 8.7 с `distributionSha256Sum` (S-1) — проверить и пропустить, если сделано

Поправка 9 подплана 3 разрешила пересоздать wrapper там. Эта задача сначала проверяет состояние; выполняется, только если wrapper ещё не официальный.

**Files:**
- Modify (если не сделано): `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradle/wrapper/gradle-wrapper.properties`, `android/gradlew`
- Create (если не сделано): `android/gradlew.bat`

- [ ] **Step 1: Контрольные суммы с gradle.org**

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-RemoteSha([string]$Url) {
  $c = (Invoke-WebRequest -UseBasicParsing -Uri $Url).Content
  if ($c -is [byte[]]) { $c = [Text.Encoding]::ASCII.GetString($c) }
  return $c.Trim().ToLowerInvariant()
}
$binSha = Get-RemoteSha 'https://services.gradle.org/distributions/gradle-8.7-bin.zip.sha256'
$jarSha = Get-RemoteSha 'https://services.gradle.org/distributions/gradle-8.7-wrapper.jar.sha256'
"bin=$binSha"; "jar=$jarSha"
```

Expected: две строки по 64 hex-символа. Записать оба значения в отчёт по задаче.

- [ ] **Step 2: Состояние wrapper**

```powershell
$props = Get-Content android\gradle\wrapper\gradle-wrapper.properties -Raw
$jarNow = (Get-FileHash -Algorithm SHA256 android\gradle\wrapper\gradle-wrapper.jar).Hash.ToLowerInvariant()
"url8.7=$($props -match 'gradle-8\.7-bin\.zip')"
"sumInProps=$($props -match ('distributionSha256Sum=' + $binSha))"
"jarOfficial=$($jarNow -eq $jarSha)"
"gradlewBat=$(Test-Path android\gradlew.bat)"
```

Если все четыре строки — `True`: задача уже выполнена (подпланом 3) — отметить шаги 3–6 как пропущенные с этим выводом в отчёте и перейти к задаче 7. Иначе — шаги 3–6.

- [ ] **Step 3: Официальный дистрибутив Gradle 8.7 во временный каталог**

```powershell
$g = Join-Path $env:TEMP 'cb-gradle-8.7'
New-Item -ItemType Directory -Path $g -Force | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri 'https://services.gradle.org/distributions/gradle-8.7-bin.zip' -OutFile "$g\gradle-8.7-bin.zip"
$got = (Get-FileHash -Algorithm SHA256 "$g\gradle-8.7-bin.zip").Hash.ToLowerInvariant()
if ($got -ne $binSha) { throw "SHA-256 дистрибутива не совпал: $got" }
Expand-Archive -LiteralPath "$g\gradle-8.7-bin.zip" -DestinationPath $g -Force
```

Expected: без ошибок; есть `$g\gradle-8.7\bin\gradle.bat`.

- [ ] **Step 4: Пересоздать wrapper**

```powershell
$env:JAVA_HOME = 'C:\Users\doale\AppData\Local\Programs\Temurin\jdk-17'
& "$g\gradle-8.7\bin\gradle.bat" -p android --no-daemon wrapper --gradle-version 8.7 --distribution-type bin --gradle-distribution-sha256-sum $binSha
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Проверить**

Повторить шаг 2. Expected: четыре `True`.

```powershell
Push-Location android; .\gradlew.bat --no-daemon --version; Pop-Location
```

Expected: строка `Gradle 8.7`.

- [ ] **Step 6: Commit**

```bash
git add android/gradlew android/gradlew.bat android/gradle/wrapper/gradle-wrapper.jar android/gradle/wrapper/gradle-wrapper.properties
git commit -m "build(android): official Gradle 8.7 wrapper with distributionSha256Sum (P-8, S-1)"
```

---

### Task 7: Release-сборка — подпись ключом команды, `debuggable false` (P-8, M-5)

Ключ и пароль — только вне репозитория: свойства Gradle `cbReleaseStoreFile`, `cbReleaseKeyAlias`, `cbReleaseStorePassword`, `cbReleaseKeyPassword` (`tools/release.ps1` передаёт их переменными `ORG_GRADLE_PROJECT_*` только процессу Gradle). Без свойств release собирается неподписанным (`app-release-unsigned.apk`). Проверка — временным ключом во временном каталоге; ключ команды в этой задаче не создаётся (задача 10).

**Files:**
- Modify: `android/app/build.gradle`

- [ ] **Step 1: Конфигурация подписи**

В `android/app/build.gradle` заменить блок

```groovy
    buildTypes {
        release {
            minifyEnabled false
        }
    }
```

на

```groovy
    // P-8: release подписывается ключом команды. Ключ и пароль — только вне репозитория:
    // свойства Gradle cbReleaseStoreFile / cbReleaseKeyAlias / cbReleaseStorePassword /
    // cbReleaseKeyPassword (tools/release.ps1 передаёт их через ORG_GRADLE_PROJECT_*).
    // Без них release собирается неподписанным (app-release-unsigned.apk).
    signingConfigs {
        if (project.hasProperty('cbReleaseStoreFile')) {
            release {
                storeFile file(project.property('cbReleaseStoreFile'))
                storePassword project.findProperty('cbReleaseStorePassword')
                keyAlias project.findProperty('cbReleaseKeyAlias')
                keyPassword project.findProperty('cbReleaseKeyPassword')
            }
        }
    }

    buildTypes {
        release {
            minifyEnabled false
            debuggable false // M-5: явно, независимо от умолчаний AGP
            if (project.hasProperty('cbReleaseStoreFile')) {
                signingConfig signingConfigs.release
            }
        }
    }
```

- [ ] **Step 2: Release без ключа — неподписанный и не debuggable**

```powershell
$env:JAVA_HOME = 'C:\Users\doale\AppData\Local\Programs\Temurin\jdk-17'
$bt = 'C:\Users\doale\AppData\Local\Android\Sdk\build-tools\34.0.0'
Push-Location android; .\gradlew.bat --no-daemon clean :app:assembleRelease; Pop-Location
Test-Path android\app\build\outputs\apk\release\app-release-unsigned.apk
& "$bt\aapt.exe" dump badging android\app\build\outputs\apk\release\app-release-unsigned.apk | Select-String 'application-debuggable'
```

Expected: `BUILD SUCCESSFUL`; `True`; `Select-String` ничего не выводит.

- [ ] **Step 3: Release с временным ключом — подписан**

```powershell
$k = Join-Path $env:TEMP ('cb-testkey-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $k | Out-Null
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore "$k\test.jks" -storetype PKCS12 -alias test -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=cb-test' -storepass test-pass-123 -keypass test-pass-123 -noprompt
Push-Location android
.\gradlew.bat --no-daemon :app:assembleRelease "-PcbReleaseStoreFile=$k\test.jks" -PcbReleaseKeyAlias=test -PcbReleaseStorePassword=test-pass-123 -PcbReleaseKeyPassword=test-pass-123
Pop-Location
& "$bt\apksigner.bat" verify --print-certs android\app\build\outputs\apk\release\app-release.apk
Remove-Item -LiteralPath $k -Recurse -Force
```

Expected: `BUILD SUCCESSFUL`; вывод `apksigner` содержит `Signer #1 certificate DN: CN=cb-test` и `Signer #1 certificate SHA-256 digest: <64 hex>`, код выхода 0.

- [ ] **Step 4: Debug не сломан**

```powershell
Push-Location android; .\gradlew.bat --no-daemon :app:assembleDebug :app:testDebugUnitTest; Pop-Location
& "$bt\aapt.exe" dump badging android\app\build\outputs\apk\debug\app-debug.apk | Select-String 'application-debuggable'
```

Expected: `BUILD SUCCESSFUL`; строка `application-debuggable`.

- [ ] **Step 5: Commit**

```bash
git add android/app/build.gradle
git commit -m "build(android): release signed with the team key from Gradle properties; debuggable false (P-8, M-5)"
```

---

### Task 8: `tools/release.ps1` — артефакты, SHA-256, release notes

Сценарий собирает в `dist\` (каталог пересоздаётся): `claude-tunnel.exe` (`x86_64-pc-windows-msvc`, `--locked`, копия — в `bridge\bin\`); `libclaudetunnel.so` (`aarch64-linux-android`, NDK — задача 9; копия — в `android\app\src\main\jniLibs\arm64-v8a\`); `ClaudeBridge-<versionName>.apk` (release, ключ команды; проверки `apksigner verify` и отсутствие `application-debuggable`); `SHA256SUMS.txt`; `RELEASE_NOTES.md` (коммит, версии инструментов, SHA-256 файлов и сертификата подписи). Пароль ключа — `Read-Host -AsSecureString`, передаётся только процессу Gradle (`--no-daemon`, чтобы пароль не оставался в демоне) и стирается из окружения после сборки.

**Files:**
- Create: `tools/release.ps1`
- Modify: `.gitignore`

- [ ] **Step 1: `.gitignore`**

В блок `# --- Прочее ---` файла `.gitignore` добавить строку:

```gitignore
dist/
```

- [ ] **Step 2: Сценарий**

`tools/release.ps1`:

```powershell
<#
.SYNOPSIS
  Сборка релиза Claude Bridge (P-8) в dist\.
.DESCRIPTION
  claude-tunnel.exe (x86_64-pc-windows-msvc), libclaudetunnel.so (aarch64-linux-android, нужен
  Android NDK), release-APK, подписанный ключом команды; SHA256SUMS.txt и RELEASE_NOTES.md с
  SHA-256 артефактов и сертификата подписи APK. Ключ и пароль в репозиторий не попадают.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -KeystorePath D:\keys\claude-bridge-team.jks
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk -SkipAndroidTunnel
#>
[CmdletBinding()]
param(
  [string]$KeystorePath,
  [string]$KeyAlias = 'claude-bridge-team',
  [switch]$SkipApk,
  [switch]$SkipAndroidTunnel,
  [string]$NdkVersion = '28.2.13676358',
  [string]$SdkDir = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }),
  [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Join-Path $env:LOCALAPPDATA 'Programs\Temurin\jdk-17' }),
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
$Cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $Cargo)) {
  $c = Get-Command cargo -ErrorAction SilentlyContinue
  if ($c) { $Cargo = $c.Source } else { throw 'cargo не найден: установите Rust (https://rustup.rs/)' }
}
$BuildTools = Join-Path $SdkDir 'build-tools\34.0.0'

function Invoke-Checked([string]$What, [scriptblock]$Block) {
  # stderr cargo/gradle — не ошибка PowerShell (см. Invoke-CbNative в bridge\tools\install-lib.ps1)
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $eap }
  if ($LASTEXITCODE -ne 0) { throw "$What завершился с кодом $LASTEXITCODE" }
}

if (-not $SkipApk) {
  if (-not $KeystorePath) { throw 'Укажите -KeystorePath (хранилище ключа команды) или -SkipApk' }
  if (-not (Test-Path -LiteralPath $KeystorePath)) { throw "Нет файла ключа: $KeystorePath" }
}

if (Test-Path -LiteralPath $OutDir) { Remove-Item -LiteralPath $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null
$artifacts = New-Object System.Collections.Generic.List[string]

# 1. Туннель для ПК
Write-Output '== claude-tunnel.exe (x86_64-pc-windows-msvc)'
Push-Location (Join-Path $Root 'tunnel')
try { Invoke-Checked 'cargo build (windows)' { & $Cargo build --release --locked } } finally { Pop-Location }
$exe = Join-Path $Root 'tunnel\target\release\claude-tunnel.exe'
Copy-Item -LiteralPath $exe -Destination (Join-Path $OutDir 'claude-tunnel.exe')
$artifacts.Add('claude-tunnel.exe')
New-Item -ItemType Directory -Path (Join-Path $Root 'bridge\bin') -Force | Out-Null
try { Copy-Item -LiteralPath $exe -Destination (Join-Path $Root 'bridge\bin\claude-tunnel.exe') -Force }
catch { Write-Warning "bridge\bin\claude-tunnel.exe не обновлён (занят работающим туннелем?): $($_.Exception.Message)" }

# 2. Туннель для Android (clang.exe NDK напрямую: без .cmd-обёрток и их предела длины командной строки)
if (-not $SkipAndroidTunnel) {
  Write-Output '== libclaudetunnel.so (aarch64-linux-android)'
  $llvm = Join-Path $SdkDir "ndk\$NdkVersion\toolchains\llvm\prebuilt\windows-x86_64\bin"
  if (-not (Test-Path -LiteralPath (Join-Path $llvm 'clang.exe'))) {
    throw "Нет Android NDK $NdkVersion ($llvm) — задача 9 подплана 4, либо -SkipAndroidTunnel"
  }
  $env:CC_aarch64_linux_android = Join-Path $llvm 'clang.exe'
  $env:CFLAGS_aarch64_linux_android = '--target=aarch64-linux-android26'
  $env:AR_aarch64_linux_android = Join-Path $llvm 'llvm-ar.exe'
  $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $llvm 'clang.exe'
  $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS = '-C link-arg=--target=aarch64-linux-android26'
  Push-Location (Join-Path $Root 'tunnel')
  try { Invoke-Checked 'cargo build (android)' { & $Cargo build --release --locked --target aarch64-linux-android } }
  finally { Pop-Location }
  $built = Join-Path $Root 'tunnel\target\aarch64-linux-android\release\claude-tunnel'
  $jni = Join-Path $Root 'android\app\src\main\jniLibs\arm64-v8a'
  New-Item -ItemType Directory -Path $jni -Force | Out-Null
  Copy-Item -LiteralPath $built -Destination (Join-Path $jni 'libclaudetunnel.so') -Force
  Copy-Item -LiteralPath $built -Destination (Join-Path $OutDir 'libclaudetunnel.so')
  $artifacts.Add('libclaudetunnel.so')
}

# 3. Release-APK, подписанный ключом команды
$certSha = $null
if (-not $SkipApk) {
  Write-Output '== release-APK'
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'android\app\src\main\jniLibs\arm64-v8a\libclaudetunnel.so'))) {
    Write-Warning 'В APK не будет libclaudetunnel.so: на телефоне не будет доступа через интернет'
  }
  $secure = Read-Host -AsSecureString "Пароль хранилища ключа команды ($KeystorePath)"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $env:JAVA_HOME = $JavaHome
  $env:ORG_GRADLE_PROJECT_cbReleaseStoreFile = $KeystorePath
  $env:ORG_GRADLE_PROJECT_cbReleaseKeyAlias = $KeyAlias
  $env:ORG_GRADLE_PROJECT_cbReleaseStorePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:ORG_GRADLE_PROJECT_cbReleaseKeyPassword = $env:ORG_GRADLE_PROJECT_cbReleaseStorePassword
  Push-Location (Join-Path $Root 'android')
  try { Invoke-Checked 'gradlew assembleRelease' { & .\gradlew.bat --no-daemon clean :app:assembleRelease } }
  finally {
    Pop-Location
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    foreach ($n in 'cbReleaseStoreFile', 'cbReleaseKeyAlias', 'cbReleaseStorePassword', 'cbReleaseKeyPassword') {
      Remove-Item -LiteralPath "Env:ORG_GRADLE_PROJECT_$n" -ErrorAction SilentlyContinue
    }
  }
  $apk = Join-Path $Root 'android\app\build\outputs\apk\release\app-release.apk'
  if (-not (Test-Path -LiteralPath $apk)) { throw 'Нет app-release.apk — release не подписан (проверьте ключ и пароль)' }
  $badging = @(Invoke-Checked 'aapt dump badging' { & (Join-Path $BuildTools 'aapt.exe') dump badging $apk })
  if ($badging -match 'application-debuggable') { throw 'APK собран как debuggable — нарушение M-5' }
  $ver = [regex]::Match(($badging -join "`n"), "versionName='([^']+)'").Groups[1].Value
  $certOut = @(Invoke-Checked 'apksigner verify (подпись APK не прошла проверку)' {
      & (Join-Path $BuildTools 'apksigner.bat') verify --print-certs $apk })
  $m = [regex]::Match(($certOut -join "`n"), 'Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})')
  if (-not $m.Success) { throw "Нет SHA-256 сертификата подписи в выводе apksigner:`n$($certOut -join "`n")" }
  $certSha = $m.Groups[1].Value
  $apkName = "ClaudeBridge-$ver.apk"
  Copy-Item -LiteralPath $apk -Destination (Join-Path $OutDir $apkName)
  $artifacts.Add($apkName)
}

# 4. Контрольные суммы и заметки к релизу
$utf8 = New-Object Text.UTF8Encoding $false
$sums = @(foreach ($a in $artifacts) {
    '{0}  {1}' -f (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutDir $a)).Hash.ToLowerInvariant(), $a
  })
[IO.File]::WriteAllText((Join-Path $OutDir 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"), $utf8)
$commit = ([string](& git -C $Root rev-parse --short HEAD)).Trim()
$rustc = ([string](& (Join-Path (Split-Path -Parent $Cargo) 'rustc.exe') -V)).Trim()
$ndkNote = if ($SkipAndroidTunnel) { '' } else { "; Android NDK $NdkVersion" }
$notes = @("# Claude Bridge — релиз $commit", '',
  "Собрано $(Get-Date -Format 'yyyy-MM-dd') из коммита ``$commit``; $rustc$ndkNote.", '',
  '| Файл | SHA-256 |', '|---|---|')
foreach ($s in $sums) { $parts = $s -split '  ', 2; $notes += "| ``$($parts[1])`` | ``$($parts[0])`` |" }
if ($certSha) { $notes += @('', "SHA-256 сертификата подписи APK: ``$certSha`` — должен совпадать с README.") }
$notes += @('', 'Проверка (PowerShell):', '', '```powershell', 'Get-FileHash -Algorithm SHA256 .\claude-tunnel.exe',
  '& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs .\ClaudeBridge-<версия>.apk', '```')
[IO.File]::WriteAllText((Join-Path $OutDir 'RELEASE_NOTES.md'), (($notes -join "`n") + "`n"), $utf8)

Write-Output ''
Write-Output "Готово: $OutDir"
$sums | ForEach-Object { Write-Output "  $_" }
if ($certSha) { Write-Output "  SHA-256 сертификата подписи APK: $certSha" }
```

Перевести `tools/release.ps1` в UTF-8 с BOM.

- [ ] **Step 3: Проверить без NDK и без ключа**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk -SkipAndroidTunnel`
Expected: `Finished` от cargo, затем `Готово: …\dist` и одна строка `<64 hex>  claude-tunnel.exe`.

```powershell
Get-Content dist\SHA256SUMS.txt
(Get-FileHash -Algorithm SHA256 dist\claude-tunnel.exe).Hash.ToLowerInvariant()
Get-Content dist\RELEASE_NOTES.md
$k = Join-Path $env:TEMP ('cb-iroh-' + [guid]::NewGuid().ToString('N') + '.key')
& .\dist\claude-tunnel.exe id --secret-file $k
Remove-Item -LiteralPath $k -Force
git status --short
```

Expected: хэш в `SHA256SUMS.txt` совпадает с `Get-FileHash`; в заметках — таблица с `claude-tunnel.exe` и строка `rustc 1.99.1 …`; `claude-tunnel.exe id` печатает `{"event":"id","node_id":"<hex>"}`; `git status` показывает только `.gitignore` и `tools/release.ps1` (`dist/` игнорируется).

Run: `cd bridge && node --test test/install-lib.test.js`
Expected: `# fail 0` (BOM у `tools/release.ps1`).

- [ ] **Step 4: Commit**

```bash
git add .gitignore tools/release.ps1
git commit -m "build: release script with tunnel binaries, signed APK, SHA-256 sums and notes (P-8)"
```

---

### Task 9: ⚠ Android NDK и `libclaudetunnel.so` (aarch64-linux-android)

> **ТРЕБУЕТСЯ ЯВНОЕ ОДОБРЕНИЕ ПОЛЬЗОВАТЕЛЯ ДО НАЧАЛА ЗАДАЧИ.** Задача скачивает и ставит Android NDK `28.2.13676358` (несколько ГБ на диске, оценка) в `C:\Users\doale\AppData\Local\Android\Sdk` и target Rust `aarch64-linux-android`. Без явного «да» в текущей сессии задачу не выполнять: релиз тогда собирается с `-SkipAndroidTunnel` (APK без интернет-туннеля), а в отчёте указывается, что задача 9 отложена.

Версия NDK — та, которой собиралась `.so` в исходном проекте (`ARCHITECTURE.md`, §9.2).

**Files:** — (артефакты в `.gitignore`: `tunnel/target/`, `android/app/src/main/jniLibs/`)

- [ ] **Step 1: Одобрение получено** — зафиксировать в отчёте дословный ответ пользователя.

- [ ] **Step 2: Установить NDK**

```powershell
$env:JAVA_HOME = 'C:\Users\doale\AppData\Local\Programs\Temurin\jdk-17'
$sdk = 'C:\Users\doale\AppData\Local\Android\Sdk'
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --list | Select-String 'ndk;28\.'
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --install 'ndk;28.2.13676358'
Test-Path "$sdk\ndk\28.2.13676358\toolchains\llvm\prebuilt\windows-x86_64\bin\clang.exe"
```

Expected: в списке есть `ndk;28.2.13676358`; установка без ошибок (если спросит лицензию — ответ даёт пользователь); `True`.
Если `ndk;28.2.13676358` в списке нет — взять самую новую `ndk;28.*` из списка, записать версию в отчёт и далее передавать её `release.ps1 -NdkVersion <версия>`.

- [ ] **Step 3: Target Rust**

Run: `& "$env:USERPROFILE\.cargo\bin\rustup.exe" target add aarch64-linux-android`
Expected: `installed` или `is up to date`.

- [ ] **Step 4: Собрать через `release.ps1`**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk`
Expected: `Готово`, в сводке строки для `claude-tunnel.exe` и `libclaudetunnel.so`.
Если сборка `ring` падает с ошибкой компилятора C — повторить с `.cmd`-обёрткой NDK: в `release.ps1` временно (не коммитить) задать `CC_aarch64_linux_android` и `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER` = `$llvm\aarch64-linux-android26-clang.cmd`, убрать `CFLAGS_…` и `…_RUSTFLAGS`; при успехе — перенести этот вариант в `release.ps1` отдельным коммитом и описать причину в отчёте.

- [ ] **Step 5: Проверить ELF**

```powershell
$so = 'android\app\src\main\jniLibs\arm64-v8a\libclaudetunnel.so'
$b = [IO.File]::ReadAllBytes((Resolve-Path $so))
'{0:X2}{1:X2}{2:X2}{3:X2} class={4} machine={5}' -f $b[0], $b[1], $b[2], $b[3], $b[4], [BitConverter]::ToUInt16($b, 18)
```

Expected: `7F454C46 class=2 machine=183` (ELF, 64 бит, AArch64).

- [ ] **Step 6: Commit** — не требуется (изменений в отслеживаемых файлах нет, кроме возможного коммита из шага 4).

---

### Task 10: Ручная задача владельца — ключ команды и подписанный релиз

> Выполняет **владелец репозитория** (P-8: ключ хранится у него). Агент не создаёт ключ команды и не вводит его пароль. Место хранения ключа и его резервной копии — решение владельца (см. «Вопросы» в самопроверке).

- [ ] **Step 1: Создать ключ команды (один раз)**

```powershell
$jdk = 'C:\Users\doale\AppData\Local\Programs\Temurin\jdk-17'
& "$jdk\bin\keytool.exe" -genkeypair -v -keystore '<путь вне репозитория>\claude-bridge-team.jks' -storetype PKCS12 `
  -alias claude-bridge-team -keyalg RSA -keysize 4096 -validity 10000 -dname 'CN=Claude Bridge Team'
```

`keytool` спросит пароль хранилища (для PKCS12 он же — пароль ключа). Сделать резервную копию файла и пароля: без них обновить установленное у команды приложение невозможно — только удалить и сопрячь заново.

- [ ] **Step 2: Собрать релиз**

Run: `powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -KeystorePath '<путь>\claude-bridge-team.jks'` (без задачи 9 — добавить `-SkipAndroidTunnel`)
Expected: запрос пароля; `Готово: …\dist`; строки SHA-256 для `claude-tunnel.exe`, `libclaudetunnel.so` (если задача 9 выполнена), `ClaudeBridge-<версия>.apk`; строка `SHA-256 сертификата подписи APK: <64 hex>`.

- [ ] **Step 3: Проверить APK**

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs (Get-Item dist\ClaudeBridge-*.apk).FullName
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\aapt.exe" dump badging (Get-Item dist\ClaudeBridge-*.apk).FullName | Select-String 'debuggable'
```

Expected: `Signer #1 certificate DN: CN=Claude Bridge Team`, тот же SHA-256, что в шаге 2; `Select-String` ничего не выводит.

- [ ] **Step 4: Передать контроллеру** значение `SHA-256 сертификата подписи APK` (оно публичное) — оно вставляется в README в задачах 11–12. Содержимое `dist\` публикуется по каналу, который выберет владелец.

- [ ] **Step 5: Установка на телефон.** Приложение, подписанное отладочным ключом, не обновляется APK с другой подписью: удалить старое приложение, установить `ClaudeBridge-<версия>.apk`, сопрячь заново (`claude-mobile --qr`). Пройти сценарии 1–14 задачи 11 подплана 3 на release-сборке; результат — в отчёт.

---

### Task 11: `README.md` под Windows и скоуп D-9

Предпосылка: задача 10 выполнена (известен SHA-256 сертификата подписи). Перед записью — сверка фактов с кодом (шаг 1).

**Files:**
- Modify: `README.md` (полная замена)

- [ ] **Step 1: Сверить факты, на которые опирается текст**

```bash
grep -n '"port"\|"host"\|"defaultAgent"\|"sttPython"' bridge/config.example.json
grep -n "claude-mobile --" bridge/attach.js | head -20
grep -n "label:" bridge/agents/claude.js bridge/agents/opencode.js | head
grep -n "maxSessions\|sttMaxQueue\|scrollbackBytes\|mdnsName" bridge/server.js | head
```

Expected: ключи конфига, флаги `claude-mobile` и подписи опций агентов совпадают с текстом ниже (опции: «Продолжить беседу (--resume)», «Без запросов разрешений (--dangerously-skip-permissions)», «Спрашивать разрешение на команды»). Расхождение — исправить текст по коду, а не наоборот.

- [ ] **Step 2: Записать файл**

Полная замена `README.md` содержимым ниже, где `{{APK_CERT_SHA256}}` — значение из задачи 10, шаг 4 (64 hex, нижний регистр):

````markdown
<div align="center">

<img src="assets/hero.jpg" alt="Claude Bridge — агенты программирования на ПК, управление с телефона" width="820">

# Claude Bridge для Windows

**Зеркалируй сессии агентов программирования — [Claude Code](https://claude.com/claude-code), [opencode](https://opencode.ai) или любого терминального агента — на смартфон и управляй ими оттуда.**
Без облаков и посредников: телефон общается напрямую с твоим ПК — по локальной сети или через p2p-туннель, когда ты не рядом.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/ПК-Windows%2010%2F11-informational)](#требования)
[![Android](https://img.shields.io/badge/Телефон-Android%208%2B-green)](#2-приложение-на-телефон)

🇷🇺 Русский · [🇬🇧 English](README.en.md)

</div>

---

> **Внутренняя утилита команды.** Форк [HelpFreedom/claude-bridge](https://github.com/HelpFreedom/claude-bridge), адаптированный под Windows и несколько агентов. Каждый ставит его **на свой личный рабочий компьютер** и настраивает под себя. Поддерживается только Windows-хост; Linux-режима и совместимости со старыми версиями приложения нет.
>
> ⚠️ **Не для общих компьютеров.** Модель безопасности рассчитана на ПК с **одной** учётной записью, физический доступ к которому есть только у владельца. На машину с несколькими пользователями, терминальный сервер или общий стенд не устанавливайте.

## Что это

Мост (Node.js) на твоём ПК запускает агентов в псевдотерминалах Windows (ConPTY) и «отражает» их на Android-приложение. С телефона видно тот же терминал, что и на ПК: можно печатать, переключать и запускать сессии, отвечать на запросы разрешений кнопками из уведомления и получать уведомление, когда агент закончил.

Всё общение идёт **напрямую между твоими устройствами**: в офисной или домашней Wi-Fi — по локальной сети, вне её — по зашифрованному p2p-туннелю (iroh/QUIC). Трафик защищён TLS с пиннингом сертификата, доступ — только у сопряжённых по QR телефонов.

### Возможности

- 📱 **Полный терминал на телефоне** — xterm.js: ввод, Esc/Tab/Ctrl-C, стрелки, прокрутка и выделение пальцем, вставка (управляющие символы из буфера вырезаются).
- 🤖 **Несколько агентов** — Claude Code, opencode и любой TUI-агент из конфига; агент и его опции выбираются для каждой новой сессии.
- 🔔 **Запросы разрешений на телефоне** — «Claude просит разрешение — Bash: …» с кнопками «Да / Всегда: … / Нет» прямо в уведомлении; ответ на ПК снимает уведомление сам.
- ✅ **Подтверждение на телефоне** — выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже сопряжённом телефоне с контрольным кодом.
- 🌐 **Работа вне сети ПК** — p2p-туннель (iroh) поднимается сам, когда ПК не виден в Wi-Fi.
- 🎙️ **Голосовой ввод** — надиктовка (faster-whisper на ПК), по желанию.
- 💾 **Сессии переживают перезапуск моста** — каждая живёт в своём процессе-хранителе.

> Техническое описание — в [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Как это устроено (кратко)

```
┌──────────────────── ПК (Windows) ─────────────────────┐        ┌──────── Телефон (Android) ────────┐
│                                                       │        │                                   │
│  claude.exe   (ConPTY) ┐                              │        │   WebView + xterm.js              │
│  opencode.exe (ConPTY) ┼─ keeper.js (хранители)       │  WSS   │   • терминал, вкладки, голос      │
│  другой агент (ConPTY) ┘   named pipe + рукопожатие   │◀──────▶│   • foreground-сервис             │
│                                │                      │ TLS +  │   • уведомления с кнопками        │
│  хук Claude ┐                  ▼                      │ пиннинг│                                   │
│  opencode   ┴──▶ server.js (мост, порт 8790) ─────────┼────────┤   Обнаружение: mDNS + UDP-маяк    │
│  SSE              автозапуск: Планировщик задач       │        │   Вне сети ПК: p2p-туннель (iroh) │
└───────────────────────────────────────────────────────┘        └───────────────────────────────────┘
```

1. Телефон находит ПК в сети (mDNS/UDP-маяк) и подключается к нему.
2. Ввод и вывод терминала идут в обе стороны по WebSocket поверх TLS.
3. События агента (хуки Claude Code, события opencode) превращаются в уведомления на телефоне.

---

## Требования

**ПК:**
- Windows 10 или 11 (проверено на Windows 11 26200), личная учётная запись (см. предупреждение выше)
- [Node.js](https://nodejs.org/) 20+ (проверено на 24.8)
- Хотя бы один агент в `PATH`: [Claude Code](https://claude.com/claude-code) (`claude`, проверено 2.1.284) и/или [opencode](https://opencode.ai) (`opencode`, проверено v2.1.4)
- *(по желанию)* Python 3.11 (`py -3.11`) + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — голосовой ввод
- *(для сборки из исходников)* [Rust](https://rustup.rs/), JDK 17, Android SDK — см. [Сборка из исходников](#сборка-из-исходников)

**Телефон:** Android 8.0+ (API 26). Кнопки «Всегда» и подтверждение из уведомления — на Android 12+ (на более старых подтверждение — в открытом приложении).

**Сеть:** телефон и ПК в одной Wi-Fi-сети с профилем «Частная» на ПК — или p2p-туннель.

---

## Установка

### 1. Мост на ПК

```powershell
git clone https://github.com/Aleksei-Dobrynin/agent-bridge-windows.git
cd agent-bridge-windows
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Firewall
```

`install.ps1`:
- проверяет Node.js 20+, наличие `claude` и `opencode`;
- ставит зависимости моста (`npm ci` в `bridge\`);
- создаёт каталог данных `%LOCALAPPDATA%\ClaudeBridge` и конфиг `config.json` из `bridge\config.example.json`;
- кладёт `claude-mobile.cmd` в `%LOCALAPPDATA%\ClaudeBridge\bin` и добавляет этот каталог в PATH пользователя;
- добавляет хук моста в `%USERPROFILE%\.claude\settings.json` (с резервной копией `settings.json.bak-…`; ваши хуки и настройки не трогаются);
- регистрирует задачу Планировщика `ClaudeBridge` — мост стартует при входе в Windows (служба не используется: агентам нужен ваш сеанс);
- с `-Firewall` — добавляет правила входа TCP 8790 и UDP 8791 только для профиля «Частная сеть» (Windows спросит подтверждение администратора);
- запускает мост.

Повторный запуск безопасен — так же обновляется установка после `git pull`. Посмотреть, что будет сделано, ничего не меняя: `.\install.ps1 -DryRun`. Прочие ключи: `-SkipNpm`, `-SkipTask`, `-SkipPath`, `-SkipHook`, `-NoStart` (`Get-Help .\install.ps1 -Full`).

> Если Windows при первом запуске моста спросит о доступе `node.exe` к сети — разрешите для частных сетей. Если когда-то запретили — правило блокировки `node.exe` перекрывает разрешающие правила: удалите его в «Брандмауэр Защитника Windows → Разрешение взаимодействия с приложением…».

### 2. Приложение на телефон

Скачайте `ClaudeBridge-<версия>.apk` из [Releases](https://github.com/Aleksei-Dobrynin/agent-bridge-windows/releases) вместе с `SHA256SUMS.txt` и проверьте перед установкой:

```powershell
Get-FileHash -Algorithm SHA256 .\ClaudeBridge-<версия>.apk          # совпадает с SHA256SUMS.txt
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs .\ClaudeBridge-<версия>.apk
```

APK подписан ключом команды. **SHA-256 сертификата подписи:**

```
{{APK_CERT_SHA256}}
```

Если `apksigner` показывает другой отпечаток — не устанавливайте. Приложение, подписанное другим ключом (например, старое отладочное), нужно сначала удалить.

### 3. Сопряжение

1. В **новом** окне консоли (PATH обновлён): `claude-mobile --qr`.
   - Первый телефон: консоль спросит подтверждение `[y/N]`.
   - Если уже есть сопряжённый телефон: подтвердите на нём (уведомление «Claude Bridge: нужно подтверждение»), сверив 4-значный код с консолью.
2. В приложении: **«Добавить компьютер» → «Сканировать QR-код»**. Сопряжение — только по QR (код вручную не вводится).
3. Готово: телефон запомнит ПК и будет подключаться сам.

---

## Утилита `claude-mobile` (на ПК)

```
claude-mobile [args…]              новая сессия агента по умолчанию в текущем каталоге;
                                   аргументы передаются агенту (--resume, --continue…)
claude-mobile --agent <id> [args…] новая сессия указанного агента (claude, opencode, …)
claude-mobile -l                   список сессий
claude-mobile -a [id]              подключиться к сессии (без id — к последней живой)
claude-mobile --device             доверенные устройства и интернет-доступ
claude-mobile --qr                 QR-код сопряжения нового устройства
claude-mobile --open               открыть веб-интерфейс моста в браузере (одноразовая ссылка)
claude-mobile --rotate-token       перевыпустить токен владельца
claude-mobile -h                   справка
```

`Ctrl+\` — отсоединиться: сессия продолжает жить, вернуться — `claude-mobile -a`. Завершить сессию: выйти из агента (`/exit`) или долгим нажатием на её вкладку в приложении.

---

## Агенты

| Агент | Как работает | Опции новой сессии |
|---|---|---|
| `claude` — Claude Code | Запросы разрешений и «готово» приходят через хук, который ставит `install.ps1`. Кнопки ответа — для Bash, PowerShell, правки файлов, Web, Read/Glob/Grep, Task и MCP-инструментов. | «Продолжить беседу (--resume)», «Без запросов разрешений (--dangerously-skip-permissions)» |
| `opencode` | Через фоновый сервис opencode (мост сам запускает `opencode service`, если он не работает); события — по его API, включая запросы субагентов. По умолчанию opencode ничего не спрашивает. | «Спрашивать разрешение на команды» |
| любой TUI-агент (`generic`) | Только зеркало терминала: без уведомлений и кнопок ответа. | — |

Хук Claude Code срабатывает и в обычных сессиях Claude (не через мост): там он сразу выходит, но процесс `node` запускается на каждое событие.

---

## Настройка

Конфиг — `%LOCALAPPDATA%\ClaudeBridge\config.json` (создаётся из `bridge\config.example.json`; в репозиторий не попадает).

| Ключ | Назначение |
|---|---|
| `port` | Порт моста, по умолчанию `8790` (маяк — `port+1`, вход туннеля — `port+2`). |
| `host` | `"auto"` — `127.0.0.1` и адрес основного LAN-адаптера (виртуальные и VPN-адаптеры пропускаются, адрес перепроверяется каждые 15 с); или явный адрес. |
| `defaultAgent` | Агент по умолчанию (`claude`). |
| `agents` | Агенты: `{ "claude": {}, "opencode": {} }`; свой — `"aider": { "type": "generic", "name": "Aider", "command": "aider", "args": [], "scroll": "pageKeys" }` (`scroll`: `wheel` или `pageKeys`). |
| `projects` | Каталоги, где **телефон** может запускать сессии; путь вне списка заменяется на `defaultCwd`. |
| `defaultCwd` | Каталог по умолчанию (`~` и `%VAR%` раскрываются). |
| `env` | Переменные окружения для всех сессий (например, прокси). |
| `scrollbackBytes` | Буфер прокрутки на сессию (по умолчанию 1 МБ). |
| `maxSessions` | Предел числа сессий (по умолчанию 24). |
| `sttPython` / `sttPythonArgs` / `sttModel` / `sttLanguage` | Голосовой ввод: `py` + `["-3.11"]`, модель `large-v3`, язык `ru`. |

После правки конфига перезапустите мост (сессии переживают перезапуск):

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*\bridge\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName ClaudeBridge
```

Лог моста — `%LOCALAPPDATA%\ClaudeBridge\logs\bridge.log`.

### Прокси

```json
"env": {
  "HTTPS_PROXY": "http://127.0.0.1:10808",
  "NO_PROXY":    "127.0.0.1,localhost,192.168.0.0/16"
}
```

`NO_PROXY` исключает localhost и локальную сеть, чтобы связь моста с телефоном шла напрямую.

### Голосовой ввод

```powershell
py -3.11 -m pip install faster-whisper
```

Модель загружается в память при первом использовании.

### Доступ через интернет (p2p)

Нужен `bridge\bin\claude-tunnel.exe` (из релиза — проверьте SHA-256 по `SHA256SUMS.txt` — или собранный из исходников). Включение: `claude-mobile --device` → `i` (подтверждение на телефоне). Если корпоративная политика не даёт добавить правила брандмауэра, туннель остаётся единственным путём.

---

## Удаление

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall            # оставить данные
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall -RemoveData
```

Снимает задачу Планировщика, останавливает мост, убирает хук из `settings.json` (с резервной копией), шим и PATH; `-RemoveData` удаляет `%LOCALAPPDATA%\ClaudeBridge` (сопряжения, сертификат, токены — телефоны придётся сопрячь заново). Живые сессии работают до выхода из агента.

---

## Безопасность

- **TLS + пиннинг**: телефон доверяет только сертификату вашего ПК; `claude-mobile` и хук тоже проверяют отпечаток.
- **Сопряжение только по QR**, код одноразовый (10 минут), выпуск — только после подтверждения человеком (консоль для первого телефона, дальше — сопряжённый телефон с контрольным кодом).
- **Токены устройств** хранятся на ПК только в виде SHA-256; отзыв (`claude-mobile --device`) мгновенно рвёт соединения.
- **Локальный доступ** — по токену владельца из `%LOCALAPPDATA%\ClaudeBridge\owner.token`; агенту выдаётся только узкий токен хука своей сессии; браузер на ПК входит по одноразовой ссылке (`claude-mobile --open`).
- **Сеть**: мост слушает `127.0.0.1` и один LAN-адрес, маяк и mDNS не раскрывают имя ПК.
- **Телефон**: биометрический замок, `FLAG_SECURE`, ответ агенту из уведомления требует разблокировки (Android 12+).

Модель угроз — личный ПК одного пользователя. Агент, работающий под вашей учётной записью, технически может читать файлы моста; подтверждение на телефоне защищает от того, что он **сам** сопряжёт устройство или включит интернет-доступ через API моста, но не от агента, который правит файлы моста и перезапускает его. Подробности и известные ограничения — в [ARCHITECTURE.md](ARCHITECTURE.md#12-известные-ограничения).

---

## Сборка из исходников

```powershell
cd bridge; npm test                                                     # тесты моста
powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk   # claude-tunnel.exe (+ libclaudetunnel.so при наличии NDK)
cd android; .\gradlew.bat assembleDebug                                 # отладочный APK
```

Релиз (владелец ключа команды): `tools\release.ps1 -KeystorePath <ключ>` собирает в `dist\` туннель для ПК и Android, подписанный release-APK, `SHA256SUMS.txt` и `RELEASE_NOTES.md`. Нужны Rust (targets `x86_64-pc-windows-msvc`, `aarch64-linux-android`), JDK 17, Android SDK (build-tools 34) и NDK 28.

---

## Происхождение и лицензия

Оригинальный проект — [HelpFreedom/claude-bridge](https://github.com/HelpFreedom/claude-bridge) (Black Triangle; [видео](https://www.youtube.com/watch?v=x_AXmmRxF9E), поддержать автора: https://boosty.to/triangle_black/). Авторы — [AUTHORS.md](AUTHORS.md).

[GNU General Public License v3.0](LICENSE). Пожалуйста, не коммитьте личные данные (токены, сертификаты, `config.json`, ключи подписи) — каталог данных живёт вне репозитория, основные шаблоны — в `.gitignore`.
````

- [ ] **Step 3: Проверить**

```bash
grep -c "{{APK_CERT_SHA256}}" README.md      # Expected: 0
grep -n "Linux\|systemd\|bridge-hook.sh\|gradlew assembleDebug\b" README.md   # Expected: только строка про отсутствие Linux-режима
grep -n "#12-известные-ограничения\|#требования\|#2-приложение-на-телефон\|#сборка-из-исходников" README.md
```

Expected: плейсхолдер заменён; якоря существуют в README.md / ARCHITECTURE.md (раздел 12 появляется в задаче 15 — ссылку проверить после неё).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README for the Windows team fork (P-8, D-8, D-9)"
```

---

### Task 12: `README.en.md`

Тот же текст по-английски (структура и факты — как в задаче 11; `{{APK_CERT_SHA256}}` — то же значение).

**Files:**
- Modify: `README.en.md` (полная замена)

- [ ] **Step 1: Записать файл**

````markdown
<div align="center">

<img src="assets/hero.jpg" alt="Claude Bridge — coding agents on your PC, controlled from your phone" width="820">

# Claude Bridge for Windows

**Mirror coding-agent sessions — [Claude Code](https://claude.com/claude-code), [opencode](https://opencode.ai) or any terminal agent — to your phone and control them from there.**
No cloud, no middlemen: the phone talks directly to your PC — over the local network, or through a p2p tunnel when you are away.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/PC-Windows%2010%2F11-informational)](#requirements)
[![Android](https://img.shields.io/badge/Phone-Android%208%2B-green)](#2-phone-app)

[🇷🇺 Русский](README.md) · 🇬🇧 English

</div>

---

> **Internal team tool.** A fork of [HelpFreedom/claude-bridge](https://github.com/HelpFreedom/claude-bridge) adapted to Windows and multiple agents. Everyone installs it **on their own personal work computer** and configures it for themselves. Only a Windows host is supported; there is no Linux mode and no compatibility with old app versions.
>
> ⚠️ **Not for shared computers.** The security model assumes a PC with **one** user account that only its owner can physically access. Do not install it on multi-user machines, terminal servers or shared test rigs.

## What it is

A bridge (Node.js) on your PC runs agents in Windows pseudo-terminals (ConPTY) and mirrors them to an Android app. The phone shows the same terminal as the PC: you can type, switch and start sessions, answer permission requests with buttons right in the notification, and get notified when the agent is done.

All traffic goes **directly between your devices**: over the office or home Wi-Fi on the local network, otherwise through an encrypted p2p tunnel (iroh/QUIC). Traffic is protected by TLS with certificate pinning; only phones paired via QR have access.

### Features

- 📱 **Full terminal on the phone** — xterm.js: typing, Esc/Tab/Ctrl-C, arrows, finger scrolling and selection, paste (control characters are stripped).
- 🤖 **Several agents** — Claude Code, opencode and any TUI agent from the config; the agent and its options are chosen per new session.
- 🔔 **Permission requests on the phone** — "Claude asks for permission — Bash: …" with "Yes / Always: … / No" buttons right in the notification; answering on the PC clears it.
- ✅ **Confirmation on the phone** — issuing a pairing code and enabling internet access are confirmed on an already paired phone with a check code.
- 🌐 **Away from the PC's network** — the p2p tunnel (iroh) comes up by itself when the PC is not visible on Wi-Fi.
- 🎙️ **Voice input** — dictation (faster-whisper on the PC), optional.
- 💾 **Sessions survive bridge restarts** — each lives in its own keeper process.

> Technical description: [ARCHITECTURE.md](ARCHITECTURE.md) (in Russian).

---

## How it works (short)

```
┌──────────────────── PC (Windows) ─────────────────────┐        ┌────────── Phone (Android) ────────┐
│                                                       │        │                                   │
│  claude.exe   (ConPTY) ┐                              │        │   WebView + xterm.js              │
│  opencode.exe (ConPTY) ┼─ keeper.js (keepers)         │  WSS   │   • terminal, tabs, voice         │
│  other agent  (ConPTY) ┘   named pipe + handshake     │◀──────▶│   • foreground service            │
│                                │                      │ TLS +  │   • notifications with buttons    │
│  Claude hook ┐                 ▼                      │ pinning│                                   │
│  opencode    ┴──▶ server.js (bridge, port 8790) ──────┼────────┤   Discovery: mDNS + UDP beacon    │
│  SSE              autostart: Task Scheduler           │        │   Away: p2p tunnel (iroh)         │
└───────────────────────────────────────────────────────┘        └───────────────────────────────────┘
```

1. The phone finds the PC on the network (mDNS/UDP beacon) and connects.
2. Terminal input and output flow both ways over WebSocket on TLS.
3. Agent events (Claude Code hooks, opencode events) become phone notifications.

---

## Requirements

**PC:**
- Windows 10 or 11 (tested on Windows 11 26200), a personal user account (see the warning above)
- [Node.js](https://nodejs.org/) 20+ (tested on 24.8)
- At least one agent on `PATH`: [Claude Code](https://claude.com/claude-code) (`claude`, tested 2.1.284) and/or [opencode](https://opencode.ai) (`opencode`, tested v2.1.4)
- *(optional)* Python 3.11 (`py -3.11`) + [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) — voice input
- *(to build from source)* [Rust](https://rustup.rs/), JDK 17, Android SDK — see [Building from source](#building-from-source)

**Phone:** Android 8.0+ (API 26). The "Always" button and confirming from a notification need Android 12+ (older versions confirm in the open app).

**Network:** phone and PC on the same Wi-Fi with the "Private" profile on the PC — or the p2p tunnel.

---

## Installation

### 1. Bridge on the PC

```powershell
git clone https://github.com/Aleksei-Dobrynin/agent-bridge-windows.git
cd agent-bridge-windows
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Firewall
```

`install.ps1`:
- checks Node.js 20+ and whether `claude` and `opencode` are present;
- installs the bridge dependencies (`npm ci` in `bridge\`);
- creates the data directory `%LOCALAPPDATA%\ClaudeBridge` and `config.json` from `bridge\config.example.json`;
- puts `claude-mobile.cmd` into `%LOCALAPPDATA%\ClaudeBridge\bin` and adds that directory to the user PATH;
- adds the bridge hook to `%USERPROFILE%\.claude\settings.json` (backup `settings.json.bak-…`; your hooks and settings are kept);
- registers the Task Scheduler task `ClaudeBridge` — the bridge starts when you sign in to Windows (no service: agents need your session);
- with `-Firewall`, adds inbound rules for TCP 8790 and UDP 8791 for the "Private" profile only (Windows asks for administrator approval);
- starts the bridge.

Running it again is safe — this is also how you update after `git pull`. To see what it would do without changing anything: `.\install.ps1 -DryRun`. Other switches: `-SkipNpm`, `-SkipTask`, `-SkipPath`, `-SkipHook`, `-NoStart` (`Get-Help .\install.ps1 -Full`).

> If Windows asks whether `node.exe` may use the network when the bridge first starts, allow it for private networks. If you blocked it before, the `node.exe` block rule overrides allow rules: remove it in "Windows Defender Firewall → Allow an app through firewall…".

### 2. Phone app

Download `ClaudeBridge-<version>.apk` and `SHA256SUMS.txt` from [Releases](https://github.com/Aleksei-Dobrynin/agent-bridge-windows/releases) and verify before installing:

```powershell
Get-FileHash -Algorithm SHA256 .\ClaudeBridge-<version>.apk          # matches SHA256SUMS.txt
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0\apksigner.bat" verify --print-certs .\ClaudeBridge-<version>.apk
```

The APK is signed with the team key. **SHA-256 of the signing certificate:**

```
{{APK_CERT_SHA256}}
```

If `apksigner` shows a different fingerprint, do not install it. An app signed with another key (for example the old debug one) must be uninstalled first.

### 3. Pairing

1. In a **new** console window (PATH updated): `claude-mobile --qr`.
   - First phone: the console asks for `[y/N]` confirmation.
   - If a phone is already paired: confirm on it (notification "Claude Bridge: confirmation needed"), comparing the 4-digit code with the console.
2. In the app: **"Add computer" → "Scan QR code"**. Pairing is QR-only (no manual code entry).
3. Done: the phone remembers the PC and connects by itself.

---

## The `claude-mobile` CLI (on the PC)

```
claude-mobile [args…]              new session of the default agent in the current directory;
                                   arguments go to the agent (--resume, --continue…)
claude-mobile --agent <id> [args…] new session of the given agent (claude, opencode, …)
claude-mobile -l                   list sessions
claude-mobile -a [id]              attach to a session (without id — the latest live one)
claude-mobile --device             trusted devices and internet access
claude-mobile --qr                 pairing QR code for a new device
claude-mobile --open               open the bridge web UI in the browser (one-time link)
claude-mobile --rotate-token       reissue the owner token
claude-mobile -h                   help
```

`Ctrl+\` detaches: the session keeps running, come back with `claude-mobile -a`. To end a session, exit the agent (`/exit`) or long-press its tab in the app.

---

## Agents

| Agent | How it works | New-session options |
|---|---|---|
| `claude` — Claude Code | Permission requests and "done" arrive through the hook installed by `install.ps1`. Answer buttons for Bash, PowerShell, file edits, Web, Read/Glob/Grep, Task and MCP tools. | "Continue conversation (--resume)", "No permission prompts (--dangerously-skip-permissions)" (labels are in Russian in the app) |
| `opencode` | Through the opencode background service (the bridge runs `opencode service` itself if it is not running); events come from its API, including subagent requests. By default opencode asks nothing. | "Ask permission for commands" |
| any TUI agent (`generic`) | Terminal mirror only: no notifications, no answer buttons. | — |

The Claude Code hook also fires in ordinary Claude sessions (not through the bridge): it exits immediately there, but a `node` process starts for every event.

---

## Configuration

Config: `%LOCALAPPDATA%\ClaudeBridge\config.json` (created from `bridge\config.example.json`; never committed).

| Key | Purpose |
|---|---|
| `port` | Bridge port, default `8790` (beacon `port+1`, tunnel entry `port+2`). |
| `host` | `"auto"` — `127.0.0.1` plus the main LAN adapter address (virtual and VPN adapters are skipped, re-checked every 15 s); or an explicit address. |
| `defaultAgent` | Default agent (`claude`). |
| `agents` | Agents: `{ "claude": {}, "opencode": {} }`; your own — `"aider": { "type": "generic", "name": "Aider", "command": "aider", "args": [], "scroll": "pageKeys" }` (`scroll`: `wheel` or `pageKeys`). |
| `projects` | Directories where the **phone** may start sessions; a path outside the list falls back to `defaultCwd`. |
| `defaultCwd` | Default directory (`~` and `%VAR%` are expanded). |
| `env` | Environment variables for all sessions (for example a proxy). |
| `scrollbackBytes` | Scrollback buffer per session (default 1 MB). |
| `maxSessions` | Session limit (default 24). |
| `sttPython` / `sttPythonArgs` / `sttModel` / `sttLanguage` | Voice input: `py` + `["-3.11"]`, model `large-v3`, language `ru`. |

After editing the config, restart the bridge (sessions survive it):

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*\bridge\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName ClaudeBridge
```

Bridge log: `%LOCALAPPDATA%\ClaudeBridge\logs\bridge.log`.

### Proxy

```json
"env": {
  "HTTPS_PROXY": "http://127.0.0.1:10808",
  "NO_PROXY":    "127.0.0.1,localhost,192.168.0.0/16"
}
```

`NO_PROXY` excludes localhost and the local network so the bridge talks to the phone directly.

### Voice input

```powershell
py -3.11 -m pip install faster-whisper
```

The model is loaded into memory on first use.

### Internet access (p2p)

Needs `bridge\bin\claude-tunnel.exe` (from the release — check its SHA-256 against `SHA256SUMS.txt` — or built from source). Enable it with `claude-mobile --device` → `i` (confirmed on the phone). If corporate policy forbids firewall rules, the tunnel is the only path.

---

## Uninstalling

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall            # keep data
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Firewall -RemoveData
```

Removes the scheduled task, stops the bridge, removes the hook from `settings.json` (with a backup), the shim and the PATH entry; `-RemoveData` deletes `%LOCALAPPDATA%\ClaudeBridge` (pairings, certificate, tokens — phones must be paired again). Live sessions keep running until you exit the agent.

---

## Security

- **TLS + pinning**: the phone trusts only your PC's certificate; `claude-mobile` and the hook check the fingerprint too.
- **QR-only pairing**, one-time code (10 minutes), issued only after a human confirms (console for the first phone, then a paired phone with a check code).
- **Device tokens** are stored on the PC only as SHA-256; revoking (`claude-mobile --device`) drops connections immediately.
- **Local access** uses the owner token from `%LOCALAPPDATA%\ClaudeBridge\owner.token`; an agent gets only the narrow hook token of its session; the PC browser signs in with a one-time link (`claude-mobile --open`).
- **Network**: the bridge listens on `127.0.0.1` and one LAN address; the beacon and mDNS do not reveal the PC name.
- **Phone**: biometric lock, `FLAG_SECURE`, answering an agent from a notification requires unlocking (Android 12+).

Threat model: one user's personal PC. An agent running under your account can technically read the bridge's files; phone confirmation protects against it pairing a device or enabling internet access **by itself** through the bridge API, but not against an agent that edits the bridge's files and restarts it. Details and known limitations: [ARCHITECTURE.md](ARCHITECTURE.md#12-известные-ограничения).

---

## Building from source

```powershell
cd bridge; npm test                                                     # bridge tests
powershell -ExecutionPolicy Bypass -File .\tools\release.ps1 -SkipApk   # claude-tunnel.exe (+ libclaudetunnel.so if the NDK is present)
cd android; .\gradlew.bat assembleDebug                                 # debug APK
```

Release (team key holder): `tools\release.ps1 -KeystorePath <key>` builds into `dist\` the PC and Android tunnel, the signed release APK, `SHA256SUMS.txt` and `RELEASE_NOTES.md`. Requires Rust (targets `x86_64-pc-windows-msvc`, `aarch64-linux-android`), JDK 17, Android SDK (build-tools 34) and NDK 28.

---

## Origin and license

Original project: [HelpFreedom/claude-bridge](https://github.com/HelpFreedom/claude-bridge) (Black Triangle; [video](https://www.youtube.com/watch?v=x_AXmmRxF9E), support the author: https://boosty.to/triangle_black/). Authors: [AUTHORS.md](AUTHORS.md).

[GNU General Public License v3.0](LICENSE). Please do not commit personal data (tokens, certificates, `config.json`, signing keys) — the data directory lives outside the repository, the main patterns are in `.gitignore`.
````

- [ ] **Step 2: Проверить**

```bash
grep -c "{{APK_CERT_SHA256}}" README.en.md   # Expected: 0
grep -n "systemd\|bridge-hook.sh" README.en.md   # Expected: пусто
```

- [ ] **Step 3: Commit**

```bash
git add README.en.md
git commit -m "docs: English README for the Windows team fork (P-8, D-8, D-9)"
```

---

### Task 13: `ARCHITECTURE.md` — §1–3 (назначение, топология, мост)

Предпосылки: подпланы 1–3 выполнены. Текст описывает **фактический** код: шаг 1 сверяет ключевые утверждения; расхождение — исправить текст по коду и указать в отчёте.

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Сверить факты**

```bash
grep -n "PIPE_RE\|SECRET_RE\|MAX_SESSIONS\|MAX_WS_CLIENTS\|maxPayload\|PAIR_TTL_MS\|PAIR_FAIL_TOTAL_MAX\|randomBytes(5)\|LAN_REPICK_MS\|TUNNEL_BIN\|taskkill" bridge/server.js
grep -n "MAX_BYTES\|bridge.log" bridge/lib/log.js
grep -n "AddYears\|bridge.pfx\|bridge.cer\|bridge.pass" bridge/lib/cert.js
grep -n "CLAUDE_BRIDGE_[A-Z_]*" -o bridge/server.js bridge/hooks/bridge-hook.js bridge/keeper.js | sort -u
grep -n "ALLOWED_TOOLS\|Bash\|PowerShell\|mcp__" bridge/agents/claude.js | head
grep -n "permission.asked\|session.created\|parentID\|/api/event" bridge/agents/opencode-client.js | head
grep -n "cooldown\|checkCode\|15 \* 60\|60 \* 1000" bridge/lib/confirmations.js
grep -n "9001l\|MODE_OFF" bridge/attach.js bridge/lib/win32-input.js
```

Expected: имя pipe `\\.\pipe\claude-bridge-<32 hex>`, секрет 64 hex, 24 сессии, 64 WS-клиента, 4 МБ, код 10 мин / 50 ошибок / 5 байт, перевыбор LAN 15 с, `bridge\bin\claude-tunnel.exe`, `taskkill /IM claude-tunnel.exe /F`, лог 5 МБ, сертификат на 10 лет, файлы `bridge.pfx|cer|pass`; переменные `CLAUDE_BRIDGE_SESSION`, `CLAUDE_BRIDGE_HOOK_TOKEN`, `CLAUDE_BRIDGE_PORT`, `CLAUDE_BRIDGE_CERT_FP`, `CLAUDE_BRIDGE_KEEPER_SECRET`, `CLAUDE_BRIDGE_HOME`, `CLAUDE_BRIDGE_LISTEN_PORT`, `CLAUDE_BRIDGE_TEST`; пауза подтверждений 1 мин ×2 до 15 мин; `MODE_OFF` в `attach.js`.

- [ ] **Step 2: Заменить начало файла**

Заменить текст `ARCHITECTURE.md` от первой строки до строки **перед** `## 4. Интернет-туннель \`claude-tunnel\` (каталог \`tunnel/\`, Rust)` целиком на:

````markdown
# Claude Bridge — архитектура и полное техническое описание

Резюме программы: зачем она нужна, из чего состоит, как устроен каждый компонент, какие
протоколы связывают части и как обеспечивается безопасность. Документ отражает фактическое
состояние Windows-версии (ветка `feature/windows-multi-agent`). Ссылки D-n / P-n / H-, M-, L- —
решения и находки из реестра `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md`.

---

## 1. Что это и зачем

**Claude Bridge** — связка «Node.js-мост на Windows-ПК + Android-приложение», которая
**зеркалирует терминальные сессии агентов программирования и позволяет управлять ими со
смартфона**: Claude Code, opencode и любой TUI-агент (адаптер `generic`).

Агент работает на ПК со всем доступом к файлам, git и тулчейнам; телефон — второй терминал той же
сессии: одна общая псевдоконсоль Windows (ConPTY), а не копии.

Сценарии:

- **Зеркало сессии.** `claude-mobile` (агент по умолчанию) или `claude-mobile --agent opencode` —
  та же сессия открыта на телефоне; печатать можно с обоих устройств.
- **Удалённый запуск.** С телефона — новая сессия выбранного агента с его опциями (телефон передаёт
  только id опций, P-3) в разрешённом каталоге.
- **Запросы разрешений.** Агент спрашивает разрешение — на телефон приходит уведомление с кнопками
  из `choices` адаптера («Да / Всегда: … / Нет», D-4, D-23.6); ответ уходит агенту семантически.
- **Подтверждение операций владельца.** Выпуск кода сопряжения и включение интернет-доступа
  подтверждаются на уже сопряжённом телефоне с контрольным кодом (D-13, D-22).
- **Голосовой ввод** — запись на телефоне, распознавание (faster-whisper) на ПК.
- **Вне сети ПК** — p2p-туннель (iroh, QUIC) без проброса портов и VPN.

**Скоуп (D-9):** внутренняя утилита команды; только Windows-хост; без Linux-режима и обратной
совместимости. **Модель угроз (D-8):** личный ПК, одна учётная запись, физический доступ только у
владельца — **не для общих компьютеров**. Защищаются сеть телефон↔ПК и браузер/интернет-код на ПК;
вредоносная программа под учётной записью владельца — вне модели.

Сквозные принципы: не ломать рабочую функциональность; fail-closed в спорных местах безопасности;
секреты — в профиле пользователя (`%LOCALAPPDATA%`, закрыт ACL от других учётных записей), а не в
рабочей копии git.

---

## 2. Топология

```
   ┌──────────────────────────── ПК (Windows 10/11) ─────────────────────────────┐
   │  Задача Планировщика «ClaudeBridge» (при входе пользователя, не служба)      │
   │     └─ node start-bridge.js ─► node server.js (отсоединён, без консоли)      │
   │            │  HTTPS/WSS :8790 — 127.0.0.1 + LAN-адрес (host:"auto")          │
   │            │  UDP :8791 — маяк · mDNS claude-bridge-<fp8>.local              │
   │            │  HTTPS/WSS 127.0.0.1:8792 — вход интернет-туннеля               │
   │            ├─ keeper.js (по одному на сессию) ═ named pipe + HMAC ═ ConPTY   │
   │            │        └─ claude.exe / opencode.exe --server … / generic         │
   │            ├─ адаптеры: claude (хуки) · opencode (SSE + API) · generic       │
   │            ├─ фоновый сервис opencode (opencode service, общий, D-12)        │
   │            ├─ stt.py (py -3.11, faster-whisper)                              │
   │            └─ claude-tunnel.exe listen (Rust, iroh p2p)                      │
   │  claude-mobile (attach.js) ── WSS 127.0.0.1:8790, токен владельца + пиннинг  │
   │  bridge-hook.js (хук Claude Code) ── POST /hook, токен хука + пиннинг        │
   └─────────────────────────────────────┬───────────────────────────────────────┘
                                         │ LAN (Wi-Fi)          Интернет (p2p)
                                         ▼                           ▼
   ┌──────────────────────────── Телефон (Android 8+) ───────────────────────────┐
   │  BridgeService (foreground): OkHttp WSS ── мост :8790 (пиннинг)              │
   │     ├─ NSD (mDNS) + UDP-проба :8791                                          │
   │     └─ claude-tunnel connect (libclaudetunnel.so) ── p2p до ПК               │
   │  LocalGateway 127.0.0.1: :38471 UI из assets · :38472 ws-прокси              │
   │  MainActivity (WebView + xterm.js) ── http://127.0.0.1:38471                 │
   └──────────────────────────────────────────────────────────────────────────────┘
```

Два пути до моста:

1. **LAN:** телефон нашёл ПК по mDNS/UDP и подключается к `wss://<LAN-адрес>:8790`. Приоритетный путь.
2. **Интернет (p2p):** ПК не виден в сети — пара `claude-tunnel connect` (телефон) ↔
   `claude-tunnel listen` (ПК) поверх iroh; телефон подключается к `wss://127.0.0.1:<порт туннеля>`,
   сайдкар пробрасывает байты на loopback-порт `8792` моста.

В обоих случаях WebSocket идёт по **TLS с пиннингом самоподписанного сертификата** моста
сквозным образом от WebView до моста; туннель добавляет шифрование iroh.

---

## 3. Мост на ПК (каталог `bridge/`)

### 3.1 Каталог данных (`lib/datadir.js`, P-1)

Всё состояние — в `%LOCALAPPDATA%\ClaudeBridge` (тесты — `CLAUDE_BRIDGE_HOME`): `config.json`,
`pairings.json`, `internet.json`, `owner.token`, `certs\`, `sessions\`, `logs\`, `bin\` (шим от
установщика). Права — ACL профиля пользователя (D-8), без `chmod`. Полная раскладка — §10.

### 3.2 Запуск и автозапуск (P-4)

- `install.ps1` регистрирует задачу Планировщика «при входе пользователя» в его сеансе (служба не
  подходит: session 0 ломает ConPTY). Задача запускает `node start-bridge.js`, тот поднимает
  `server.js` отсоединённым процессом (`detached`, `windowsHide`, `stdio: 'ignore'`) и выходит.
- Повторный запуск при работающем мосте — no-op: второй экземпляр выходит по `EADDRINUSE` до любых
  побочных эффектов (маяк, туннель, keeper'ы).
- Консоли у моста нет: `console.*` дублируется в `logs\bridge.log` (`lib/log.js`, ротация при 5 МБ
  в `bridge.log.1`, переводы строк в сообщениях экранируются).
- Перезапуск моста **не** убивает сессии: они живут в отдельных keeper'ах.

### 3.3 `server.js` — ядро

Слушает:

| Сокет | Адрес | Назначение |
|---|---|---|
| HTTPS/WSS | `127.0.0.1:8790` и LAN-адрес `:8790` (`host:"auto"`) или `host` из конфига | UI, WS, `/pair`, `/stt`, `/hook`, `/health` |
| UDP-маяк | `*:8791` | ответ на broadcast `CLAUDE_BRIDGE?` |
| HTTPS/WSS туннеля | `127.0.0.1:8792` | трафик из интернет-туннеля (тот же обработчик) |

Владелец отличается по `localPort === port` и loopback-адресу: трафик туннеля приходит на 8792.

#### Конфигурация (`config.json`)

```json
{
  "port": 8790, "host": "auto",
  "defaultAgent": "claude",
  "agents": { "claude": {}, "opencode": {} },
  "defaultCwd": "~", "projects": [],
  "env": {}, "scrollbackBytes": 1048576, "mdnsName": "claude-bridge",
  "sttPython": "py", "sttPythonArgs": ["-3.11"], "sttModel": "large-v3", "sttLanguage": "ru"
}
```

- Создаётся из `config.example.json` (установщиком или при первом старте). Пути: `~`, `%VAR%`,
  `/` и `\`; относительные пути отбрасываются.
- `agents.{id}.{type,name,command,prefixArgs,args,scroll,serviceFile}` (D-15.4); без ключа `agents` —
  `claude` и `opencode`, если найдены. `claudeCommand`/`claudeArgs` больше не читаются (D-9).
- `env` целиком попадает в окружение сессий. Порт можно переопределить `CLAUDE_BRIDGE_LISTEN_PORT`.

#### TLS (`lib/cert.js`, P-4)

Сертификат создаётся без openssl: PowerShell `New-SelfSignedCertificate` в `Cert:\CurrentUser\My`
(срок 10 лет) → `Export-PfxCertificate` со случайным паролем (`certs\bridge.pass`) → `bridge.pfx` +
`bridge.cer` (DER) → удаление из хранилища Windows. **Отпечаток** — SHA-256 от DER; его пиннят
телефон, `claude-mobile` и хук (M-8), он же — идентификатор ПК в приложении.

#### Кто есть кто (P-1, D-1, D-16)

1. **Владелец** — loopback + основной порт + `Authorization: Bearer <owner.token>` (`claude-mobile`)
   или cookie `bridgeToken` с **браузерным токеном** (браузер ПК). Токен владельца — 32 случайных
   байта hex в `owner.token`, постоянный; `claude-mobile --rotate-token` перевыпускает его, мост
   закрывает соединения кодом 4401.
2. **Устройство** — токен, выданный при сопряжении; в `pairings.json` только SHA-256 (`tokenHash`,
   D-15.7), публичный id — первые 12 hex хэша. Сверка — за постоянное время.
3. **Хук сессии** — `CLAUDE_BRIDGE_HOOK_TOKEN` в окружении агента: только `POST /hook` своей сессии
   (`X-Bridge-Session`).

- **Origin** (P-1, второй слой против H-1): WS и HTTP — только с `https://127.0.0.1:<port>`,
  `https://localhost:<port>`, `http://127.0.0.1:38471` (WebView) или без `Origin` (CLI). Allowlist
  `Host` не вводится (D-16.4).
- **Вход браузера** (L-9, D-16.1, D-18.2): `claude-mobile --open` → одноразовый токен (60 с) →
  `GET /?ott=…` (только loopback, основной порт) → HttpOnly-cookie с браузерным токеном (живёт в
  памяти до ротации/рестарта) → redirect на `/`. Ссылка печатается только в интерактивную консоль.
- **Граница модели (D-16.3, D-22.1):** агент под той же учётной записью может прочитать
  `owner.token` и meta других сессий; от «самоподтверждения» защищают D-13 и хэши токенов устройств;
  агент, который правит файлы моста и перезапускает его, — вне модели D-8.

#### Сопряжение (P-7, P-9, D-13, D-22)

- Код выпускается **только по запросу владельца** (`claude-mobile --qr` → `pairinfo`), не при
  старте: 5 случайных байт (10 hex, 40 бит), живёт 10 минут, одноразовый. Перебор: 5 ошибок с адреса
  → блок `/pair` на 15 минут; не более 50 ошибок на код.
- QR `{cb:1, host, port, code, fp}` — единственный способ (H-2): ручного ввода кода в приложении нет.
- `POST /pair` — только основной порт (не туннель), тело ≤ 4 КБ; ответ — токен, отпечаток, порт,
  p2p-адрес (если интернет включён).
- **Подтверждение выпуска кода** (= подтверждение сопряжения, D-15.6) и **включения интернета**:
  если сопряжённых устройств ещё не было — вопрос `[y/N]` в интерактивной консоли `claude-mobile`
  (`confirmRequired` → повтор с `confirmed:true`); иначе — только на сопряжённом телефоне
  (`confirmRequest` с 4-значным `checkCode`, тот же код в консоли — `confirmPending`). После
  отказа/истечения — пауза для действия 1 мин, ×2 до 15 мин; ожидание снимается при отключении
  запросившего (`confirmClosed`).
- После первого сопряжения `phoneRequired:true` в `pairings.json` закрывает консольный путь навсегда
  (сброс — удалить `pairings.json` при остановленном мосте). Повреждённый `pairings.json` — мост не
  стартует (fail-closed). Отзыв устройства рассылает информационное уведомление остальным.

#### Сессии и keeper'ы (D-7, D-11, P-3, D-21)

- `createSession`: агент — из реестра адаптеров; опции устройства нормализуются до объявленных
  адаптером id со значением строго `true` (P-3); сырые `args` и произвольная `command` — только
  владельцу.
- Каталог: канонизация `lib/paths.js` (`realpathSync.native`, `path.relative`, сравнение без учёта
  регистра); с телефона отклоняются UNC, `\\?\`, `\\.\` и `C:foo`. Каталог устройства вне `projects`
  → `defaultCwd` (D-21, поведение OT-11).
- Resume при живой сессии того же агента в том же каталоге → `createConflict`, повтор с `force:true`
  (D-7, D-15.2).
- Лимиты: `maxSessions` (24), не более 10 созданий в минуту на устройство.
- keeper запускается `detached + windowsHide`; meta `sessions\<id>.json` хранит имя pipe
  `\\.\pipe\claude-bridge-<32 hex>`, секрет keeper'а (64 hex), токен хука и состояние адаптера.
  Окружение агента: окружение моста + `config.env` + `CLAUDE_BRIDGE_SESSION`,
  `CLAUDE_BRIDGE_HOOK_TOKEN`, `CLAUDE_BRIDGE_PORT`, `CLAUDE_BRIDGE_CERT_FP` + добавка адаптера;
  `CLAUDE_BRIDGE_KEEPER_SECRET` keeper удаляет из окружения до запуска агента.
- **Рукопожатие (D-11):** pipe доступен по SMB, поэтому keeper ничего не отдаёт (даже `hello`) и не
  принимает команд, пока клиент не докажет знание секрета (HMAC-challenge); keeper доказывает то же
  мосту. После рестарта моста секрет берётся из meta; `restoreSessions` переподключается с
  повторами до 30 с (M-6).
- Scrollback: буфер на сессию (`scrollbackBytes`); размер PTY «следует за тем, кто печатает».
- ConPTY: агент Claude включает win32-input-mode (`\x1b[?9001h`); после него одиночный Esc теряется,
  поэтому Esc в PTY пишется в кодировке win32-input-mode (D-23.1, `lib/win32-input.js`).

#### Адаптеры агентов (`agents/`, D-3, P-2, D-15.3)

Контракт (`agents/index.js`): `id, name, options[], scroll ('wheel'|'pageKeys', D-10),
events ('hook'|'sse'|'none'), available(), spawnSpec(), isResumeLike(), onHook(), onInput(),
subscribe(), reply()`. События адаптера (`status`, `request`, `requestClosed`, `notify`) применяет
`lib/session-events.js`.

| Адаптер | Запуск | События | Ответ |
|---|---|---|---|
| `claude` | `claude.exe` напрямую (за npm-шимом `claude.cmd`; без шима — `claude.exe` из PATH, D-19.5); опции `resume`, `skipPermissions` | хуки: `PermissionRequest` → запрос (мгновенно); `Notification[permission_prompt]` — запасной и после рестарта моста (D-23.4); `PreToolUse`/`PostToolUse`/`UserPromptSubmit` → `working`; `Stop` → `idle` + «готово»; `idle_prompt` игнорируется (D-23.5); события с `agent_id` статус не меняют | клавиши `1` / `2` / Esc (win32-input-mode); кнопки — только для белого списка инструментов (D-19.4); «Всегда» — при непустом `permission_suggestions`, подпись конкретизируется (D-23.6); очередь FIFO (D-19.3) |
| `opencode` | фоновый сервис (`service.json`, Basic-авторизация; не работает — `opencode service start`); сессия — `POST /api/session` с `location.directory` и (опция `askShell`, D-14) `permissions`; TUI `opencode.exe --server <url> --session <id>` с `OPENCODE_PASSWORD` | SSE `/api/event` с фильтром по `sessionID`, включая дочерние сессии субагентов (D-23.3); после переподключения — ресинхронизация разрешений | `POST /api/session/{id}/permission/{requestId}/reply` с `{decision}`; 404 = уже закрыт |
| `generic` | `command`/`args` из конфига | нет (только зеркало) | нет |

Запрос → `notify{event:'request', requestId, choices}`; ответ `reply` → `replyResult` (`ok` /
`stale` / `failed`); закрытие — `requestClosed` (ответ с любого клиента или любой ввод в PTY, кроме
пассивного: фокус, колесо, ответы терминала — D-19.1). Переподключившийся клиент получает повтор
всех ожидающих запросов (D-20). Текст для человека очищается от невидимых/bidi символов, длинное
значение — «начало…конец (N симв.)» (D-19.2, `lib/display-text.js`). Сессии opencode после `kill`
не удаляются в сервисе (D-15.11).

#### Хук Claude Code (`hooks/bridge-hook.js`, P-4, P-6)

Регистрируется установщиком (`tools/install-hooks.js`) в `%USERPROFILE%\.claude\settings.json`
exec-формой `{"type":"command","command":"node","args":["<repo>\\bridge\\hooks\\bridge-hook.js"]}`
(строковая форма шла бы через Git Bash) на событиях `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` (`matcher: "*"`), `Notification`,
`UserPromptSubmit`, `Stop`; слияние с хуками пользователя и бэкап файла. Вне bridge-сессии хук молча
выходит; в сессии — `POST /hook` с токеном хука и пиннингом сертификата. Хук никогда не мешает
Claude: код выхода 0, пустой stdout, ошибки проглатываются.

#### Голосовой ввод — `POST /stt`

Владелец или устройство; очередь ≤ `sttMaxQueue` (4) → 503; загрузка сразу на диск, лимит 20 МБ →
413; постоянный воркер `stt.py` через `sttPython` + `sttPythonArgs` (`py -3.11`), таймаут 180 с;
клиенту — обобщённая ошибка без путей.

#### Интернет-доступ (p2p iroh)

- Флаг `internet.json`; включение — только владельцем после подтверждения (см. «Сопряжение»),
  выключение — без подтверждения.
- Сайдкар `bridge\bin\claude-tunnel.exe listen --target 127.0.0.1:8792 --secret-file
  certs\iroh.key --allow-file certs\tunnel-allow.txt`; allowlist — NodeId сопряжённых устройств
  (телефон регистрирует свой NodeId сообщением `registerNode`).
- Перед стартом — `taskkill /IM claude-tunnel.exe /F` (бесхозные туннели прошлых запусков); при
  падении — рестарт через 3 с; при выходе моста туннель гасится.

#### Отзыв устройства — `revokeDeviceById`

Удаляет устройство из `pairings.json`, переписывает allowlist, рвёт его WS (`close(4401)`),
перезапускает туннель, уведомляет оставшиеся устройства.

#### Обнаружение в сети (P-7, D-17, D-18)

- `host:"auto"`: `lib/lan.js` выбирает частный адрес физического адаптера (виртуальные и VPN —
  vEthernet/WSL/Hyper-V/VirtualBox/VMware/Radmin/ZeroTier/Tailscale — по имени отбрасываются);
  мост слушает только `127.0.0.1` и этот адрес (не `0.0.0.0`, L-11). Адрес перепроверяется каждые
  15 с; без сети мост предупреждает и не выдаёт QR с `127.0.0.1`.
- **mDNS** (`lib/mdns.js`): имя хоста `claude-bridge-<fp8>.local`, A-запись — только слушаемый адрес,
  без IPv6, TXT `fp`.
- **UDP-маяк** (8791): на `CLAUDE_BRIDGE?` отвечает `{claudeBridge, port, fp}` без имени ПК, только
  частным адресам; сокет без `reuseAddr`.

#### Заголовки безопасности статики

CSP заголовком (`default-src 'self'`, `script-src 'self'`, `connect-src` к loopback ws/wss,
`object-src 'none'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy: no-referrer`; путь статики — `path.normalize` + `startsWith(WEB_DIR + sep)`.
Статика и `/health` — только владельцу или устройству.

#### Устойчивость (P-10)

Проверка типов всех входов (`lib/validate.js`; M-2, L-1, L-2, L-8: управляющие и bidi-символы
вырезаются); авторизация до апгрейда WS, `maxPayload` 4 МБ, не более 64 WS-клиентов (M-3);
исключения адаптеров не роняют мост.

### 3.4 `keeper.js` — хранитель сессии

Отсоединённый процесс без консоли, владеет одной ConPTY (`node-pty`) и переживает перезапуск моста.
Сначала слушает pipe, затем запускает агента (pipe занят — агент не стартует). Держит свой
scrollback. Протокол — JSON-строки после рукопожатия: вход `in` / `resize` / `kill`, выход
`hello` (буфер, размер, pid) / `out` / `exit`. Одиночный Esc из `in` перекодирует в win32-input-mode
(D-23.1). Любая ошибка — причина в лог, meta удаляется, процесс завершается.

### 3.5 `attach.js` (`claude-mobile`) — CLI на ПК

Локальный клиент: `wss://127.0.0.1:<port>/ws` с токеном владельца и пиннингом `certs\bridge.cer`.

| Команда | Действие |
|---|---|
| `claude-mobile [args…]` | новая сессия агента по умолчанию в текущем каталоге; аргументы — агенту |
| `claude-mobile --agent <id> [args…]` | новая сессия указанного агента |
| `claude-mobile -l` / `-a [id]` | список сессий / подключение |
| `claude-mobile --device` | устройства: отзыв, интернет-доступ (только TTY) |
| `claude-mobile --qr` | QR сопряжения (только TTY, с подтверждением) |
| `claude-mobile --open` | веб-интерфейс в браузере по одноразовой ссылке |
| `claude-mobile --rotate-token` | перевыпуск токена владельца |

- Raw-режим консоли; `Ctrl+\` — отсоединиться (сырой `0x1c` или нажатие в win32-input-mode, D-23.2,
  пакет агенту не пересылается). При выходе из raw-режима пишет `\x1b[?9001l`, чтобы консоль не
  осталась в win32-input-mode, включённом агентом.
- Изменение размера — событие `resize` stdout (на Windows нет `SIGWINCH`).
- Конфликт resume — вопрос в консоли и повтор с `force` (D-7).

### 3.6 `stt.py` — распознавание речи

Постоянный воркер `faster-whisper` (модель `large-v3`, CPU, int8), модель грузится один раз.
Протокол — JSON-строки stdin/stdout. VAD-фильтр против галлюцинаций на тишине, `initial_prompt` для
пунктуации, повторный проход, если длинный текст вернулся без знаков препинания.

### 3.7 Установщик (`install.ps1`, `uninstall.ps1`, `bridge/tools/`)

- `install.ps1`: Node ≥ 20 (обязательно), `claude`/`opencode` (предупреждение); `npm ci` (работающий
  мост останавливается, при живых keeper'ах — отказ: они держат файлы `node-pty`); каталог данных и
  `config.json`; шим `claude-mobile.cmd` в `<данные>\bin` + каталог в PATH пользователя (реестр
  `HKCU\Environment`, REG_EXPAND_SZ, `WM_SETTINGCHANGE`); хук (`tools/install-hooks.js`); задача
  Планировщика `ClaudeBridge` (AtLogOn, Interactive, Limited); `-Firewall` — правила
  `ClaudeBridge-TCP`/`ClaudeBridge-UDP` (профиль «Частная», `tools/firewall.ps1` с повышением прав
  через UAC только для этого шага); запуск моста. `-DryRun` ничего не меняет.
- `uninstall.ps1` — обратные шаги; каталог данных — только с `-RemoveData`; живые сессии не
  завершаются.
- Чистые функции — `tools/install-lib.ps1` (проверки `tools/test-install-lib.ps1`); сценарии
  проверяются только на временных каталогах (`bridge/test/installer.test.js`).

---

````

- [ ] **Step 3: Проверить**

```bash
grep -n "^## \|^### " ARCHITECTURE.md | head -40
grep -n "unix-сокет\|/proc\|systemd\|openssl\|0600\|bridge-hook.sh\|isLocal" ARCHITECTURE.md
```

Expected: заголовки §1–3 (3.1–3.7), затем `## 4. Интернет-туннель …`; второй `grep` находит строки только в §4–§11 (их меняют задачи 14–15).

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): purpose, topology and Windows bridge (P-4, P-6, D-8, D-9)"
```

---

### Task 14: `ARCHITECTURE.md` — правки §4–6 (туннель, Android, веб-интерфейс)

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Сверить факты клиентов (после подплана 3)**

```bash
grep -n "capturingClient\|pairByCode\|confirmFingerprint" android/app/src/main/java/com/q/claudebridge/*.java
grep -n "setAuthenticationRequired\|Origin\|38471" android/app/src/main/java/com/q/claudebridge/BridgeService.java android/app/src/main/java/com/q/claudebridge/LocalGateway.java
grep -n "filterPaste\|scrollSequence\|buildCreate" bridge/web/lib.js
grep -n "createConflict\|confirmRequest\|requestClosed" bridge/web/app.js android/app/src/main/java/com/q/claudebridge/BridgeService.java
grep -n "OPEN_REPARSE_POINT\|cfg(windows)" tunnel/src/main.rs
```

Expected: `capturingClient`/`pairByCode`/`confirmFingerprint` не найдены (QR-only); `setAuthenticationRequired(true)` в `BridgeService`; подмена `Origin` в `LocalGateway`; функции `lib.js` на месте; обработка `createConflict`/`confirmRequest`/`requestClosed`; ветка `cfg(windows)` в туннеле. Если что-то не так — подплан 3 не завершён: остановиться и сообщить контроллеру.

- [ ] **Step 2: §4 — туннель**

Заменить

```markdown
Sidecar на Rust (`iroh 1.0.2`, QUIC). Один бинарь, три подкоманды. Собирается и
как нативный ПК-бинарь (`bridge/bin/claude-tunnel`, x86_64), и как Android-.so
(`libclaudetunnel.so`, aarch64) — Android запускает его как обычный процесс.
```

на

```markdown
Sidecar на Rust (`iroh 1.0.2`, QUIC). Один бинарь, три подкоманды. Собирается и
как ПК-бинарь (`bridge\bin\claude-tunnel.exe`, `x86_64-pc-windows-msvc`), и как
Android-.so (`libclaudetunnel.so`, `aarch64-linux-android`) — Android запускает его
как обычный процесс. Оба собираются `tools/release.ps1` (`cargo build --release --locked`).
```

Заменить

```markdown
ed25519-ключ хранится в файле (`certs/iroh.key` на ПК, `files/iroh_phone.key` в
приложении). Логика чтения — усиленная (fail-closed, без TOCTOU):
```

на

```markdown
ed25519-ключ хранится в файле (`%LOCALAPPDATA%\ClaudeBridge\certs\iroh.key` на ПК,
`files/iroh_phone.key` в приложении).

**Windows (P-4):** файл открывается с `FILE_FLAG_OPEN_REPARSE_POINT` — симлинк или иная
точка повторного анализа открывается сама и отвергается (вместо `O_NOFOLLOW`); права не
меняются (защита — ACL профиля, D-8); новый ключ создаётся `create_new`.

**Unix (Android)** — логика чтения усиленная (fail-closed, без TOCTOU):
```

- [ ] **Step 3: §5 — Android**

Заменить подраздел `#### Сопряжение` в §5.1 (от строки `#### Сопряжение` до строки перед `#### Мост JS ↔ приложение`) на:

```markdown
#### Сопряжение (P-7, H-2)

- **Только QR** (`startScan`, ML Kit): `{cb:1, host, port, code, fp}`. Отпечаток получен вне
  канала → сразу пиннится (`Tls.buildClient(fp)`); QR без `fp` отвергается («Это не QR-код Claude
  Bridge»). Ручного ввода кода и TOFU-сопряжения нет; код не отправляется на адрес из обнаружения.
- Итог сохраняется в `BridgeStore` (`commitPairing`), новый ПК становится активным, сервис
  переподключается.
```

Заменить пункт

```markdown
- **Быстрый ответ** из уведомления (`ACTION_INPUT` → `ws.send` ввода в PTY, не
  открывая приложение). Кнопки «Да (1)», «Всегда (2)», «Нет (Esc)».
- **При биометрии** кнопки защищены: API≥31 — `setAuthenticationRequired(true)`
  (нажатие требует разблокировки), API<31 — кнопки не показываются вовсе; на
  локскрине контент скрыт (`VISIBILITY_SECRET`).
```

на

```markdown
- **Ответ из уведомления** (D-4): кнопки строятся по `choices` запроса (подписи — от моста,
  например «Всегда: доступ к каталогу …»); нажатие шлёт `reply{id, requestId, decision}`, не
  открывая приложение. `requestClosed` снимает уведомление; `replyResult` со `stale` — тост
  «Запрос уже закрыт — ответ не отправлен».
- **M-4:** на API ≥ 31 каждая кнопка ответа требует разблокировки
  (`setAuthenticationRequired(true)`, всегда, не только при биометрии); на API < 31 «Всегда» не
  показывается, а при биометрии кнопок нет вовсе; на локскрине при биометрии контент скрыт
  (`VISIBILITY_SECRET`).
- **Подтверждение операций владельца** (D-13): `confirmRequest` → уведомление «Claude Bridge:
  нужно подтверждение» с контрольным кодом и кнопками «Разрешить / Отклонить» (API ≥ 31, с
  разблокировкой) и диалог в открытом приложении (на API < 31 — только диалог); ответ —
  `confirm{confirmId, allow}`; `confirmClosed` снимает уведомление.
```

В `#### WebSocket` §5.2 заменить пункт

```markdown
- В `onMessage`: `notify` → системное уведомление; `status: working` → гасит
  устаревшее уведомление сессии; `sessions` → счётчик живых в статусе;
  `internet` → запоминает ticket ПК (`store.setTicket`).
```

на

```markdown
- В `onMessage` (разбор — `Protocol.java`, JVM-тесты): `notify` → системное уведомление
  (с кнопками по `choices`); `requestClosed` / `replyResult` → снятие уведомления / тост;
  `confirmRequest` / `confirmClosed` → подтверждение D-13; `status: working` → гасит устаревшее
  уведомление сессии; `sessions` → счётчик живых в статусе; `internet` → запоминает ticket ПК.
```

В §5.3 после пункта `- **\`:38472\` — ws-прокси**: …` (абзац заканчивается словами «подхватываются сами).») добавить:

```markdown
- Апгрейд проксируется с заголовком `Origin: http://127.0.0.1:38471` (D-15.12): allowlist `Origin`
  моста не отклоняет WebView, даже если шлюз занял запасной порт.
```

В §5.5 удалить пункт, начинающийся с `- \`capturingClient(seen)\``, и в пункте `pinnedTrust` оставить формулировку, соответствующую коду `Tls.java` после подплана 3 (если ветки `fpHex == null` больше нет — удалить «(`fpHex == null` → TOFU при сопряжении)»).

- [ ] **Step 4: §6 — веб-интерфейс**

Заменить первый абзац §6:

```markdown
`index.html` + `app.js` (≈830 строк) + `style.css`. Внутри приложения грузится
локально из assets; в браузере ПК — с моста. Определяет окружение по наличию
`window.AndroidApp`.
```

на

```markdown
`index.html` + `app.js` + `lib.js` (чистые функции: `filterPaste`, `scrollSequence`,
`buildCreate`; тесты `bridge/test/web-lib.test.js`) + `style.css`. Внутри приложения
грузится локально из assets (копия `bridge/web`, Gradle `syncWebAssets`); в браузере ПК —
с моста после входа по одноразовой ссылке. Окружение — по наличию `window.AndroidApp`.
```

В §6.2 заменить пункт

```markdown
- **Прокрутка:** обычный буфер (bash) — листаем scrollback xterm; альтернативный
  экран (Claude Code TUI) — шлём приложению **события колеса мыши**
  (`\x1b[<64…M`), TUI сам перерисовывает историю (`sendScroll` через тип
  `scroll`, чтобы не переключать «владельца размера» PTY).
```

на

```markdown
- **Прокрутка:** обычный буфер — листаем scrollback xterm; альтернативный экран — способ
  объявляет адаптер в `sessions[].scroll` (D-10): `wheel` — события колеса SGR
  (`\x1b[<64…M`, Claude Code и opencode), `pageKeys` — PageUp/PageDown (generic по умолчанию:
  системный ConPTY не пересылает включение режима мыши). Отправка — тип `scroll`, чтобы не
  переключать «владельца размера» PTY.
```

В §6.3 заменить пункты

```markdown
- Панель клавиш (Esc, Tab, стрелки, Enter, ^C, вставка) + поле сообщения (Enter
  отправляет текст + `\r`).
```

и

```markdown
- Диалог новой сессии: выбор проекта (из `projects`) или свой путь, чекбоксы
  `--resume` / `--dangerously-skip-permissions`.
```

соответственно на

```markdown
- Панель клавиш (Esc, Tab, стрелки, Enter, ^C, вставка) + поле сообщения (Enter
  отправляет текст + `\r`). Вставка (кнопка, поле, терминал) проходит `filterPaste`:
  управляющие и невидимые символы вырезаются (L-10).
```

и

```markdown
- Диалог новой сессии: агент (из `sessions.agents`) и его опции-флажки (`options`
  адаптера), каталог из `projects` или свой путь; уходит `create{agent, options}` (P-3).
  `createConflict` (живая сессия этого агента в каталоге при resume) → предупреждение и
  повтор с `force:true` (D-7).
- В WebView телефона — диалог подтверждения операции владельца (`confirmRequest`, крупно
  `checkCode`); во время проигрывания буфера ответы терминала не отправляются (D-19.1).
```

- [ ] **Step 5: Проверить**

```bash
grep -n "capturingClient\|Ручной код\|Да (1)\|bridge/bin/claude-tunnel\b\|certs/iroh.key" ARCHITECTURE.md
```

Expected: пусто (или только §7–§11, которые заменяет задача 15).

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): tunnel on Windows, QR-only pairing, choices and confirmations in clients"
```

---

### Task 15: `ARCHITECTURE.md` — §7–12 (протоколы, безопасность, сборка, раскладка, потоки, ограничения)

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Сверить список WS-сообщений**

```bash
sed -n '/wss.on(.connection/,$p' bridge/server.js | grep -o "case '[a-zA-Z]*'" | sort -u
grep -o "type: '[a-zA-Z]*'" bridge/server.js bridge/lib/session-events.js | sed 's/.*type: //' | sort -u
```

Expected: клиент → мост: `attach confirm create devices input internet issueLoginToken kill list pairinfo registerNode remove reply resize revokeDevice rotateOwnerToken scroll setInternet`; мост → клиент: `confirmClosed confirmPending confirmRequest confirmRequired confirmResult createConflict created devices error exit internet loginToken notify output pairinfo replyResult requestClosed resized scrollback sessions status`. Отличия — отразить в тексте ниже.

- [ ] **Step 2: Заменить конец файла**

Заменить текст от строки `## 7. Протоколы (сводка)` до конца файла на:

````markdown
## 7. Протоколы (сводка)

### 7.1 WebSocket клиент ↔ мост (`/ws`, JSON)

**Клиент → мост:** `create` (`cwd`, `agent`, `options`, `force`; владельцу также `args`,
`command`, `title`), `attach` (id/cols/rows), `input`, `scroll` (не двигает владельца размера),
`resize`, `kill`, `remove`, `list`, `reply` (`id`, `requestId`, `decision`: `once|always|reject`),
`internet`, `registerNode` (только устройство, свой NodeId), `confirm` (`confirmId`, `allow`;
только сопряжённое устройство), только владелец: `devices`, `setInternet`, `pairinfo`
(+`confirmed`), `revokeDevice`, `issueLoginToken`, `rotateOwnerToken`.

**Мост → клиент:** `sessions` (сессии с `agent`, `scroll`; `agents` с опциями; `projects`),
`created`, `createConflict` (`live`), `scrollback`, `output`, `resized`, `exit`, `status`,
`notify` (`event`: `request|done|info`; для `request` — `requestId`, `choices:[{id,label}]`),
`requestClosed`, `replyResult` (`ok`, `error: stale|failed`), `devices`, `internet`, `pairinfo`,
`loginToken`, `confirmRequired`, `confirmPending` (`checkCode`), `confirmRequest` (`confirmId`,
`action`, `checkCode`; устройствам), `confirmResult` (`allow`, `reason`, `retryAfterSec`),
`confirmClosed`, `error`. Закрытие с кодом 4401 — устройство отозвано / токен владельца перевыпущен.

### 7.2 Keeper ↔ мост (named pipe, JSON-строки)

Pipe `\\.\pipe\claude-bridge-<32 hex>`; сначала взаимное HMAC-рукопожатие с секретом сессии (D-11),
затем мост→keeper: `in`, `resize`, `kill`; keeper→мост: `hello`, `out`, `exit`.

### 7.3 Сайдкар туннеля → родитель (stdout, JSON-строки)

`ready` (ticket/node_id или port), `conn` (id/remote), `path` (id/path/addr/rtt_ms), `close` (id),
`id` (node_id), `error` (message).

### 7.4 HTTP-эндпоинты моста

`POST /pair` (код → токен; только основной порт, без авторизации), `POST /stt` (владелец или
устройство), `POST /hook` (токен хука своей сессии), `GET /health` (владелец или устройство),
`GET /?ott=…` (вход браузера; loopback, основной порт), статика (владелец или устройство).

### 7.5 UDP-обнаружение

Телефон → broadcast `CLAUDE_BRIDGE?` на `:8791`. Мост → unicast `{claudeBridge, port, fp}`
(только частным адресам, без имени ПК).

---

## 8. Модель безопасности (сводка)

Модель угроз — D-8: личный ПК, одна учётная запись. Вредоносная программа под учётной записью
владельца — вне модели.

| Угроза | Защита |
|---|---|
| Перехват трафика (MITM) | TLS с пиннингом SHA-256 отпечатка у телефона, `claude-mobile` и хука (M-8); доверие только по отпечатку |
| Подмена ПК при сопряжении | Только QR: отпечаток вне канала, код не уходит на адрес из обнаружения (H-2) |
| Веб-страница в браузере ПК → мост (CSWSH, H-1) | Токен владельца вместо доверия по адресу; allowlist `Origin`; HttpOnly-cookie браузерного токена, вход по одноразовой ссылке |
| Агент выпускает код сопряжения / включает интернет (M-6) | Подтверждение человеком: консоль для первого телефона, затем только сопряжённый телефон с контрольным кодом и паузой после отказа (D-13, D-22) |
| Агент «подтверждает сам себе» | Токены устройств на ПК — только SHA-256 (D-15.7); `phoneRequired` закрывает консольный путь навсегда |
| Агент получает права владельца без чтения файлов | `--open` печатает ссылку и `--qr`/`--device` работают только в интерактивной консоли (D-18.2) |
| Флаги агента с телефона (M-7) | Телефон передаёт только id опций адаптера (P-3) |
| Доступ к pipe keeper'а по SMB | Взаимное HMAC-рукопожатие с секретом сессии (D-11) |
| Скрытый хвост команды в запросе разрешения | Очистка невидимых/bidi символов, «начало…конец» (D-19.2) |
| Ответ агенту с заблокированного телефона (M-4) | `setAuthenticationRequired(true)` на API ≥ 31; на API < 31 без «Всегда» |
| Коллеги в офисной сети (P-7) | Мост слушает loopback и один LAN-адрес; маяк и mDNS без имени ПК; правила брандмауэра только для профиля «Частная» |
| Тайминг-атаки | Сравнение токенов и кодов за постоянное время |
| Перебор кода сопряжения | 5 попыток с адреса → блок 15 мин, 50 на код, код одноразовый, 10 мин |
| Падение моста от некорректного входа (M-2, L-1, L-2, M-3) | Проверка типов всех входов, авторизация до апгрейда WS, `maxPayload`, предел клиентов |
| Любой узел интернета → порт моста | Туннель fail-closed без allowlist; allowlist NodeId устройств, перепроверка на каждый поток |
| Кража p2p-ключа подменой пути | Windows: `FILE_FLAG_OPEN_REPARSE_POINT`, отказ от точек повторного анализа; Android: `O_NOFOLLOW` + операции по fd |
| Секреты в рабочей копии git (M-1) | Каталог данных в `%LOCALAPPDATA%`, `.gitignore` как страховка |
| Кража токена через XSS в WebView | Токен подставляет нативный ws-прокси; странице — только nonce запуска |
| Чужое приложение на телефоне → прокси | nonce запуска, сверка за постоянное время |
| Утечка экрана телефона | `FLAG_SECURE`, биометрия с повторным запросом после гашения экрана, `VISIBILITY_SECRET` |
| Подмена APK | Release подписан ключом команды; SHA-256 сертификата — в README, SHA-256 артефактов — в `SHA256SUMS.txt`; `debuggable false` (M-5); wrapper Gradle с `distributionSha256Sum` (S-1) |

---

## 9. Сборка и запуск

### 9.1 Мост (ПК)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Firewall]   # установка / обновление
cd bridge; npm test                                                   # тесты (node:test)
node server.js                                                        # ручной запуск в консоли (отладка)
```

Изолированный запуск для тестов: `CLAUDE_BRIDGE_HOME` (каталог данных),
`CLAUDE_BRIDGE_LISTEN_PORT`, `CLAUDE_BRIDGE_TEST=1` (без mDNS, QR и файлового лога).

### 9.2 Туннель (Rust)

`tools/release.ps1` (`-SkipApk` — без APK): ПК — `cargo build --release --locked` →
`bridge\bin\claude-tunnel.exe`; Android — NDK 28 (`clang.exe --target=aarch64-linux-android26`
как компилятор C и компоновщик) → `android\app\src\main\jniLibs\arm64-v8a\libclaudetunnel.so`.

### 9.3 Приложение (Android)

```powershell
cd android
.\gradlew.bat assembleDebug          # preBuild синхронизирует web-assets и xterm из bridge/
.\gradlew.bat testDebugUnitTest      # JVM-тесты Protocol
```

Wrapper — официальный Gradle 8.7 с `distributionSha256Sum`. Release подписывается ключом команды
из свойств Gradle `cbRelease*` (передаёт `tools/release.ps1`); без них — `app-release-unsigned.apk`.

### 9.4 Релиз

`tools\release.ps1 -KeystorePath <ключ>` → `dist\`: `claude-tunnel.exe`, `libclaudetunnel.so`,
`ClaudeBridge-<версия>.apk`, `SHA256SUMS.txt`, `RELEASE_NOTES.md` (коммит, версии инструментов,
SHA-256 сертификата подписи). Пароль ключа вводится интерактивно и передаётся только процессу
Gradle (`--no-daemon`).

---

## 10. Раскладка файлов

Права — ACL профиля пользователя (D-8); POSIX-режимов на Windows нет.

| Путь | Содержимое |
|---|---|
| `%LOCALAPPDATA%\ClaudeBridge\config.json` | конфиг + env сессий |
| `…\pairings.json` | SHA-256 токенов устройств, имена, NodeId, `phoneRequired` |
| `…\internet.json` | флаг интернет-доступа |
| `…\owner.token` | токен владельца |
| `…\certs\bridge.pfx`, `bridge.pass`, `bridge.cer` | ключ и сертификат TLS, пароль PFX, сертификат (DER) |
| `…\certs\iroh.key` | ed25519-ключ p2p-личности ПК |
| `…\certs\tunnel-allow.txt` | allowlist NodeId устройств |
| `…\sessions\<id>.json` | meta живых сессий: pipe, секрет keeper'а, токен хука, состояние адаптера |
| `…\logs\bridge.log`, `bridge.log.1` | лог моста (ротация 5 МБ) |
| `…\bin\claude-mobile.cmd` | шим (`install.ps1`), каталог — в PATH пользователя |
| `%USERPROFILE%\.claude\settings.json` | хук моста (exec-форма); бэкапы `settings.json.bak-*` |
| `bridge\bin\claude-tunnel.exe` | туннель ПК (собирается из исходников) |
| Задача Планировщика `ClaudeBridge` | автозапуск моста при входе |
| Правила `ClaudeBridge-TCP` / `ClaudeBridge-UDP` | вход TCP 8790 / UDP 8791, профиль «Частная» (по желанию) |
| Android `files/iroh_phone.key` | p2p-ключ телефона |
| Android `jniLibs/arm64-v8a/libclaudetunnel.so` | туннель телефона |

Порты: **8790** — HTTPS/WSS моста; **8791** — UDP-маяк; **8792** — loopback-вход туннеля;
**38471/38472** — локальный шлюз приложения (UI + прокси).

---

## 11. Ключевые сквозные потоки

**Сопряжение:** `claude-mobile --qr` → мост просит подтверждение (консоль `[y/N]` для первого
телефона или `confirmRequest` с контрольным кодом на сопряжённом) → `pairinfo` → QR в консоли →
телефон сканирует → `POST /pair` с пиннингом `fp` → токен (на ПК — только его SHA-256) →
`BridgeStore` → сервис подключается по WSS; остальным устройствам — уведомление.

**Открытие терминала в приложении:** MainActivity грузит `http://127.0.0.1:38471` → `app.js`
зовёт `AndroidApp.wsUrl()` → WebSocket на `ws://127.0.0.1:38472/ws?cbnonce=…` → LocalGateway
сверяет nonce, подставляет токен и `Origin`, открывает TLS к мосту → `sessions`/`scrollback` →
xterm рисует.

**Запрос разрешения (Claude Code):** диалог в TUI → хук `PermissionRequest` → `POST /hook` →
адаптер `claude` → `notify{request, choices}` → уведомление с кнопками → «Да» (с разблокировкой) →
`reply{once}` → адаптер пишет `1` в PTY → `replyResult ok`, `requestClosed`. Для opencode —
`permission.asked` из SSE → тот же путь → ответ через API сервиса.

**Подтверждение операции владельца:** `claude-mobile --device` → `i` → `setInternet` → мост:
`confirmPending{checkCode}` в консоль, `confirmRequest{checkCode}` устройствам → человек сверяет код
и нажимает «Разрешить» → `confirm{allow:true}` → туннель включается, `confirmResult`.

**Голос:** долгое нажатие «отправить» → `MediaRecorder` → `POST /stt` → `stt.py` → текст в поле или
сразу агенту.

**Уход из сети ПК:** ПК не виден в LAN > 15 с → BridgeService поднимает `claude-tunnel connect` по
сохранённому `nodeTicket` → iroh до `listen` на ПК (allowlist NodeId) → `wss://127.0.0.1:<порт
туннеля>` → QUIC → loopback-порт 8792. Возврат в LAN — переподключение по прямому пути.

---

## 12. Известные ограничения

- **Граница каталога для устройств (D-21):** сессия устройства с каталогом вне `projects`
  запускается в `defaultCwd`; настоящая граница возможностей устройства — набор опций адаптера: с
  опцией `skipPermissions` агент не ограничен своим каталогом.
- **Подтверждение на телефоне не защищает от агента, который правит файлы моста и перезапускает
  его (D-22.1):** это эквивалент вредоносной программы под учётной записью пользователя (вне D-8).
  Агент той же учётной записи может прочитать `owner.token` и meta сессий (D-16.3).
- **Claude Code (D-23.7):** «готово» может прийти раньше окончания фонового субагента (O-2); после
  рестарта моста экран TUI может восстановиться только после следующей перерисовки (O-5, гипотеза).
  После рестарта моста при открытом диалоге разрешения кнопок нет — уведомление информационное
  (D-23.4).
- **`generic`** — только зеркало: без статусов, уведомлений и кнопок ответа.
- **Android < 12 (API < 31):** без кнопки «Всегда»; подтверждение операций владельца — только в
  открытом приложении (M-4, D-15.10).
- **Хук Claude Code в пользовательских настройках (P-6)** запускает `node` на каждое событие в
  каждой сессии Claude на ПК; вне сессий моста хук сразу выходит.
- **Мост работает только в сеансе пользователя** (задача Планировщика, не служба): до входа в
  Windows мост недоступен.
- **Брандмауэр:** корпоративные политики могут запрещать правила — тогда остаётся только туннель
  (P-4). Профиль сети Wi-Fi на ПК должен быть «Частная».
- **Только Windows-хост (D-9).**

---

*Конец документа.*
````

- [ ] **Step 3: Проверить**

```bash
grep -n "unix-сокет\|/proc\|systemd\|openssl\|0600\|bridge-hook.sh\|isLocal\|KillMode\|~/.claude-bridge" ARCHITECTURE.md
grep -n "^## " ARCHITECTURE.md
grep -c "12-известные-ограничения" README.md README.en.md
```

Expected: первый `grep` пуст (кроме слова `0600`/`O_NOFOLLOW` в §4.2 «Unix (Android)», если там осталось — это описание Android-ветки, допустимо); заголовки `## 1.` … `## 12. Известные ограничения`; якорь из README существует (по 1 в каждом README).

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(architecture): protocols, security model, build, layout, flows, known limitations"
```

---

### Task 16: Ручная задача пользователя — установка на реальном ПК

> Выполняет **пользователь** (меняет его `settings.json`, PATH, Планировщик и брандмауэр). Агент только готовит команды и разбирает результат.

- [ ] **Step 1: Сухой прогон**

Run: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun -Firewall`
Expected: список действий `[dry-run] …` без ошибок.

- [ ] **Step 2: Установка**

Если мост уже запущен вручную с живыми сессиями — завершить сессии (или добавить `-SkipNpm`).
Run: `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Firewall`
Expected: `Готово.`; `Мост слушает порт 8790`; UAC-запрос для брандмауэра подтверждён.

- [ ] **Step 3: Проверки**

```powershell
Get-ScheduledTask -TaskName ClaudeBridge | Select-Object TaskName, State
node bridge\tools\install-hooks.js status; $LASTEXITCODE
netsh advfirewall firewall show rule name=ClaudeBridge-TCP
netsh advfirewall firewall show rule name=ClaudeBridge-UDP
Get-ChildItem "$env:USERPROFILE\.claude\settings.json.bak-*"
```

Expected: задача `Ready`/`Running`; `Хук моста установлен`, код 0; оба правила `Profiles: Private`, `LocalPort: 8790`/`8791`; одна свежая резервная копия.

- [ ] **Step 4: Новое окно консоли**

```powershell
where.exe claude-mobile
claude-mobile -l
```

Expected: `%LOCALAPPDATA%\ClaudeBridge\bin\claude-mobile.cmd`; `Сессий нет.` или список.

- [ ] **Step 5: Выход из Windows и вход** — мост поднялся сам (`claude-mobile -l` работает); **мелькнуло ли окно консоли** при входе — записать в отчёт (P-4 «проверить»).

- [ ] **Step 6: Сквозной сценарий**

1. `claude-mobile --qr` → подтверждение на телефоне (сверить код) → QR (телефон уже сопряжён release-APK из задачи 10) или сопряжение заново.
2. `claude-mobile` в каталоге проекта → попросить Claude выполнить `echo hi` → уведомление с кнопками на телефоне → «Да» → команда выполнена.
3. `Ctrl+\` → в той же консоли набрать `dir` → вводится обычным текстом (задача 1).
4. `claude-mobile --agent opencode` с телефона/ПК → запрос с опцией «Спрашивать разрешение на команды» → «Да».

Expected: все шаги проходят; расхождения — в отчёт с выводом команд.

- [ ] **Step 7: Проверка удаления без изменений**

Run: `powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DryRun -Firewall`
Expected: список действий `[dry-run] …` (задача, мост, хук, PATH, шим, брандмауэр); система не изменена.

---

### Task 17: Актуализация реестра решений (только факты)

**Files:**
- Modify: `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md`

- [ ] **Step 1: Строки «Статуса реализации»**

В таблице `## Статус реализации (обновляется по факту)`, подставив хэши коммитов задач этого плана из `git log --oneline`:

- строку `| P-4 туннель под Windows | ✅ собран \`bridge/bin/claude-tunnel.exe\`; сборка под Android не проверена (нет NDK) | \`f366001\` |` — если задача 9 выполнена, заменить текст статуса на `✅ \`claude-tunnel.exe\` и \`libclaudetunnel.so\` собираются \`tools/release.ps1\` (NDK <версия>)` и добавить коммит задачи 8; если задача 9 отложена — дописать `; \`tools/release.ps1\` (подплан 4) — с \`-SkipAndroidTunnel\`, задача 9 отложена`;
- в строке `| P-6 хук на Node с пиннингом (M-8) | ✅ (регистрация в \`settings.json\` — подплан 4) | \`3c38f3e\` |` заменить скобку на `(регистрация в \`settings.json\` — \`install.ps1\` + \`tools/install-hooks.js\`)` и добавить коммит задачи 2;
- в строке `| P-4 автозапуск (\`start-bridge.js\`) | ✅ (задача Планировщика — \`install.ps1\`, подплан 4) | \`814ca1c\` |` заменить скобку на `(задача Планировщика, PATH-шим, брандмауэр — \`install.ps1\`/\`uninstall.ps1\`)` и добавить коммиты задач 3–5;
- строку `| P-8 распространение, README, ARCHITECTURE.md под Windows | ⬜ подплан 4 (не написан) | — |` заменить на `| P-8 распространение, README, ARCHITECTURE.md под Windows | ✅ подплан 4 \`docs/superpowers/plans/2026-10-31-distribution.md\`: установщик, wrapper Gradle 8.7, подпись release, \`tools/release.ps1\`, README/README.en, ARCHITECTURE | <коммиты задач 6–8, 11–15> |`;
- добавить строку `| \`claude-mobile\` выключает win32-input-mode при отсоединении (живая проверка D-23) | ✅ \`\x1b[?9001l\` при выходе из raw-режима | <коммит задачи 1> |`.

- [ ] **Step 2: Факты ручной установки**

После раздела `### Живая перепроверка D-23 (2026-10-31)` добавить раздел `### Установка на реальном ПК (подплан 4, задача 16, <дата>)` — таблица «Что / Факт / Итог» по шагам 2–7 задачи 16 (включая наблюдение о мелькании окна консоли при входе). Только наблюдения; новые решения в реестр не записывать — вынести контроллеру.

- [ ] **Step 3: Проверить**

Run: `git diff --stat docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md`
Expected: изменён только этот файл; в diff нет новых строк `D-24`/`P-11` и т.п.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md
git commit -m "docs: implementation status of P-4, P-6, P-8 after sub-plan 4"
```

---

## Самопроверка плана

**Покрытие решений и требований:**

| Решение / требование | Задачи |
|---|---|
| P-6: хук один раз в `%USERPROFILE%\.claude\settings.json`, слияние, бэкап, exec-форма из `hook-settings.js` | 2, 4, 16 |
| P-4: задача Планировщика «при входе», только сеанс пользователя, `node bridge\start-bridge.js` | 3, 4, 16 |
| P-4: брандмауэр TCP 8790 / UDP 8791, профиль «Частная», `netsh advfirewall`, один раз от администратора | 3, 4, 16 |
| P-4: шим `claude-mobile.cmd` в `%LOCALAPPDATA%\ClaudeBridge\bin`, каталог в PATH пользователя | 3, 4, 16 |
| P-8: `install.ps1` — Node / claude / opencode, `npm ci`, каталог данных, задача, брандмауэр, хук, шим | 4 |
| P-8: `uninstall.ps1` — обратные шаги | 5 |
| P-8: release-APK с подписью ключом команды, SHA-256 сертификата в README, `debuggable false` (M-5) | 7, 8, 10, 11, 12 |
| P-8 / S-1: wrapper Gradle 8.7 + `distributionSha256Sum` (проверить и пропустить, если сделано подпланом 3) | 6 |
| P-8: бинари туннеля `x86_64-pc-windows-msvc` и `aarch64-linux-android` с SHA-256 в release notes | 8, 9 |
| NDK — только после явного одобрения пользователя | 9 |
| README / README.en под Windows, скоуп D-9, «не для общих компьютеров» (D-8) | 11, 12 |
| ARCHITECTURE: каталог данных, токен владельца, pipe с рукопожатием, адаптеры, подтверждения D-13/D-22, mDNS/маяк, D-17/D-18, ограничения D-21, D-22.1, D-23.7 | 13, 14, 15 |
| `claude-mobile` шлёт `\x1b[?9001l` при отсоединении | 1 |
| Проверки установщика без изменения реальной системы (`-DryRun`, `-DataRoot`, `-SettingsPath`, отказ нестандартного `-DataRoot` без `-SkipTask -SkipPath`) | 3, 4, 5 |
| Реальная установка — только ручной шаг пользователя | 16 |
| Актуализация документации по факту | 17 |

**Допущения, которые проверяются при выполнении:**

1. `Register-ScheduledTask` с триггером `AtLogOn` для **своей** учётной записи и `RunLevel Limited` работает без прав администратора. Если нет — установщик сообщает и предлагает запуск от администратора с `-SkipNpm` (задача 4, шаг 4; проверка — задача 16).
2. Процесс `node.exe`, запущенный задачей Планировщика, может кратко показать окно консоли (P-4 «проверить мелькание») — наблюдение в задаче 16, шаг 5; решение при проблеме — за пользователем (вопрос 4).
3. ConPTY в node-pty сохраняет win32-input-mode консоли после выхода `claude-mobile` (воспроизводимость дефекта задачи 1); если нет — тест остаётся регрессионным (задача 1, шаг 3).
4. Запись `process.stdout.write` в обработчике выхода успевает в консоль на Windows; запасной вариант — `fs.writeSync` (задача 1, шаг 6).
5. Вызовы нативных программ обёрнуты в `Invoke-CbNative` / `Invoke-Checked` (`$ErrorActionPreference = 'Continue'` на время вызова), поэтому строки stderr (`npm`, `cargo`, `gradle`, `node`) не обрывают сценарий даже при перенаправленных потоках PowerShell 5.1; текст stderr `install-hooks.js` («файл не изменён») доходит до вывода, который проверяют тесты задачи 4 — подтверждается их прогоном.
6. Сборка `ring` под `aarch64-linux-android` с `clang.exe --target=aarch64-linux-android26` из NDK на Windows-хосте проходит; запасной вариант — `.cmd`-обёртки NDK (задача 9, шаг 4).
7. `ndk;28.2.13676358` доступен в `sdkmanager`; иначе — новейший `ndk;28.*` (задача 9, шаг 2).
8. `gradle wrapper` официального Gradle 8.7 даёт `gradle-wrapper.jar`, совпадающий с `gradle-8.7-wrapper.jar.sha256` с gradle.org (задача 6, шаг 5).
9. Набор событий хука — по коду `bridge/tools/hook-settings.js` (8 событий, включая `PermissionDenied`), а не по перечню из задания контроллера (7 событий без `PermissionDenied`).
10. `CLAUDE_CONFIG_DIR` не учитывается: файл по умолчанию — `%USERPROFILE%\.claude\settings.json` (как в P-6); при другом расположении — `install.ps1 -SettingsPath`.
11. Правила брандмауэра — по порту и профилю, без привязки к `node.exe` (формулировка P-4).
12. `install.ps1`/`uninstall.ps1` — в корне репозитория (P-8 называет файл без каталога), вспомогательные файлы — в `bridge/tools/`, релиз — `tools/release.ps1`.

**Вопросы уровня решений (перечислены контроллеру, в плане не приняты):**

1. Где хранится ключ подписи команды и его резервная копия; кто ещё имеет к нему доступ (P-8 говорит только «у владельца репозитория»). План принимает путь параметром `-KeystorePath` и не создаёт ключ сам.
2. Канал распространения `dist\` (Releases репозитория `Aleksei-Dobrynin/agent-bridge-windows` или иное). README (задачи 11–12) ссылается на Releases этого репозитория — заменить, если выбран другой канал.
3. Версия APK (`versionCode 1`, `versionName "0.1"` не менялись) — повышать ли и по какой схеме; имя артефакта берётся из `versionName`.
4. Если окно консоли мелькает при запуске задачи Планировщика — способ скрытого запуска (P-4 упоминает «скрытый запуск через PowerShell»; есть и другие варианты) — выбор пользователя.
5. Если регистрация задачи требует прав администратора — оставить «перезапуск от администратора» или иной механизм автозапуска (P-4 фиксирует Планировщик).
6. Сбрасывать ли при отсоединении `claude-mobile`, кроме `\x1b[?9001l`, и другие режимы консоли, которые мог включить агент (события фокуса `?1004`, мышь `?1000/1002/1003/1006`, альтернативный экран `?1049`) — задание просит только `?9001l`.
7. README сохраняет ссылки исходного проекта (видео, Boosty автора) в разделе «Происхождение и лицензия», а не в шапке — подтвердить или убрать.
