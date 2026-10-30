# Адаптеры агентов и протокол запросов — план реализации (подплан 2 из 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** мост запускает не только Claude Code, но и opencode (через его фоновый сервис) и любой TUI-агент из конфига; запросы разрешений приходят на телефон как семантические `notify{requestId, choices}` и подтверждаются сообщением `reply{requestId, decision}` с защитой от устаревших ответов; выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже сопряжённом телефоне.

**Architecture:** специфика агентов — в модулях `bridge/agents/{claude,opencode,generic}.js` с общим контрактом (финализация P-2) и реестре `bridge/agents/index.js`; клиент сервиса opencode (HTTP + SSE с переподключением и ресинхронизацией) — `bridge/agents/opencode-client.js`; применение событий адаптера к сессии — чистая функция `bridge/lib/session-events.js`; подтверждения D-13 — `bridge/lib/confirmations.js`. `server.js` только связывает модули. Всё новое покрыто `node:test`; opencode в юнит-тестах заменён локальным фейковым HTTP-сервером, реальный сервис нужен только для теста под `CB_LIVE_OPENCODE=1`.

**Tech Stack:** Node.js 24 (`node:test`, `http`, `https`, `child_process`), `ws` 8, `node-pty` 1.1 (только в живой пробе), Claude Code 2.1.284 (`claude.exe`), opencode v2.1.4 (`opencode.exe`, `opencode service`).

**Источник решений:** `docs/specs/2026-10-31-windows-opencode-adaptation-inventory.md` — D-2/D-12, D-3 + P-2, D-4, D-5 + P-3, D-7, D-10, D-13, D-14, P-6, P-7, L-8, разделы «Живая проба Claude Code 2.1.284» и «Живая проба opencode v2.1.4». Клиенты (веб, Android) — подплан 3, установщик (регистрация хуков в `settings.json`) — подплан 4.

**Предпосылка:** подплан 1 (`docs/superpowers/plans/2026-10-31-windows-bridge-core.md`) выполнен полностью, включая задачи 10–15 и раздел «Поправки по итогам ревью»: есть `lib/{datadir,paths,tokens,origin,cert,keeper-channel,which,validate,log}.js`, токен владельца, `principal(req)`, `ws.deviceId === 'local'` для владельца, keeper по named pipe, `hookToken` сессии, Node-хук `hooks/bridge-hook.js`, `CLAUDE_BRIDGE_HOME`/`CLAUDE_BRIDGE_PORT`/`CLAUDE_BRIDGE_TEST`. Перед началом: `cd bridge && npm test` → `# fail 0`.

**Не делаем (D-9):** совместимость со старым протоколом и старыми ключами конфига (`claudeCommand`, `claudeArgs` удаляются без миграции), Linux.

---

> **Поправки перед выполнением (2026-10-31) — имеют приоритет над текстом задач.** План писался до завершения
> подплана 1; фактический код ушёл вперёд. Исполнитель обязан читать текущий код (`bridge/server.js`,
> `bridge/attach.js`, `bridge/lib/*.js`, `bridge/test/helpers/bridge.js`) — реальные API важнее фрагментов плана.
>
> | # | Поправка |
> |---|---|
> | 1 | **D-15 п. 7 — новая задача 14a (перед задачей 15):** токены устройств хранятся в `pairings.json` только как SHA-256-хэш (`tokenHash`); `/pair` возвращает токен телефону один раз и сохраняет хэш; `deviceByToken` сравнивает хэш постоянного времени; `deviceId` = первые 12 hex от хэша. Старые записи с открытым `token` не поддерживаются (D-9). Тест: в `pairings.json` после сопряжения нет токена, вход по токену работает. |
> | 2 | Событие `notify` после `/pair` (`event:'DevicePaired'`, подплан 1, `server.js`) перевести на `event:'info'` по формату D-15 п. 1. |
> | 3 | Переопределение порта моста в тестах — `CLAUDE_BRIDGE_LISTEN_PORT`; агенту передаются `CLAUDE_BRIDGE_PORT`, `CLAUDE_BRIDGE_HOOK_TOKEN`, `CLAUDE_BRIDGE_CERT_FP`, `CLAUDE_BRIDGE_SESSION`; тестовый мост — через `test/helpers/bridge.js` (обходит зарезервированные Windows диапазоны портов). |
> | 4 | Владелец — токен владельца (Bearer) или браузерный токен в cookie (D-16.1); `deviceId` владельца — `'local'`. `pairinfo`/`setInternet` сейчас требуют `confirmed:true` (TTY); задача 15 заменяет это на подтверждение телефоном, если есть сопряжённые устройства (D-13), и оставляет TTY-путь, когда устройств нет. `pairinfo` без LAN-адреса отвечает ошибкой (D-18 п. 3) — сохранить. |
> | 5 | `claude-mobile` (задача 16): `--qr`, `--device`, `--open` уже требуют TTY и используют `lib/open-url.js` — не откатывать (D-18 п. 2). |
> | 6 | Запуск агентов через `lib/which.js` (`.cmd` одной строкой, `/v:off`); адаптеры `claude`/`opencode` запускают реальный `.exe` (задача 1). Канал keeper — `lib/keeper-channel.js`. |
> | 7 | Коммиты — после каждой задачи с зелёным `npm test`; трейлер `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; без push. |
> | 8 | Задача 11: `/hook` применяет событие адаптера **до** ответа хуку (`PermissionRequest` приходит через ~0,15 с после `PreToolUse` и без `tool_use_id`; порядок держится тем, что Claude Code ждёт окончания хука). Ответ «3» на ПК в 3-пунктовом диалоге (= No без auto mode) оставляет статус `working` до следующего события — принято (делегировано). |

## Карта файлов

| Файл | Ответственность |
|---|---|
| `bridge/lib/agent-exe.js` (новый) | Реальный `.exe` за npm-шимом (`claude.cmd`, `opencode.cmd`) |
| `bridge/tools/probe-claude-permission.js` (новый) | Живая проба: хук `PermissionRequest` в Claude Code 2.1.284 |
| `bridge/agents/index.js` (новый) | Контракт адаптера (JSDoc), реестр, `normalizeOptions` |
| `bridge/agents/generic.js` (новый) | Адаптер «только зеркало» из конфига (D-3) |
| `bridge/agents/claude.js` (новый) | Адаптер Claude Code: `claude.exe`, опции, события хуков, ответы клавишами |
| `bridge/agents/opencode-client.js` (новый) | Клиент фонового сервиса opencode v2: `service.json`, Basic, API, SSE + ресинхронизация |
| `bridge/agents/opencode.js` (новый) | Адаптер opencode: сессия через API, TUI `--server/--session`, события SSE, ответы через API |
| `bridge/lib/session-events.js` (новый) | Применение событий адаптера к сессии: статус, ожидающие запросы, `notify` |
| `bridge/lib/confirmations.js` (новый) | D-13: ожидающие подтверждения операций владельца |
| `bridge/server.js` | Реестр агентов, `create {agent, options}`, `sessions.agents`, `/hook` → адаптер, `reply`, закрытие запросов, `createConflict`, подтверждения D-13 |
| `bridge/attach.js` | `--agent <id>`, конфликт resume от моста, подтверждения D-13, QR без ручного кода |
| `bridge/config.example.json` | `defaultAgent` + `agents` вместо `claudeCommand`/`claudeArgs` |
| `bridge/tools/hook-settings.js` (новый) | Фрагмент `settings.json` с хуком моста (exec-форма) — для проверки и установщика |
| `bridge/tools/ws-watch.js` (новый) | Отладочный клиент владельца: печать `notify`, ответ на запрос с клавиатуры |
| `bridge/test/helpers/bridge.js` (новый) | Стенд интеграционных тестов: мост в изолированном каталоге, клиенты, ожидания |
| `bridge/test/helpers/fake-opencode.js` (новый) | Фейковый сервис opencode v2 (HTTP + SSE) |
| `bridge/test/fixtures/fake-agent.js` (новый) | Фейковый TUI-агент: печатает argv/env, эхо ввода |
| `bridge/test/*.test.js` (новые) | Юнит- и интеграционные тесты задач |

---

### Task 1: `agent-exe.js` — реальный `.exe` за npm-шимом

**Files:**
- Create: `bridge/lib/agent-exe.js`
- Test: `bridge/test/agent-exe.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { npmShimExe } = require('../lib/agent-exe');
const { findOnPath } = require('../lib/which');

const REL = ['node_modules', '@x', 'tool', 'bin', 'tool.exe'];

test('exe next to the shim is found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-'));
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off');
  fs.mkdirSync(path.join(dir, ...REL.slice(0, -1)), { recursive: true });
  fs.writeFileSync(path.join(dir, ...REL), 'MZ');
  const find = (n) => (n === 'tool.cmd' ? path.join(dir, 'tool.cmd') : null);
  assert.strictEqual(npmShimExe('tool', REL, find), path.join(dir, ...REL));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('null when shim or exe is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-'));
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off');
  assert.strictEqual(npmShimExe('tool', REL, () => null), null);
  assert.strictEqual(npmShimExe('tool', REL, () => path.join(dir, 'tool.cmd')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real claude.exe on this machine', { skip: !findOnPath('claude.cmd') && 'claude не установлен' }, () => {
  const exe = npmShimExe('claude', ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
  assert.match(exe, /claude\.exe$/i);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/agent-exe.test.js`
Expected: FAIL — `Cannot find module '../lib/agent-exe'`.

- [ ] **Step 3: Реализация** — `bridge/lib/agent-exe.js`:

```js
'use strict';
// Реальный .exe за npm-шимом (claude.cmd, opencode.cmd). Адаптеры запускают .exe
// напрямую: шим через cmd.exe добавляет лишний процесс и ломает кавычки в node-pty
// (живые пробы Claude Code 2.1.284 и opencode v2.1.4, поправка подплана 1 к задаче 7).
const fs = require('fs');
const path = require('path');
const { findOnPath } = require('./which');

/** <каталог shim.cmd>\<relParts…>, если такой файл есть; иначе null. */
function npmShimExe(shim, relParts, find = findOnPath) {
  const cmd = find(shim + '.cmd');
  if (!cmd) return null;
  const exe = path.join(path.dirname(cmd), ...relParts);
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

module.exports = { npmShimExe };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/agent-exe.test.js`
Expected: `# pass 3` (на машине без Claude Code — `# pass 2`, `# skipped 1`).

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/agent-exe.js bridge/test/agent-exe.test.js
git commit -m "feat(bridge): resolve real exe behind npm shims"
```

---

### Task 2: Живая проба — хук `PermissionRequest` в Claude Code 2.1.284

Цель — до написания адаптера `claude` узнать: (а) приходит ли хук `PermissionRequest` и насколько раньше `Notification` (~7–8 с по прошлой пробе); (б) задерживает ли он показ диалога; (в) приходит ли что-нибудь (`PermissionDenied`) после отказа `Esc`; (г) состав полей. Адаптер в задаче 4 написан так, что работает при любом исходе (запрос открывается по тому, что пришло первым), — проба нужна для фактов, регистрации событий в установщике (подплан 4) и проверки допущений теста задачи 4. Тратит один короткий запрос к модели `haiku` (разрешено пользователем).

**Files:**
- Create: `bridge/tools/probe-claude-permission.js`

- [ ] **Step 1: Скрипт пробы** — `bridge/tools/probe-claude-permission.js`:

```js
#!/usr/bin/env node
'use strict';
// Живая проба (подплан 2, задача 2): когда приходит хук PermissionRequest относительно
// диалога разрешения, приходит ли Notification [permission_prompt], что приходит после Esc.
// Запускает claude.exe в ConPTY во временном каталоге с хуками через --settings
// (только для пробы; в работе хуки ставит установщик в settings.json — P-6).
// Тратит один короткий запрос к модели haiku. Запуск: cd bridge && node tools/probe-claude-permission.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const { npmShimExe } = require('../lib/agent-exe');

const exe = npmShimExe('claude', ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
if (!exe) { console.error('claude.exe не найден рядом с claude.cmd'); process.exit(1); }

const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-probe-')));
const log = path.join(dir, 'hooks.jsonl');
const logger = path.join(dir, 'logger.js');
fs.writeFileSync(logger,
  "const fs=require('fs');let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{" +
  "let p={};try{p=JSON.parse(b)}catch{}" +
  `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({t:Date.now(),e:p.hook_event_name,` +
  "nt:p.notification_type||null,tool:p.tool_name||null,agent:p.agent_id||null,msg:p.message||null," +
  "keys:Object.keys(p)})+'\\n');});");

const entry = [{ type: 'command', command: process.execPath, args: [logger] }];
const withMatcher = [{ matcher: '*', hooks: entry }];
const plain = [{ hooks: entry }];
const settingsFile = path.join(dir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({
  hooks: {
    PreToolUse: withMatcher, PostToolUse: withMatcher, PostToolUseFailure: withMatcher,
    PermissionRequest: withMatcher, PermissionDenied: withMatcher,
    Notification: plain, UserPromptSubmit: plain, Stop: plain,
  },
}, null, 2));

// окружение без следов моста и родительского Claude Code
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (k.startsWith('CLAUDE_BRIDGE_') || k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
}

const t0 = Date.now();
const marks = [];
const sec = (t) => ((t - t0) / 1000).toFixed(1) + 's';
function mark(what) { marks.push({ t: Date.now(), what }); console.log(`[${sec(Date.now())}] ${what}`); }
const strip = (s) => s
  .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b[@-_]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const term = pty.spawn(exe, ['--model', 'haiku', '--settings', settingsFile], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: dir, env,
});
let screen = '';
term.onData((d) => { screen += strip(d); if (screen.length > 200000) screen = screen.slice(-100000); });
async function waitScreen(re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(screen)) return true; await sleep(200); }
  return false;
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try { term.kill(); } catch { /* уже завершён */ }
  const events = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  console.log('\n=== Хуки (время от старта) ===');
  for (const e of events) {
    console.log(`${sec(e.t)}  ${e.e}${e.nt ? ' [' + e.nt + ']' : ''}${e.tool ? ' tool=' + e.tool : ''}` +
      `${e.agent ? ' agent_id' : ''}${e.msg ? ' msg=' + JSON.stringify(e.msg) : ''}  keys=${e.keys.join(',')}`);
  }
  console.log('\n=== Отметки ===');
  for (const m of marks) console.log(`${sec(m.t)}  ${m.what}`);
  console.log(`\nКаталог пробы: ${dir}`);
  setTimeout(() => process.exit(0), 500);
}
setTimeout(finish, 180000).unref();

(async () => {
  if (await waitScreen(/trust/i, 15000)) { mark('диалог доверия каталогу — Enter'); screen = ''; term.write('\r'); }
  await sleep(4000);
  mark('отправляю запрос');
  screen = '';
  term.write('Run this exact shell command with the Bash tool and nothing else: echo cb-probe');
  await sleep(300);
  term.write('\r');
  if (!(await waitScreen(/Do you want/i, 90000))) { mark('диалог разрешения не появился за 90 с'); finish(); return; }
  mark('диалог разрешения на экране');
  await sleep(12000); // ждём Notification [permission_prompt] (~7–8 с по прошлой пробе)
  mark('нажимаю Esc (отказ)');
  term.write('\x1b');
  await sleep(6000);
  finish();
})();
```

- [ ] **Step 2: Запустить пробу**

Run: `cd bridge && node tools/probe-claude-permission.js`
Expected (формат): строки `[N.Ns] …` с отметками, затем таблица хуков, например:

```
=== Хуки (время от старта) ===
6.2s  UserPromptSubmit  keys=session_id,transcript_path,cwd,permission_mode,hook_event_name,prompt
9.8s  PreToolUse tool=Bash  keys=…,tool_name,tool_input,tool_use_id
9.9s  PermissionRequest tool=Bash  keys=…,tool_name,tool_input,permission_suggestions
17.6s Notification [permission_prompt] msg="Claude needs your permission to use Bash"  keys=…
```

Если диалог не появился (`диалог разрешения не появился`) — посмотреть экран: запустить `claude --model haiku` вручную в каталоге из последней строки и повторить; возможные причины — первая настройка/логин Claude Code или иной текст диалога (тогда поправить регулярное выражение `/Do you want/i` и перезапустить).

- [ ] **Step 3: Зафиксировать факты**

Сверить вывод с допущениями задачи 4 и записать результат в отчёт по задаче (для контроллера):

| Вопрос | Как читать вывод |
|---|---|
| Приходит ли `PermissionRequest` | есть строка `PermissionRequest tool=Bash` |
| Опережает ли диалог | время `PermissionRequest` ≤ отметки «диалог разрешения на экране» |
| Поля | `keys=` содержит `tool_name`, `tool_input` (задача 4 строит текст уведомления из них) |
| `Notification` | есть ли `[permission_prompt]` и через сколько секунд после диалога |
| После `Esc` | есть ли `PermissionDenied`/`PostToolUse`/`Stop` после отметки «нажимаю Esc» |

Если `PermissionRequest` не пришёл — код задачи 4 не меняется (источник запроса — `Notification`, встроенный запасной путь); в отчёте отметить «PermissionRequest в 2.1.284 не срабатывает — уведомление с задержкой ~8 с». Если поля отличаются от `tool_name`/`tool_input` — поправить `describeTool` и соответствующий тест в задаче 4. Факт пробы добавить строкой в таблицу «Живая проба Claude Code 2.1.284» реестра решений (фиксация факта, не решения).

- [ ] **Step 4: Commit**

```bash
git add bridge/tools/probe-claude-permission.js
git commit -m "chore(bridge): live probe for Claude Code PermissionRequest hook"
```

---

### Task 3: Реестр агентов и адаптер `generic` (D-3, P-2, D-10)

**Files:**
- Create: `bridge/agents/index.js`, `bridge/agents/generic.js`
- Test: `bridge/test/agents-registry.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadAgents, normalizeOptions } = require('../agents');
const generic = require('../agents/generic');

const quiet = { log: () => {} };

test('generic agents from config; unavailable and invalid are skipped', () => {
  const reg = loadAgents({ agents: {
    echo: { type: 'generic', name: 'Echo', command: process.execPath, args: ['-v'], scroll: 'wheel' },
    plain: { command: process.execPath },
    missing: { type: 'generic', command: 'definitely-not-a-command-cb' },
    'Bad Id': { command: process.execPath },
    weird: { type: 'nosuchtype', command: process.execPath },
    nocmd: { type: 'generic' },
  } }, quiet);
  assert.deepStrictEqual(reg.list().map((a) => a.id), ['echo', 'plain']);
  assert.strictEqual(reg.get('echo').scroll, 'wheel');
  assert.strictEqual(reg.get('plain').scroll, 'pageKeys');
  assert.strictEqual(reg.get('plain').name, 'plain');
  assert.strictEqual(reg.get('missing'), null);
  assert.strictEqual(reg.get(42), null);
  assert.strictEqual(reg.defaultId, 'echo');
});

test('defaultAgent from config when available, otherwise first', () => {
  const reg = loadAgents({ defaultAgent: 'b', agents: { a: { command: process.execPath }, b: { command: process.execPath } } }, quiet);
  assert.strictEqual(reg.defaultId, 'b');
  const reg2 = loadAgents({ defaultAgent: 'zzz', agents: { a: { command: process.execPath } } }, quiet);
  assert.strictEqual(reg2.defaultId, 'a');
});

test('list() exposes only public fields', () => {
  const reg = loadAgents({ agents: { echo: { command: process.execPath, name: 'Echo' } } }, quiet);
  assert.deepStrictEqual(reg.list(), [{ id: 'echo', name: 'Echo', options: [], scroll: 'pageKeys' }]);
});

test('generic: config args then owner raw args; no events, no replies', async () => {
  const a = generic.create('echo', { command: process.execPath, args: ['a', 5, 'b'] });
  assert.deepStrictEqual(await a.spawnSpec({ cwd: 'C:\\', title: 't', options: {}, rawArgs: ['--x'] }),
    { command: process.execPath, args: ['a', 'b', '--x'], env: {}, state: {} });
  assert.strictEqual(a.events, 'none');
  assert.deepStrictEqual(a.onHook({}, {}), []);
  assert.deepStrictEqual(a.onInput({}, 'x'), []);
  assert.deepStrictEqual(await a.reply({}, { requestId: 'r' }, 'once', { write() { throw new Error('no'); } }),
    { ok: false, events: [] });
  assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: ['--resume'] }), false);
  assert.throws(() => generic.create('x', {}), /command/);
});

test('normalizeOptions keeps only declared bool options, strictly true', () => {
  const fake = { options: [{ id: 'resume', type: 'bool' }, { id: 'skip', type: 'bool' }] };
  assert.deepStrictEqual(normalizeOptions(fake, { resume: true, skip: 'yes', other: true }), { resume: true, skip: false });
  assert.deepStrictEqual(normalizeOptions(fake, null), { resume: false, skip: false });
  assert.deepStrictEqual(normalizeOptions(fake, ['resume']), { resume: false, skip: false });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/agents-registry.test.js`
Expected: FAIL — `Cannot find module '../agents'`.

- [ ] **Step 3: Реализация** — `bridge/agents/index.js`:

```js
'use strict';
/**
 * Реестр адаптеров агентов (D-3, P-2, D-5). Контракт адаптера (финализация P-2):
 *
 * {
 *   id, name,
 *   options: [{ id, label, type: 'bool' }],   // диалог новой сессии; телефон шлёт только id (P-3)
 *   scroll: 'wheel' | 'pageKeys',            // D-10: чем клиент листает альтернативный экран
 *   events: 'hook' | 'sse' | 'none',
 *   available(): boolean,                    // исполняемый файл найден
 *   async spawnSpec({ cwd, title, options, rawArgs }) -> { command, args, env, state },
 *       // command/args — что keeper запустит в ConPTY; env — добавка к окружению keeper'а
 *       // (keeper наследует childEnv моста); state — сохраняется в meta сессии (переживает рестарт)
 *   isResumeLike({ options, rawArgs }): boolean,      // D-7: предупреждать о живой сессии в каталоге
 *   onHook(session, payload): Event[],               // events:'hook' — POST /hook этой сессии
 *   onInput(session, data): Event[],                 // ввод в PTY с любого клиента
 *   subscribe(session, emit): unsubscribe,           // events:'sse'; emit(Event[])
 *   async reply(session, request, decision, io) -> { ok, stale?, events: Event[] },
 *       // decision: 'once' | 'always' | 'reject'; io.write(data) — запись в PTY сессии
 * }
 * Event: { kind:'status', status:'working'|'waiting'|'idle' }
 *      | { kind:'request', requestId, message, choices:[{ id, label }] }
 *      | { kind:'requestClosed', requestId }
 *      | { kind:'notify', message, done?: true }      // done — «агент закончил ответ»
 * session (как его видит адаптер): { id, cwd, title, agentState, runtime }
 *   agentState — из spawnSpec().state, хранится в meta-файле; runtime — объект в памяти моста.
 * Отличия от наброска P-2: spawnSpec асинхронный (opencode создаёт сессию через API), без helpers
 * (D-12: сервис opencode общий), добавлены title/state, onInput, isResumeLike, Event.notify.done.
 */
const TYPES = { claude: './claude', opencode: './opencode', generic: './generic' };
const DEFAULT_AGENTS = { claude: {}, opencode: {} };
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

function loadAgents(config, opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const src = config && config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)
    ? config.agents : DEFAULT_AGENTS;
  const map = new Map();
  for (const [id, raw] of Object.entries(src)) {
    if (!ID_RE.test(id)) { log(`  Агент «${id}»: недопустимый id — пропущен`); continue; }
    const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const type = cfg.type || (id === 'claude' || id === 'opencode' ? id : 'generic');
    if (!TYPES[type]) { log(`  Агент «${id}»: неизвестный тип ${type} — пропущен`); continue; }
    let adapter;
    try {
      adapter = require(TYPES[type]).create(id, cfg, opts);
    } catch (e) {
      log(`  Агент «${id}»: ${e.message} — пропущен`);
      continue;
    }
    if (!adapter.available()) { log(`  Агент «${id}» недоступен: исполняемый файл не найден`); continue; }
    map.set(id, adapter);
  }
  const ids = [...map.keys()];
  const defaultId = config && typeof config.defaultAgent === 'string' && map.has(config.defaultAgent)
    ? config.defaultAgent : (ids[0] || null);
  return {
    defaultId,
    get: (id) => (typeof id === 'string' ? map.get(id) || null : null),
    list: () => [...map.values()].map((a) => ({ id: a.id, name: a.name, options: a.options, scroll: a.scroll })),
  };
}

/** P-3: из опций устройства остаются только объявленные адаптером, значение — строго true. */
function normalizeOptions(adapter, raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const o of adapter.options) out[o.id] = src[o.id] === true;
  return out;
}

module.exports = { loadAgents, normalizeOptions };
```

`bridge/agents/generic.js`:

```js
'use strict';
// D-3: универсальный адаптер «только зеркало» для любого TUI-агента из конфига.
// Источника событий нет: ни статусов, ни запросов разрешений, ни быстрых ответов.
const { findOnPath } = require('../lib/which');

function create(id, cfg) {
  const command = typeof cfg.command === 'string' && cfg.command ? cfg.command : null;
  if (!command) throw new Error('не задан command');
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string') : [];
  return {
    id,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name.slice(0, 40) : id,
    command,
    options: [],
    // D-10: по умолчанию PageUp/PageDown — системный ConPTY не пересылает включение мыши
    scroll: cfg.scroll === 'wheel' ? 'wheel' : 'pageKeys',
    events: 'none',
    available: () => !!findOnPath(command),
    async spawnSpec({ rawArgs }) {
      return { command, args: [...args, ...(rawArgs || [])], env: {}, state: {} };
    },
    isResumeLike: () => false,
    onHook: () => [],
    onInput: () => [],
    subscribe: () => () => {},
    async reply() { return { ok: false, events: [] }; },
  };
}

module.exports = { create };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/agents-registry.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add bridge/agents/index.js bridge/agents/generic.js bridge/test/agents-registry.test.js
git commit -m "feat(bridge): agent adapter contract, registry and generic adapter (D-3, P-2, D-10)"
```

---

### Task 4: Адаптер `claude` (D-3, D-4, D-10)

Факты — «Живая проба Claude Code 2.1.284» и задача 2: диалог — клавиши `1`/`2`/`Esc`; `Notification [permission_prompt]` приходит через ~7–8 с или не приходит; после отказа хуков нет; события с `agent_id` не меняют статус. Запрос открывается по `PermissionRequest` (если хук работает) или по `Notification [permission_prompt]` (запасной путь), закрывается по любому вводу в PTY (кроме отчётов фокуса и колеса), по `UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PermissionDenied`/`Stop` без `agent_id` и по ответу.

**Files:**
- Create: `bridge/agents/claude.js`
- Test: `bridge/test/agent-claude.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const claude = require('../agents/claude');

const mk = (cfg = {}) => claude.create('claude', { command: process.execPath, prefixArgs: ['fake.js'], ...cfg }, {});
const sess = () => ({ id: 's1-abcdef', cwd: 'C:\\', title: 't', agentState: {}, runtime: {} });
const kinds = (evs) => evs.map((e) => e.kind + (e.status ? ':' + e.status : ''));

test('declaration: options, wheel scroll, hook events, exe via shim', () => {
  const a = mk();
  assert.deepStrictEqual(a.options.map((o) => o.id), ['resume', 'skipPermissions']);
  assert.strictEqual(a.scroll, 'wheel');
  assert.strictEqual(a.events, 'hook');
  assert.strictEqual(a.available(), true);
  assert.strictEqual(claude.create('claude', {}, { findExe: () => 'C:\\x\\claude.exe' }).command, 'C:\\x\\claude.exe');
  assert.strictEqual(claude.create('claude', {}, { findExe: () => null }).available(), false);
});

test('spawnSpec: options -> flags, owner raw args appended', async () => {
  const a = mk();
  const spec = await a.spawnSpec({ cwd: 'C:\\', title: 't', options: { resume: true, skipPermissions: true }, rawArgs: ['--model', 'haiku'] });
  assert.deepStrictEqual(spec, {
    command: process.execPath,
    args: ['fake.js', '--resume', '--dangerously-skip-permissions', '--model', 'haiku'],
    env: {}, state: {},
  });
  assert.deepStrictEqual((await a.spawnSpec({ cwd: 'C:\\', title: 't', options: {}, rawArgs: [] })).args, ['fake.js']);
});

test('isResumeLike: option or raw flag', () => {
  const a = mk();
  assert.strictEqual(a.isResumeLike({ options: { resume: true }, rawArgs: [] }), true);
  for (const f of ['--resume', '-r', '--continue', '-c']) assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: [f] }), true, f);
  assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: ['--model'] }), false);
});

test('PermissionRequest opens a request with choices; duplicate Notification ignored', () => {
  const a = mk();
  const s = sess();
  const ev = a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.match(ev[0].requestId, /^req_[0-9a-f]{16}$/);
  assert.match(ev[0].message, /Bash: echo hi/);
  assert.deepStrictEqual(ev[0].choices, [{ id: 'once', label: 'Да' }, { id: 'always', label: 'Всегда' }, { id: 'reject', label: 'Нет' }]);
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }), []);
});

test('Notification permission_prompt is the fallback source; ignored right after a close', () => {
  const a = mk();
  const s = sess();
  const ev = a.onHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.match(ev[0].message, /permission to use Bash/);
  const closed = a.onInput(s, '1');
  assert.deepStrictEqual(kinds(closed), ['requestClosed', 'status:working']);
  // запоздавшее уведомление о уже закрытом диалоге не открывает новый запрос
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }), []);
});

test('other Notification -> info notify', () => {
  const a = mk();
  assert.deepStrictEqual(a.onHook(sess(), { hook_event_name: 'Notification', message: 'Claude is waiting for your input' }),
    [{ kind: 'notify', message: 'Claude is waiting for your input' }]);
});

test('onInput: focus and wheel reports do not close; keys do', () => {
  const a = mk();
  const s = sess();
  assert.deepStrictEqual(a.onInput(s, '1'), [], 'nothing open');
  a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepStrictEqual(a.onInput(s, '\x1b[I'), []);
  assert.deepStrictEqual(a.onInput(s, '\x1b[O\x1b[<64;10;5M\x1b[<65;10;5M'), []);
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b')), ['requestClosed', 'status:idle']);
  a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepStrictEqual(kinds(a.onInput(s, 'hello')), ['requestClosed', 'status:working']);
});

test('lifecycle hooks close the request; agent_id events are ignored', () => {
  const a = mk();
  const s = sess();
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    assert.deepStrictEqual(a.onHook(s, { hook_event_name: name, agent_id: 'sub1' }), [], name + ' with agent_id');
    assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: name })), ['requestClosed', 'status:working'], name);
  }
  a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: 'PermissionDenied' })), ['requestClosed']);
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Stop', agent_id: 'sub1' }), []);
  const stop = a.onHook(s, { hook_event_name: 'Stop' });
  assert.deepStrictEqual(kinds(stop), ['status:idle', 'notify']);
  assert.strictEqual(stop[1].done, true);
});

test('reply: decision -> key, stale request refused without writing', async () => {
  const a = mk();
  const s = sess();
  const writes = [];
  const io = { write: (d) => writes.push(d) };
  for (const [decision, key, status] of [['once', '1', 'working'], ['always', '2', 'working'], ['reject', '\x1b', 'idle']]) {
    const ev = a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    const r = await a.reply(s, { requestId: ev[0].requestId }, decision, io);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(kinds(r.events), ['requestClosed', 'status:' + status]);
    assert.strictEqual(writes.pop(), key);
  }
  const old = a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  a.onInput(s, 'x');
  const r = await a.reply(s, { requestId: old[0].requestId }, 'once', io);
  assert.deepStrictEqual(r, { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: old[0].requestId }] });
  assert.deepStrictEqual(writes, []);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/agent-claude.test.js`
Expected: FAIL — `Cannot find module '../agents/claude'`.

- [ ] **Step 3: Реализация** — `bridge/agents/claude.js`:

```js
'use strict';
// Адаптер Claude Code (D-3, P-2). Факты — «Живая проба Claude Code 2.1.284» в реестре
// решений и проба PermissionRequest (подплан 2, задача 2).
const crypto = require('crypto');
const { npmShimExe } = require('../lib/agent-exe');
const { findOnPath } = require('../lib/which');

const EXE_REL = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];
const OPTIONS = [
  { id: 'resume', label: 'Продолжить беседу (--resume)', type: 'bool' },
  { id: 'skipPermissions', label: 'Без запросов разрешений (--dangerously-skip-permissions)', type: 'bool' },
];
const RESUME_FLAGS = new Set(['--resume', '-r', '--continue', '-c']);
const CHOICES = [{ id: 'once', label: 'Да' }, { id: 'always', label: 'Всегда' }, { id: 'reject', label: 'Нет' }];
// диалог разрешения: 1 — да, 2 — всегда (текст зависит от команды), Esc — отказ; без Enter
const KEYS = { once: '1', always: '2', reject: '\x1b' };
// Notification [permission_prompt] опаздывает на ~7–8 с: пришедшее сразу после закрытия
// диалога относится к уже закрытому запросу
const LATE_NOTIFICATION_MS = 3000;
// Отчёты фокуса (CSI I/O — ConPTY включает ?1004h) и колесо/движение мыши в SGR —
// не ответ на диалог; нажатия кнопок мыши и любые клавиши — ответ
const PASSIVE_INPUT = /^(?:\x1b\[[IO]|\x1b\[<(?:3[2-5]|6[4-7]);\d+;\d+[Mm])+$/;

function clip(s, n = 300) {
  const t = String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function describeTool(p) {
  const name = typeof p.tool_name === 'string' && p.tool_name ? p.tool_name : 'инструмент';
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const detail = [ti.command, ti.file_path, ti.url, ti.pattern, ti.path].find((v) => typeof v === 'string' && v) || '';
  return clip(name + (detail ? ': ' + detail : ''));
}

function rt(session) {
  if (!session.runtime.claude) session.runtime.claude = { open: null, sawPermissionRequest: false, lastClosedAt: 0 };
  return session.runtime.claude;
}

function closeOpen(r) {
  if (!r.open) return [];
  const ev = [{ kind: 'requestClosed', requestId: r.open }];
  r.open = null;
  r.lastClosedAt = Date.now();
  return ev;
}

function openRequest(r, message) {
  const out = closeOpen(r); // прежний диалог на экране уже сменился новым
  r.open = 'req_' + crypto.randomBytes(8).toString('hex');
  out.push({ kind: 'request', requestId: r.open, message, choices: CHOICES.map((c) => ({ ...c })) });
  out.push({ kind: 'status', status: 'waiting' });
  return out;
}

function create(id, cfg, opts = {}) {
  const findExe = opts.findExe || (() => npmShimExe('claude', EXE_REL));
  const command = typeof cfg.command === 'string' && cfg.command ? cfg.command : findExe();
  const prefixArgs = Array.isArray(cfg.prefixArgs) ? cfg.prefixArgs.filter((a) => typeof a === 'string') : [];
  return {
    id,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name.slice(0, 40) : 'Claude Code',
    command,
    options: OPTIONS,
    scroll: 'wheel',
    events: 'hook',
    available: () => !!command && !!findOnPath(command),

    async spawnSpec({ options, rawArgs }) {
      const args = [...prefixArgs];
      if (options.resume) args.push('--resume');
      if (options.skipPermissions) args.push('--dangerously-skip-permissions');
      return { command, args: [...args, ...(rawArgs || [])], env: {}, state: {} };
    },

    isResumeLike({ options, rawArgs }) {
      return options.resume === true || (rawArgs || []).some((a) => RESUME_FLAGS.has(a));
    },

    onHook(session, p) {
      if (!p || typeof p !== 'object') return [];
      const r = rt(session);
      const sub = typeof p.agent_id === 'string' && p.agent_id !== '';
      switch (p.hook_event_name) {
        case 'PermissionRequest':
          // диалог показывается и для субагента — запрос открываем независимо от agent_id
          r.sawPermissionRequest = true;
          return openRequest(r, 'Claude просит разрешение — ' + describeTool(p));
        case 'Notification': {
          const msg = typeof p.message === 'string' && p.message ? clip(p.message) : '';
          if (p.notification_type === 'permission_prompt') {
            if (r.sawPermissionRequest || r.open || Date.now() - r.lastClosedAt < LATE_NOTIFICATION_MS) return [];
            return openRequest(r, msg || 'Claude просит разрешение');
          }
          return [{ kind: 'notify', message: msg || 'Claude Code ждёт ввода' }];
        }
        case 'UserPromptSubmit':
        case 'PreToolUse':
        case 'PostToolUse':
        case 'PostToolUseFailure':
          if (sub) return [];
          return [...closeOpen(r), { kind: 'status', status: 'working' }];
        case 'PermissionDenied':
          if (sub) return [];
          return closeOpen(r);
        case 'Stop':
          if (sub) return [];
          return [...closeOpen(r), { kind: 'status', status: 'idle' },
            { kind: 'notify', message: 'Claude завершил ответ', done: true }];
        default:
          return [];
      }
    },

    onInput(session, data) {
      const r = rt(session);
      if (!r.open || typeof data !== 'string' || data === '' || PASSIVE_INPUT.test(data)) return [];
      const rejectish = data === '\x1b' || data === '4';
      return [...closeOpen(r), { kind: 'status', status: rejectish ? 'idle' : 'working' }];
    },

    async reply(session, request, decision, io) {
      const r = rt(session);
      if (r.open !== request.requestId || !KEYS[decision]) {
        return { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: request.requestId }] };
      }
      io.write(KEYS[decision]);
      return { ok: true, events: [...closeOpen(r), { kind: 'status', status: decision === 'reject' ? 'idle' : 'working' }] };
    },
  };
}

module.exports = { create };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/agent-claude.test.js`
Expected: `# pass 9`.

- [ ] **Step 5: Commit**

```bash
git add bridge/agents/claude.js bridge/test/agent-claude.test.js
git commit -m "feat(bridge): Claude Code adapter: claude.exe, hook events, key replies (D-3, D-4)"
```

---

### Task 5: Клиент сервиса opencode — обнаружение и HTTP (D-12)

**Files:**
- Create: `bridge/agents/opencode-client.js`
- Create: `bridge/test/helpers/fake-opencode.js`
- Test: `bridge/test/opencode-client.test.js`

- [ ] **Step 1: Фейковый сервис** — `bridge/test/helpers/fake-opencode.js` (не тест: глоб `test/*.test.js` его не запускает):

```js
'use strict';
// Фейковый фоновый сервис opencode v2 для тестов — без реального opencode и токенов модели.
// Повторяет факты живой пробы v2.1.4: Basic opencode:<pw>, /api/info, POST /api/session -> data.id,
// SSE /api/event со строками только `data:`, список/ответ разрешений, 204 и 404.
const fs = require('fs');
const path = require('path');
const http = require('http');

function startFakeOpencode({ password = 'test-pw' } = {}) {
  const state = { sessions: [], replies: [], perms: new Map(), sse: new Set(), unauthorized: 0 };
  const expected = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');

  function emit(evt) {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const r of state.sse) r.write(line);
  }
  function addSilently(sessionID, perm) {
    const p = { sessionID, action: 'shell', resources: [], save: [], ...perm };
    const list = state.perms.get(sessionID) || [];
    list.push(p);
    state.perms.set(sessionID, list);
    return p;
  }
  function ask(sessionID, perm) {
    const p = addSilently(sessionID, perm);
    emit({ type: 'permission.asked', data: p });
    return p;
  }
  function dropSse() {
    for (const r of state.sse) { try { r.destroy(); } catch { /* закрыт */ } }
    state.sse.clear();
  }

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) { state.unauthorized++; res.writeHead(401); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let m;
      if (req.method === 'GET' && u.pathname === '/api/info') return json(200, { data: { pid: process.pid, version: 'fake' } });
      if (req.method === 'POST' && u.pathname === '/api/session') {
        const id = 'ses_fake' + (state.sessions.length + 1);
        state.sessions.push({ id, body: JSON.parse(body || '{}') });
        return json(200, { data: { id } });
      }
      if (req.method === 'GET' && u.pathname === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': connected\n\n');
        state.sse.add(res);
        res.on('close', () => state.sse.delete(res));
        return undefined;
      }
      if (req.method === 'GET' && (m = u.pathname.match(/^\/api\/session\/([^/]+)\/permission$/))) {
        return json(200, { data: state.perms.get(m[1]) || [] });
      }
      if (req.method === 'POST' && (m = u.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/))) {
        const list = state.perms.get(m[1]) || [];
        const i = list.findIndex((p) => p.id === m[2]);
        if (i < 0) return json(404, { name: 'PermissionNotFoundError' });
        list.splice(i, 1);
        const decision = JSON.parse(body || '{}').decision;
        state.replies.push({ sessionID: m[1], requestID: m[2], decision });
        res.writeHead(204);
        res.end();
        emit({ type: 'permission.replied', data: { sessionID: m[1], requestID: m[2], reply: decision } });
        return undefined;
      }
      return json(404, { name: 'NotFound' });
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url, password, state, emit, ask, addSilently, dropSse,
      writeServiceFile(dir, overrides = {}) {
        const file = path.join(dir, 'opencode', 'service.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ url, password, pid: process.pid, version: 'fake', ...overrides }));
        return file;
      },
      close() {
        dropSse();
        return new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
      },
    });
  }));
}

module.exports = { startFakeOpencode };
```

- [ ] **Step 2: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpencodeClient, serviceFilePath, readServiceFile } = require('../agents/opencode-client');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cb-oc-'));

test('service.json location: XDG_STATE_HOME, else USERPROFILE\\.local\\state', () => {
  assert.strictEqual(serviceFilePath({ XDG_STATE_HOME: 'D:\\st', USERPROFILE: 'C:\\U' }), path.join('D:\\st', 'opencode', 'service.json'));
  assert.strictEqual(serviceFilePath({ USERPROFILE: 'C:\\U' }), path.join('C:\\U', '.local', 'state', 'opencode', 'service.json'));
});

test('readServiceFile: only loopback urls with a password', () => {
  const dir = tmp();
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:4096/', password: 'p', pid: 1, version: 'v' }));
  assert.deepStrictEqual(readServiceFile(f), { url: 'http://127.0.0.1:4096', password: 'p', pid: 1, version: 'v' });
  fs.writeFileSync(f, JSON.stringify({ url: 'http://10.0.0.5:4096', password: 'p' }));
  assert.strictEqual(readServiceFile(f), null);
  fs.writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:4096' }));
  assert.strictEqual(readServiceFile(f), null);
  fs.writeFileSync(f, 'garbage');
  assert.strictEqual(readServiceFile(f), null);
  assert.strictEqual(readServiceFile(path.join(dir, 'missing.json')), null);
});

test('alive: Basic auth checked via /api/info', async () => {
  const fake = await startFakeOpencode();
  const dir = tmp();
  const ok = new OpencodeClient({ file: fake.writeServiceFile(dir) });
  assert.strictEqual(await ok.alive(), true);
  const bad = new OpencodeClient({ file: fake.writeServiceFile(tmp(), { password: 'wrong' }) });
  assert.strictEqual(await bad.alive(), false);
  assert.strictEqual(await new OpencodeClient({ file: path.join(dir, 'none.json') }).alive(), false);
  await fake.close();
});

test('ensure: starts the service when service.json is missing and waits for it', async () => {
  const fake = await startFakeOpencode();
  const dir = tmp();
  let started = 0;
  const c = new OpencodeClient({
    file: path.join(dir, 'opencode', 'service.json'),
    start: () => { started++; setTimeout(() => fake.writeServiceFile(dir), 120); },
  });
  const info = await c.ensure({ attempts: 20, delayMs: 50 });
  assert.strictEqual(info.url, fake.url);
  assert.strictEqual(started, 1);
  const never = new OpencodeClient({ file: path.join(tmp(), 'none.json'), start: () => {} });
  await assert.rejects(never.ensure({ attempts: 2, delayMs: 10 }), /не отвечает/);
  await fake.close();
});

test('createSession, listPermissions, replyPermission (204 / 404)', async () => {
  const fake = await startFakeOpencode();
  const c = new OpencodeClient({ file: fake.writeServiceFile(tmp()) });
  const id = await c.createSession({ title: 'T', directory: 'C:\\w', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  assert.strictEqual(id, 'ses_fake1');
  assert.deepStrictEqual(fake.state.sessions[0].body,
    { title: 'T', location: { directory: 'C:\\w' }, permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  await c.createSession({ title: 'U', directory: 'C:\\w' });
  assert.strictEqual('permissions' in fake.state.sessions[1].body, false);
  fake.addSilently('ses_fake1', { id: 'per_1' });
  assert.deepStrictEqual((await c.listPermissions('ses_fake1')).map((p) => p.id), ['per_1']);
  assert.strictEqual(await c.replyPermission('ses_fake1', 'per_1', 'once'), 'ok');
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_fake1', requestID: 'per_1', decision: 'once' }]);
  assert.strictEqual(await c.replyPermission('ses_fake1', 'per_1', 'once'), 'stale');
  await fake.close();
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `cd bridge && node --test test/opencode-client.test.js`
Expected: FAIL — `Cannot find module '../agents/opencode-client'`.

- [ ] **Step 4: Реализация** — `bridge/agents/opencode-client.js`:

```js
'use strict';
// Клиент фонового сервиса opencode v2 (D-12). Факты — «Живая проба opencode v2.1.4»
// в реестре решений: service.json (url/password/pid/version), Basic opencode:<password>,
// живость — GET /api/info, API под /api.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,128}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serviceFilePath(env = process.env) {
  const base = env.XDG_STATE_HOME || path.join(env.USERPROFILE || os.homedir(), '.local', 'state');
  return path.join(base, 'opencode', 'service.json');
}

/** service.json -> { url, password, pid, version } | null. Пароль не отправляется за пределы loopback. */
function readServiceFile(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!j || typeof j.url !== 'string' || typeof j.password !== 'string' || !j.password) return null;
  let u;
  try { u = new URL(j.url); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname)) return null;
  return { url: j.url.replace(/\/+$/, ''), password: j.password, pid: j.pid, version: j.version };
}

function authHeader(password) {
  return 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
}

class OpencodeClient {
  /** start() — запустить сервис (`opencode service start`), если он не отвечает. */
  constructor({ file = serviceFilePath(), start = null, timeoutMs = 5000 } = {}) {
    this.file = file;
    this.start = start;
    this.timeoutMs = timeoutMs;
    this.subs = new Map();
    this.sse = null;
    this.sseOpen = false;
    this.backoff = 500;
    this.reconnectTimer = null;
    this.closed = false;
  }

  info() { return readServiceFile(this.file); }

  request(method, pathname, body, info = this.info()) {
    return new Promise((resolve, reject) => {
      if (!info) { reject(new Error('сервис opencode не найден (service.json)')); return; }
      const u = new URL(info.url + pathname);
      const mod = u.protocol === 'https:' ? https : http;
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = { Authorization: authHeader(info.password), Accept: 'application/json' };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      const req = mod.request(u, { method, agent: false, timeout: this.timeoutMs, headers }, (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { s += d; if (s.length > 4e6) req.destroy(new Error('opencode: слишком большой ответ')); });
        res.on('end', () => {
          let json = null;
          try { json = s ? JSON.parse(s) : null; } catch { /* не JSON */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('opencode: таймаут')));
      req.on('error', reject);
      req.end(data || undefined);
    });
  }

  async alive(info = this.info()) {
    if (!info) return false;
    try { return (await this.request('GET', '/api/info', null, info)).status === 200; } catch { return false; }
  }

  async ensure({ attempts = 40, delayMs = 500 } = {}) {
    if (await this.alive()) return this.info();
    if (typeof this.start === 'function') this.start();
    for (let i = 0; i < attempts; i++) {
      await sleep(delayMs);
      if (await this.alive()) return this.info();
    }
    throw new Error('сервис opencode не отвечает (opencode service start)');
  }

  async createSession({ title, directory, permissions }) {
    const body = { title, location: { directory } };
    if (permissions) body.permissions = permissions;
    const r = await this.request('POST', '/api/session', body);
    const id = r.json && r.json.data && r.json.data.id;
    if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || !SESSION_ID.test(id)) {
      throw new Error(`opencode: не удалось создать сессию (HTTP ${r.status})`);
    }
    return id;
  }

  async listPermissions(sid) {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sid)}/permission`);
    if (r.status !== 200) throw new Error(`opencode: список разрешений недоступен (HTTP ${r.status})`);
    const arr = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.data) ? r.json.data : []);
    return arr.filter((p) => p && typeof p.id === 'string');
  }

  /** 'ok' — принят (204), 'stale' — запроса уже нет (404 PermissionNotFoundError). */
  async replyPermission(sid, rid, decision) {
    const r = await this.request('POST',
      `/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(rid)}/reply`, { decision });
    if (r.status === 204 || r.status === 200) return 'ok';
    if (r.status === 404) return 'stale';
    throw new Error(`opencode: ответ на разрешение не принят (HTTP ${r.status})`);
  }
}

module.exports = { OpencodeClient, serviceFilePath, readServiceFile, authHeader };
```

- [ ] **Step 5: Тесты проходят**

Run: `cd bridge && node --test test/opencode-client.test.js`
Expected: `# pass 5`.

- [ ] **Step 6: Commit**

```bash
git add bridge/agents/opencode-client.js bridge/test/helpers/fake-opencode.js bridge/test/opencode-client.test.js
git commit -m "feat(bridge): opencode service client: discovery, auth, sessions, permission replies (D-12)"
```

---

### Task 6: Клиент opencode — SSE с переподключением и ресинхронизацией (D-12)

Факты пробы: поток `GET /api/event` общий для всех сессий, строк `event:` нет, тип — в `.type`, id сессии — в `.data.sessionID`, пропущенное при обрыве не досылается. Поэтому одно SSE-соединение на клиент, раздача по `sessionID`, после каждого (пере)подключения — синтетическое событие `bridge.resync` со свежим списком разрешений каждой подписанной сессии.

**Files:**
- Modify: `bridge/agents/opencode-client.js`
- Test: `bridge/test/opencode-sse.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpencodeClient, sseParser } = require('../agents/opencode-client');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error('условие не выполнено');
}

test('sseParser: split chunks, CRLF, comments, bad json', () => {
  const got = [];
  const feed = sseParser((e) => got.push(e.type));
  for (const ch of ['da', 'ta: {"type":"a","data":{}}\n', '\n', 'data: {"type":"b"}\r\n\r\n', 'data: not json\n\n', ': ping\n\n']) feed(ch);
  assert.deepStrictEqual(got, ['a', 'b']);
});

test('only own session events; resync on connect and after reconnect; unsubscribe closes', async () => {
  const fake = await startFakeOpencode();
  const c = new OpencodeClient({ file: fake.writeServiceFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sse-'))) });
  fake.addSilently('ses_a', { id: 'per_0' });
  const got = [];
  const un = c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'));
  assert.deepStrictEqual(got[0].data.permissions.map((p) => p.id), ['per_0']);

  fake.emit({ type: 'permission.asked', data: { id: 'per_x', sessionID: 'ses_b' } });
  fake.ask('ses_a', { id: 'per_1' });
  await waitUntil(() => got.some((e) => e.type === 'permission.asked'));
  assert.ok(!got.some((e) => e.data && e.data.id === 'per_x'), 'foreign session filtered');

  fake.addSilently('ses_a', { id: 'per_2' });
  got.length = 0;
  fake.dropSse();
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'), 5000);
  assert.deepStrictEqual(got.find((e) => e.type === 'bridge.resync').data.permissions.map((p) => p.id).sort(),
    ['per_0', 'per_1', 'per_2']);

  un();
  await waitUntil(() => fake.state.sse.size === 0);
  c.close();
  await fake.close();
});

test('second subscriber on an open stream gets its own resync', async () => {
  const fake = await startFakeOpencode();
  const c = new OpencodeClient({ file: fake.writeServiceFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sse-'))) });
  const a = [];
  const b = [];
  c.subscribe('ses_a', (e) => a.push(e));
  await waitUntil(() => a.some((e) => e.type === 'bridge.resync'));
  fake.addSilently('ses_b', { id: 'per_b' });
  c.subscribe('ses_b', (e) => b.push(e));
  await waitUntil(() => b.some((e) => e.type === 'bridge.resync'));
  assert.deepStrictEqual(b[0].data.permissions.map((p) => p.id), ['per_b']);
  assert.strictEqual(fake.state.sse.size, 1, 'one shared SSE connection');
  c.close();
  await fake.close();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/opencode-sse.test.js`
Expected: FAIL — `sseParser is not a function` / `c.subscribe is not a function`.

- [ ] **Step 3: Реализация**

В `bridge/agents/opencode-client.js` в класс `OpencodeClient` после метода `replyPermission` добавить:

```js
  /** Подписка на события одной сессии. handler(evt) получает события SSE с этим sessionID
   *  и синтетическое { type:'bridge.resync', data:{ sessionID, permissions } } после (пере)подключения. */
  subscribe(sid, handler) {
    this.closed = false;
    this.subs.set(sid, handler);
    if (this.sseOpen) this._resync([sid]);
    else this._ensureSse();
    return () => {
      if (this.subs.get(sid) === handler) this.subs.delete(sid);
      if (!this.subs.size) this._closeSse();
    };
  }

  close() {
    this.closed = true;
    this.subs.clear();
    this._closeSse();
  }

  _ensureSse() {
    if (this.closed || this.sse || this.reconnectTimer || !this.subs.size) return;
    const info = this.info();
    if (!info) { this._scheduleReconnect(); return; }
    const u = new URL(info.url + '/api/event');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', agent: false,
      headers: { Authorization: authHeader(info.password), Accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); this._dropSse(req); return; }
      this.sseOpen = true;
      this.backoff = 500;
      this._resync([...this.subs.keys()]);
      res.setEncoding('utf8');
      res.on('data', sseParser((evt) => this._dispatch(evt)));
      // обрыв со стороны сервиса: в зависимости от версии Node — end, error(aborted) или только close;
      // _dropSse идемпотентен
      res.on('end', () => this._dropSse(req));
      res.on('error', () => this._dropSse(req));
      res.on('close', () => this._dropSse(req));
    });
    req.on('error', () => this._dropSse(req));
    this.sse = req;
    req.end();
  }

  _dropSse(req) {
    if (this.sse !== req) return;
    this.sse = null;
    this.sseOpen = false;
    try { req.destroy(); } catch { /* уже закрыт */ }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer || !this.subs.size) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._ensureSse(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10000);
  }

  _closeSse() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const req = this.sse;
    this.sse = null;
    this.sseOpen = false;
    if (req) { try { req.destroy(); } catch { /* уже закрыт */ } }
  }

  _dispatch(evt) {
    if (!evt || typeof evt.type !== 'string' || !evt.data || typeof evt.data !== 'object') return;
    const handler = typeof evt.data.sessionID === 'string' ? this.subs.get(evt.data.sessionID) : null;
    if (!handler) return;
    try { handler(evt); } catch (e) { console.error('[opencode] обработчик события:', e.message); }
  }

  _resync(sids) {
    for (const sid of sids) {
      this.listPermissions(sid).then((permissions) => {
        const handler = this.subs.get(sid);
        if (handler) handler({ type: 'bridge.resync', data: { sessionID: sid, permissions } });
      }).catch((e) => console.error('[opencode] ресинхронизация:', e.message));
    }
  }
```

Перед `module.exports` добавить парсер и заменить экспорт:

```js
/** Парсер text/event-stream: накапливает строки `data:` до пустой строки, отдаёт JSON. */
function sseParser(onEvent) {
  let buf = '';
  let data = [];
  return (chunk) => {
    buf += chunk;
    if (buf.length > 8e6) { buf = ''; data = []; return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (!data.length) continue;
        const text = data.join('\n');
        data = [];
        let evt;
        try { evt = JSON.parse(text); } catch { continue; }
        onEvent(evt);
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };
}

module.exports = { OpencodeClient, serviceFilePath, readServiceFile, authHeader, sseParser };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/opencode-sse.test.js test/opencode-client.test.js`
Expected: `# pass 8`.

- [ ] **Step 5: Commit**

```bash
git add bridge/agents/opencode-client.js bridge/test/opencode-sse.test.js
git commit -m "feat(bridge): opencode SSE with reconnect and permission resync (D-12)"
```

---

### Task 7: Адаптер `opencode` (D-2/D-12, D-4, D-14)

**Files:**
- Create: `bridge/agents/opencode.js`
- Test: `bridge/test/agent-opencode.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const oc = require('../agents/opencode');
const { OpencodeClient } = require('../agents/opencode-client');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error('условие не выполнено');
}
async function setup() {
  const fake = await startFakeOpencode();
  const client = new OpencodeClient({ file: fake.writeServiceFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-oca-'))) });
  const a = oc.create('opencode', { command: process.execPath, prefixArgs: ['fake-tui.js'] }, { opencodeClient: client });
  return { fake, client, a };
}

test('declaration: askShell option, wheel scroll, sse events', async () => {
  const { fake, a } = await setup();
  assert.deepStrictEqual(a.options, [{ id: 'askShell', label: 'Спрашивать разрешение на команды', type: 'bool' }]);
  assert.strictEqual(a.scroll, 'wheel');
  assert.strictEqual(a.events, 'sse');
  assert.strictEqual(a.available(), true);
  assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: [] }), false);
  await fake.close();
});

test('spawnSpec: API session (D-14 permissions only with askShell), TUI args, password env', async () => {
  const { fake, a } = await setup();
  const spec = await a.spawnSpec({ cwd: 'C:\\w', title: 'T', options: { askShell: true }, rawArgs: [] });
  assert.deepStrictEqual(fake.state.sessions[0].body,
    { title: 'T', location: { directory: 'C:\\w' }, permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  assert.deepStrictEqual(spec, {
    command: process.execPath,
    args: ['fake-tui.js', '--server', fake.url, '--session', 'ses_fake1'],
    env: { OPENCODE_PASSWORD: fake.password },
    state: { opencodeSessionId: 'ses_fake1' },
  });
  await a.spawnSpec({ cwd: 'C:\\w', title: 'T2', options: { askShell: false }, rawArgs: [] });
  assert.strictEqual('permissions' in fake.state.sessions[1].body, false);
  await fake.close();
});

test('events: asked -> request, replied -> closed, execution -> status, resync opens and closes', async () => {
  const { fake, client, a } = await setup();
  const session = { id: 's1-aaaaaa', agentState: { opencodeSessionId: 'ses_fake1' }, runtime: {} };
  const ev = [];
  const un = a.subscribe(session, (e) => ev.push(...e));
  await waitUntil(() => fake.state.sse.size === 1);
  await sleep(100);

  fake.ask('ses_fake1', { id: 'per_1', action: 'shell', resources: ['echo hi'], save: ['echo *'] });
  await waitUntil(() => ev.some((e) => e.kind === 'request'));
  const req = ev.find((e) => e.kind === 'request');
  assert.strictEqual(req.requestId, 'per_1');
  assert.match(req.message, /shell: echo hi/);
  assert.deepStrictEqual(req.choices.map((c) => c.id), ['once', 'always', 'reject']);
  assert.ok(ev.some((e) => e.kind === 'status' && e.status === 'waiting'));

  const r = await a.reply(session, { requestId: 'per_1' }, 'once');
  assert.deepStrictEqual(r, { ok: true, events: [{ kind: 'requestClosed', requestId: 'per_1' }] });
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_fake1', requestID: 'per_1', decision: 'once' }]);
  await waitUntil(() => ev.some((e) => e.kind === 'requestClosed' && e.requestId === 'per_1'));
  const again = await a.reply(session, { requestId: 'per_1' }, 'once');
  assert.deepStrictEqual(again, { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: 'per_1' }] });

  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_fake1' } });
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_fake1' } });
  await waitUntil(() => ev.some((e) => e.kind === 'notify' && e.done));
  assert.ok(ev.some((e) => e.kind === 'status' && e.status === 'idle'));

  fake.addSilently('ses_fake1', { id: 'per_2', action: 'edit', resources: ['a.txt'], save: [] });
  fake.dropSse();
  await waitUntil(() => ev.some((e) => e.kind === 'request' && e.requestId === 'per_2'), 5000);
  assert.deepStrictEqual(ev.find((e) => e.kind === 'request' && e.requestId === 'per_2').choices.map((c) => c.id),
    ['once', 'reject'], 'empty save[] -> no "always"');

  fake.state.perms.set('ses_fake1', []);
  fake.dropSse();
  await waitUntil(() => ev.some((e) => e.kind === 'requestClosed' && e.requestId === 'per_2'), 5000);

  un();
  client.close();
  await fake.close();
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/agent-opencode.test.js`
Expected: FAIL — `Cannot find module '../agents/opencode'`.

- [ ] **Step 3: Реализация** — `bridge/agents/opencode.js`:

```js
'use strict';
// Адаптер opencode v2 (D-2, D-12, D-14). Сессия создаётся через API фонового сервиса,
// keeper запускает TUI `opencode.exe --server <url> --session <id>` с OPENCODE_PASSWORD
// в окружении (keeper наследует childEnv моста), события — SSE, ответы — через API.
const { spawn } = require('child_process');
const { npmShimExe } = require('../lib/agent-exe');
const { findOnPath } = require('../lib/which');
const { OpencodeClient } = require('./opencode-client');

const EXE_REL = ['node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'];
const OPTIONS = [{ id: 'askShell', label: 'Спрашивать разрешение на команды', type: 'bool' }];
const ASK_SHELL = [{ action: 'shell', resource: '*', effect: 'ask' }];
const DECISIONS = new Set(['once', 'always', 'reject']);

function clip(s, n = 300) {
  const t = String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function describe(p) {
  const action = typeof p.action === 'string' && p.action ? p.action : 'действие';
  const res = Array.isArray(p.resources) ? p.resources.filter((x) => typeof x === 'string') : [];
  return clip(`opencode просит разрешение — ${action}${res.length ? ': ' + res.join(', ') : ''}`);
}

function choicesFor(p) {
  const out = [{ id: 'once', label: 'Да' }];
  // «Всегда» сохраняет шаблоны save[]; без них сохранять нечего
  if (Array.isArray(p.save) && p.save.length) out.push({ id: 'always', label: 'Всегда' });
  out.push({ id: 'reject', label: 'Нет' });
  return out;
}

function create(id, cfg, opts = {}) {
  const findExe = opts.findExe || (() => npmShimExe('opencode', EXE_REL));
  const command = typeof cfg.command === 'string' && cfg.command ? cfg.command : findExe();
  const prefixArgs = Array.isArray(cfg.prefixArgs) ? cfg.prefixArgs.filter((a) => typeof a === 'string') : [];
  const client = opts.opencodeClient || new OpencodeClient({
    file: typeof cfg.serviceFile === 'string' && cfg.serviceFile ? cfg.serviceFile : undefined,
    start: () => {
      if (!command) return;
      spawn(command, [...prefixArgs, 'service', 'start'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    },
  });

  return {
    id,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name.slice(0, 40) : 'opencode',
    command,
    client,
    options: OPTIONS,
    scroll: 'wheel',
    events: 'sse',
    available: () => !!command && !!findOnPath(command),

    async spawnSpec({ cwd, title, options }) {
      const info = await client.ensure();
      const sid = await client.createSession({
        title, directory: cwd, permissions: options.askShell ? ASK_SHELL : undefined,
      });
      return {
        command,
        args: [...prefixArgs, '--server', info.url, '--session', sid],
        env: { OPENCODE_PASSWORD: info.password },
        state: { opencodeSessionId: sid },
      };
    },

    isResumeLike: () => false,
    onHook: () => [],
    onInput: () => [],

    subscribe(session, emit) {
      const sid = session.agentState && session.agentState.opencodeSessionId;
      if (typeof sid !== 'string') return () => {};
      const known = new Set();
      const opened = (p) => {
        known.add(p.id);
        return [{ kind: 'request', requestId: p.id, message: describe(p), choices: choicesFor(p) },
          { kind: 'status', status: 'waiting' }];
      };
      const finished = (message) => [{ kind: 'status', status: 'idle' }, { kind: 'notify', message, done: true }];
      return client.subscribe(sid, (evt) => {
        const d = evt.data || {};
        switch (evt.type) {
          case 'permission.asked':
            if (typeof d.id === 'string' && !known.has(d.id)) emit(opened(d));
            break;
          case 'permission.replied':
            if (typeof d.requestID === 'string') {
              known.delete(d.requestID);
              const out = [{ kind: 'requestClosed', requestId: d.requestID }];
              if (!known.size) out.push({ kind: 'status', status: 'working' });
              emit(out);
            }
            break;
          case 'session.execution.started':
            emit([{ kind: 'status', status: 'working' }]);
            break;
          case 'session.execution.succeeded':
            emit(finished('opencode завершил ответ'));
            break;
          case 'session.execution.failed':
            emit(finished('opencode: выполнение завершилось с ошибкой'));
            break;
          case 'session.execution.interrupted':
            emit(finished('opencode: выполнение прервано'));
            break;
          case 'bridge.resync': {
            const now = new Set();
            const out = [];
            for (const p of d.permissions || []) {
              now.add(p.id);
              if (!known.has(p.id)) out.push(...opened(p));
            }
            for (const k of [...known]) {
              if (!now.has(k)) { known.delete(k); out.push({ kind: 'requestClosed', requestId: k }); }
            }
            if (out.length) emit(out);
            break;
          }
          default:
            break;
        }
      });
    },

    async reply(session, request, decision) {
      const sid = session.agentState && session.agentState.opencodeSessionId;
      if (!DECISIONS.has(decision) || typeof sid !== 'string') return { ok: false, events: [] };
      const r = await client.replyPermission(sid, request.requestId, decision);
      const closed = [{ kind: 'requestClosed', requestId: request.requestId }];
      return r === 'ok' ? { ok: true, events: closed } : { ok: false, stale: true, events: closed };
    },
  };
}

module.exports = { create };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/agent-opencode.test.js`
Expected: `# pass 3`.

- [ ] **Step 5: Commit**

```bash
git add bridge/agents/opencode.js bridge/test/agent-opencode.test.js
git commit -m "feat(bridge): opencode adapter: API session, TUI --server/--session, SSE events, API replies (D-12, D-14)"
```

---

### Task 8: Живой тест сервиса opencode (`CB_LIVE_OPENCODE=1`)

Проверяет допущения задач 5–7 на настоящем сервисе: формат `service.json`, `POST /api/session`, путь и формат `GET /api/session/{id}/permission`, рукопожатие SSE. Модель не вызывается (токены не тратятся). Без переменной окружения тест пропускается и в `npm test` не мешает.

**Files:**
- Create: `bridge/test/opencode.live.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { spawn } = require('child_process');
const { npmShimExe } = require('../lib/agent-exe');
const { OpencodeClient } = require('../agents/opencode-client');

const LIVE = process.env.CB_LIVE_OPENCODE === '1';

test('live opencode service: ensure, session, permission list, SSE', { skip: !LIVE && 'CB_LIVE_OPENCODE!=1', timeout: 90000 }, async () => {
  const exe = npmShimExe('opencode', ['node_modules', '@opencode', 'cli', 'bin', 'opencode.exe']);
  assert.ok(exe, 'opencode.exe найден рядом с opencode.cmd');
  const client = new OpencodeClient({
    start: () => spawn(exe, ['service', 'start'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(),
  });
  const info = await client.ensure();
  assert.match(info.url, /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/);
  const sid = await client.createSession({
    title: 'claude-bridge live test', directory: os.tmpdir(),
    permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
  });
  assert.match(sid, /^ses_/);
  assert.ok(Array.isArray(await client.listPermissions(sid)));
  const resync = await new Promise((resolve) => {
    const un = client.subscribe(sid, (e) => { if (e.type === 'bridge.resync') { un(); resolve(e); } });
    setTimeout(() => resolve(null), 15000);
  });
  assert.ok(resync, 'SSE 200 и ресинхронизация получены');
  client.close();
});
```

- [ ] **Step 2: Без переменной — пропуск**

Run: `cd bridge && node --test test/opencode.live.test.js`
Expected: `# skipped 1`, `# fail 0`.

- [ ] **Step 3: Живой прогон**

Run (PowerShell): `cd bridge; $env:CB_LIVE_OPENCODE='1'; node --test test/opencode.live.test.js; Remove-Item Env:CB_LIVE_OPENCODE`
Expected: `# pass 1`. При падении — записать фактический ответ сервиса (статус/тело) в отчёт и поправить разбор в `opencode-client.js` (`listPermissions`/`createSession`) и фейк `helpers/fake-opencode.js` так, чтобы фейк повторял реальность; затем перезапустить тесты задач 5–7. Тест оставляет в сервисе пустую сессию «claude-bridge live test» (API удаления сессии не проверялось).

- [ ] **Step 4: Commit**

```bash
git add bridge/test/opencode.live.test.js
git commit -m "test(bridge): optional live test against the real opencode service"
```

---

### Task 9: `session-events.js` — события адаптера → состояние сессии и WS (D-4)

**Files:**
- Create: `bridge/lib/session-events.js`
- Test: `bridge/test/session-events.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SE = require('../lib/session-events');

const mk = () => ({ id: 's1-abcdef', title: 'proj · Claude Code', status: 'idle', pending: new Map(), lastNotify: null });

test('status: broadcast only on change', () => {
  const s = mk();
  let r = SE.applyEvents(s, [{ kind: 'status', status: 'working' }, { kind: 'status', status: 'working' }, { kind: 'status', status: 'bogus' }], 1000);
  assert.deepStrictEqual(r.messages, [{ type: 'status', id: s.id, status: 'working' }]);
  assert.strictEqual(r.sessionsChanged, true);
  r = SE.applyEvents(s, [{ kind: 'status', status: 'working' }], 1000);
  assert.deepStrictEqual(r, { messages: [], sessionsChanged: false });
});

test('request: stored as pending, notify carries requestId and filtered choices', () => {
  const s = mk();
  const r = SE.applyEvents(s, [{ kind: 'request', requestId: 'req_1', message: 'm', choices: [
    { id: 'once', label: 'Да' }, { id: 'evil', label: 'x' }, { id: 'reject', label: 'Нет' }, null] }], 5);
  assert.deepStrictEqual(r.messages, [{ type: 'notify', id: s.id, event: 'request', requestId: 'req_1',
    choices: [{ id: 'once', label: 'Да' }, { id: 'reject', label: 'Нет' }], message: 'm', title: s.title, at: 5 }]);
  assert.deepStrictEqual(s.pending.get('req_1'), { requestId: 'req_1', message: 'm',
    choices: [{ id: 'once', label: 'Да' }, { id: 'reject', label: 'Нет' }], at: 5 });
  assert.deepStrictEqual(s.lastNotify, { event: 'request', message: 'm', at: 5 });
});

test('requestClosed: only known requests are broadcast', () => {
  const s = mk();
  SE.applyEvents(s, [{ kind: 'request', requestId: 'req_1', message: 'm', choices: [] }], 1);
  assert.deepStrictEqual(SE.applyEvents(s, [{ kind: 'requestClosed', requestId: 'req_x' }]).messages, []);
  assert.deepStrictEqual(SE.applyEvents(s, [{ kind: 'requestClosed', requestId: 'req_1' }]).messages,
    [{ type: 'requestClosed', id: s.id, requestId: 'req_1' }]);
  assert.strictEqual(s.pending.size, 0);
});

test('notify: done vs info', () => {
  const s = mk();
  const r = SE.applyEvents(s, [{ kind: 'notify', message: 'fin', done: true }, { kind: 'notify', message: 'hey' }], 7);
  assert.deepStrictEqual(r.messages.map((m) => [m.event, m.message]), [['done', 'fin'], ['info', 'hey']]);
});

test('closeAllRequests', () => {
  const s = mk();
  SE.applyEvents(s, [{ kind: 'request', requestId: 'a', message: '', choices: [] }, { kind: 'request', requestId: 'b', message: '', choices: [] }]);
  assert.deepStrictEqual(SE.closeAllRequests(s).map((m) => m.requestId), ['a', 'b']);
  assert.strictEqual(s.pending.size, 0);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/session-events.test.js`
Expected: FAIL — `Cannot find module '../lib/session-events'`.

- [ ] **Step 3: Реализация** — `bridge/lib/session-events.js`:

```js
'use strict';
// Применение событий адаптера (P-2) к сессии: статус, ожидающие запросы разрешений (D-4),
// уведомления. Чистая функция: возвращает WS-сообщения для рассылки всем клиентам.
const STATUSES = new Set(['working', 'waiting', 'idle']);
const DECISIONS = ['once', 'always', 'reject'];

function cleanChoices(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && DECISIONS.includes(c.id) && typeof c.label === 'string')
    .map((c) => ({ id: c.id, label: c.label.slice(0, 40) }));
}

function applyEvents(session, events, now = Date.now()) {
  if (!session.pending) session.pending = new Map();
  const messages = [];
  let sessionsChanged = false;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'status' && STATUSES.has(ev.status)) {
      if (session.status !== ev.status) {
        session.status = ev.status;
        messages.push({ type: 'status', id: session.id, status: ev.status });
        sessionsChanged = true;
      }
    } else if (ev.kind === 'request' && typeof ev.requestId === 'string' && ev.requestId && ev.requestId.length <= 128) {
      const message = String(ev.message || '').slice(0, 500);
      const choices = cleanChoices(ev.choices);
      session.pending.set(ev.requestId, { requestId: ev.requestId, message, choices, at: now });
      session.lastNotify = { event: 'request', message, at: now };
      messages.push({ type: 'notify', id: session.id, event: 'request', requestId: ev.requestId,
        choices, message, title: session.title, at: now });
      sessionsChanged = true;
    } else if (ev.kind === 'requestClosed' && typeof ev.requestId === 'string') {
      if (session.pending.delete(ev.requestId)) {
        messages.push({ type: 'requestClosed', id: session.id, requestId: ev.requestId });
      }
    } else if (ev.kind === 'notify') {
      const message = String(ev.message || '').slice(0, 500);
      const event = ev.done ? 'done' : 'info';
      session.lastNotify = { event, message, at: now };
      messages.push({ type: 'notify', id: session.id, event, message, title: session.title, at: now });
      sessionsChanged = true;
    }
  }
  return { messages, sessionsChanged };
}

function closeAllRequests(session) {
  const out = [];
  if (!session.pending) return out;
  for (const requestId of session.pending.keys()) out.push({ type: 'requestClosed', id: session.id, requestId });
  session.pending.clear();
  return out;
}

module.exports = { applyEvents, closeAllRequests, DECISIONS };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/session-events.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/session-events.js bridge/test/session-events.test.js
git commit -m "feat(bridge): apply adapter events to session state and WS messages (D-4)"
```

---

### Task 10: `server.js` — реестр агентов, `create {agent, options}`, `sessions.agents` (D-5, P-3, D-10)

**Files:**
- Create: `bridge/test/fixtures/fake-agent.js`, `bridge/test/helpers/bridge.js`
- Modify: `bridge/server.js` (конфиг, `makeSession`, `createSession`, `sessionList`, рассылка `sessions`, ветка `create`)
- Modify: `bridge/config.example.json`, `bridge/test/server-sessions.test.js` (конфиг теста подплана 1)
- Test: `bridge/test/server-agents.test.js`

- [ ] **Step 1: Фейковый агент** — `bridge/test/fixtures/fake-agent.js`:

```js
'use strict';
// Фейковый TUI-агент для интеграционных тестов (вместо claude.exe / opencode.exe):
// печатает свои аргументы и нужные тестам переменные окружения, эхо ввода посимвольно.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('ARGV:' + JSON.stringify(process.argv.slice(2)) + '\r\n');
process.stdout.write('HOOKTOKEN:' + (process.env.CLAUDE_BRIDGE_HOOK_TOKEN || '') + '\r\n');
process.stdout.write('OCPW:' + (process.env.OPENCODE_PASSWORD || '-') + '\r\n');
process.stdin.on('data', (d) => process.stdout.write('ECHO:' + JSON.stringify(String(d)) + '\r\n'));
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Стенд** — `bridge/test/helpers/bridge.js`:

```js
'use strict';
// Стенд интеграционных тестов подплана 2: мост в изолированном каталоге данных,
// клиенты владельца и устройства, ожидание сообщений и вывода сессии.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { pinnedTlsOptions } = require('../../lib/cert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_AGENT = path.join(__dirname, '..', 'fixtures', 'fake-agent.js');
const DEVICE = { id: 'devtest00001', token: 'd'.repeat(48), name: 'Test phone', addedAt: '2026-10-31T00:00:00.000Z' };

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '');
}

async function waitUntil(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(50); }
  throw new Error('условие не выполнено за ' + ms + ' мс');
}

function connectWs(port, pin, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ...pin, headers: { Authorization: 'Bearer ' + token } });
    const msgs = [];
    const out = {};
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      msgs.push(m);
      if (m.type === 'scrollback') out[m.id] = m.data;
      else if (m.type === 'output') out[m.id] = (out[m.id] || '') + m.data;
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      msgs,
      send: (o) => ws.send(JSON.stringify(o)),
      mark: () => msgs.length,
      async wait(pred, timeoutMs = 10000, since = 0) {
        const end = Date.now() + timeoutMs;
        for (;;) {
          for (let i = since; i < msgs.length; i++) if (pred(msgs[i])) return msgs[i];
          if (Date.now() > end) throw new Error('не дождались сообщения');
          await sleep(50);
        }
      },
      async waitOutput(id, re, timeoutMs = 15000) {
        const end = Date.now() + timeoutMs;
        for (;;) {
          const m = stripAnsi(out[id] || '').match(re);
          if (m) return m;
          if (Date.now() > end) throw new Error(`не дождались вывода ${re}; хвост: ${JSON.stringify(stripAnsi(out[id] || '').slice(-300))}`);
          await sleep(100);
        }
      },
      output: (id) => stripAnsi(out[id] || ''),
      close: () => { try { ws.close(); } catch { /* закрыт */ } },
    }));
  });
}

/** create + attach; resolve: сообщение created | error | createConflict. */
async function createAndAttach(c, msg) {
  const at = c.mark();
  c.send({ type: 'create', ...msg });
  const r = await c.wait((m) => m.type === 'created' || m.type === 'error' || m.type === 'createConflict', 20000, at);
  if (r.type === 'created') c.send({ type: 'attach', id: r.id, cols: 120, rows: 30 });
  return r;
}

async function startBridge({ config = {}, devices = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-it-'));
  const cwd = fs.realpathSync.native(home);
  const port = 22000 + Math.floor(Math.random() * 400) * 3;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, host: '127.0.0.1', defaultCwd: cwd, projects: [cwd], env: {}, scrollbackBytes: 65536, ...config,
  }));
  if (devices.length) fs.writeFileSync(path.join(home, 'pairings.json'), JSON.stringify({ devices }));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_PORT: String(port), CLAUDE_BRIDGE_TEST: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  const tokFile = path.join(home, 'owner.token');
  for (let i = 0; i < 150 && !fs.existsSync(tokFile); i++) await sleep(200);
  await sleep(1500);
  const owner = fs.readFileSync(tokFile, 'utf8').trim();
  const der = fs.readFileSync(path.join(home, 'certs', 'bridge.cer'));
  const pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), crypto.createHash('sha256').update(der).digest('hex'));
  const clients = [];
  const b = {
    home, cwd, port, owner, pin,
    async connect(token) { const c = await connectWs(port, pin, token); clients.push(c); return c; },
    postHook(sid, token, payload) {
      return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const req = https.request({
          host: '127.0.0.1', port, path: '/hook', method: 'POST', agent: false, ...pin,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
            'X-Bridge-Session': sid, 'Content-Length': Buffer.byteLength(body) },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', () => resolve('error'));
        req.end(body);
      });
    },
    async stop() {
      try {
        const c = await connectWs(port, pin, owner);
        const s = await c.wait((m) => m.type === 'sessions', 5000);
        for (const x of s.sessions) if (x.alive) c.send({ type: 'kill', id: x.id });
        await sleep(1500);
        c.close();
      } catch { /* мост уже недоступен */ }
      for (const c of clients) c.close();
      try { proc.kill(); } catch { /* уже завершён */ }
      await sleep(500);
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* keeper ещё держит файл */ }
    },
  };
  return b;
}

module.exports = { startBridge, createAndAttach, connectWs, waitUntil, stripAnsi, sleep, FAKE_AGENT, DEVICE };
```

- [ ] **Step 3: Интеграционный тест** — `bridge/test/server-agents.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, createAndAttach, FAKE_AGENT, DEVICE } = require('./helpers/bridge');

let b;
test.before(async () => {
  b = await startBridge({ devices: [DEVICE], config: {
    defaultAgent: 'echo',
    agents: {
      echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [FAKE_AGENT] },
      claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] },
      broken: { type: 'generic', command: 'definitely-not-a-command-cb' },
    },
  } });
});
test.after(() => b.stop());

test('sessions message lists available agents with options and scroll (D-5, D-10)', async () => {
  const c = await b.connect(DEVICE.token);
  const s = await c.wait((m) => m.type === 'sessions');
  assert.deepStrictEqual(s.agents.map((a) => a.id), ['echo', 'claude']);
  assert.strictEqual(s.defaultAgent, 'echo');
  const claude = s.agents.find((a) => a.id === 'claude');
  assert.deepStrictEqual(claude.options.map((o) => o.id), ['resume', 'skipPermissions']);
  assert.strictEqual(claude.scroll, 'wheel');
  assert.strictEqual(s.agents.find((a) => a.id === 'echo').scroll, 'pageKeys');
});

test('device: options become flags; raw args and command ignored (P-3)', { timeout: 60000 }, async () => {
  const c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'claude', cwd: b.cwd,
    options: { resume: true, skipPermissions: true, bogus: true }, args: ['--evil'], command: 'cmd.exe' });
  assert.strictEqual(r.type, 'created');
  const m = await c.waitOutput(r.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), ['--resume', '--dangerously-skip-permissions']);
  const listed = (await c.wait((x) => x.type === 'sessions' && x.sessions.some((s) => s.id === r.id))).sessions
    .find((s) => s.id === r.id);
  assert.strictEqual(listed.agent, 'claude');
  assert.strictEqual(listed.agentName, 'Claude Code');
  assert.strictEqual(listed.scroll, 'wheel');
});

test('owner: default agent, raw args appended', { timeout: 60000 }, async () => {
  const c = await b.connect(b.owner);
  const r = await createAndAttach(c, { cwd: b.cwd, args: ['--owner-arg'] });
  assert.strictEqual(r.type, 'created');
  const m = await c.waitOutput(r.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), ['--owner-arg']);
  const listed = (await c.wait((x) => x.type === 'sessions' && x.sessions.some((s) => s.id === r.id))).sessions
    .find((s) => s.id === r.id);
  assert.strictEqual(listed.agent, 'echo');
  assert.match(listed.title, /· Echo$/);
});

test('unknown agent is refused (D-5)', async () => {
  const c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'nope', cwd: b.cwd });
  assert.strictEqual(r.type, 'error');
  assert.match(r.message, /неизвестный агент/);
});
```

- [ ] **Step 4: Убедиться, что падает**

Run: `cd bridge && node --test test/server-agents.test.js`
Expected: FAIL — в `sessions` нет поля `agents` (`Cannot read properties of undefined (reading 'map')`).

- [ ] **Step 5: `server.js` — подключение реестра**

К верхним `require` (рядом с `require('./lib/validate')`) добавить:

```js
const { loadAgents, normalizeOptions } = require('./agents');
const generic = require('./agents/generic');
const SE = require('./lib/session-events');
const { findOnPath } = require('./lib/which');
```

Сразу после строки `CONFIG.defaultCwd = P.expandConfigPath(CONFIG.defaultCwd || '') || os.homedir();` добавить:

```js
// D-3/D-5: адаптеры агентов из конфига (по умолчанию claude + opencode, если установлены)
const AGENTS = loadAgents(CONFIG);
console.log('  Агенты: ' + (AGENTS.list().map((a) => a.id).join(', ') || 'нет ни одного доступного'));

/** Адаптер сессии по meta: настроенный агент или «своя команда» владельца (generic). */
function adapterFor(meta) {
  return AGENTS.get(meta.agent) || generic.create(
    typeof meta.agent === 'string' && meta.agent ? meta.agent : 'custom',
    { name: path.basename(String(meta.cmd || 'custom')), command: String(meta.cmd || 'custom') });
}
```

- [ ] **Step 6: `server.js` — `makeSession`, `sessionList`, рассылка `sessions`**

`makeSession` заменить целиком:

```js
function makeSession(meta) {
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    command: meta.cmd,
    pid: null,
    createdAt: meta.createdAt,
    pipe: meta.pipe,
    secret: meta.secret,
    hookToken: meta.hookToken,
    channel: null,
    buffer: [],
    bufferBytes: 0,
    clients: new Set(),
    alive: true,
    lastNotify: null,
    status: 'idle', // idle | working | waiting — по событиям адаптера
    cols: meta.cols,
    rows: meta.rows,
    lastInput: null, // клиент, печатавший последним — его размер и держим
    agent: typeof meta.agent === 'string' ? meta.agent : 'custom',
    agentState: meta.agentState && typeof meta.agentState === 'object' ? meta.agentState : {},
    adapter: adapterFor(meta),
    runtime: {},          // состояние адаптера в памяти (не сохраняется)
    pending: new Map(),   // requestId -> ожидающий запрос разрешения (D-4)
    unsubscribe: null,    // отписка от событий SSE (opencode)
  };
}
```

`sessionList` заменить и добавить `sessionsMsg`:

```js
function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    pid: s.pid,
    alive: s.alive,
    status: s.status,
    createdAt: s.createdAt,
    lastNotify: s.lastNotify,
    agent: s.agent,
    agentName: s.adapter.name,
    scroll: s.adapter.scroll, // D-10
  }));
}

function sessionsMsg() {
  return {
    type: 'sessions', sessions: sessionList(), projects: CONFIG.projects || [],
    agents: AGENTS.list(), defaultAgent: AGENTS.defaultId,
  };
}
```

Тело `broadcastSessions` заменить на `broadcast(sessionsMsg());`; в обработчике `connection` строку отправки первого `sessions` и в ветке `case 'list':` — на `ws.send(JSON.stringify(sessionsMsg()));`.

Добавить вспомогательную функцию рядом с `broadcast`:

```js
function wsSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
```

Проверка: `grep -n "type: 'sessions'" bridge/server.js` → одна строка (внутри `sessionsMsg`).

- [ ] **Step 7: `server.js` — `createSession` через адаптер**

Функцию `createSession` заменить целиком:

```js
async function createSession({ cwd, agentId, options, rawArgs, command, title, local }) {
  // Произвольную команду и сырые аргументы задаёт только владелец (P-3); устройство —
  // только id агента и id его опций (D-5): мост сам строит командную строку.
  let adapter;
  if (local && command) {
    if (!findOnPath(command)) throw new Error('команда не найдена: ' + command);
    adapter = generic.create('custom', { name: path.basename(command), command, args: [] });
  } else {
    adapter = AGENTS.get(agentId || AGENTS.defaultId);
    if (!adapter) throw new Error('неизвестный агент: ' + String(agentId || '(нет агента по умолчанию)'));
  }
  const dir = local
    ? P.resolveLocalCwd(cwd, CONFIG.defaultCwd)
    : P.resolveRemoteCwd(cwd, CONFIG.projects, CONFIG.defaultCwd);
  const opts = normalizeOptions(adapter, options);
  const extra = local ? (rawArgs || []) : [];
  const id = 's' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
  const finalTitle = title || `${path.basename(dir) || dir} · ${adapter.name}`;
  const spec = await adapter.spawnSpec({ cwd: dir, title: finalTitle, options: opts, rawArgs: extra });

  const secret = crypto.randomBytes(32).toString('hex');
  const hookToken = T.newToken();
  const meta = {
    id,
    cmd: spec.command,
    args: spec.args,
    cwd: dir,
    title: finalTitle,
    agent: adapter.id,
    agentState: spec.state || {},
    createdAt: Date.now(),
    cols: 100,
    rows: 30,
    scrollbackBytes: CONFIG.scrollbackBytes || 262144,
    pipe: K.pipeName(),
    secret,
    hookToken,
  };
  // Окружение keeper'а = окружение агента (keeper удаляет только секрет канала, D-11):
  // сюда же — env адаптера (OPENCODE_PASSWORD для TUI opencode, D-12).
  const childEnv = {
    ...process.env, ...CONFIG.env, ...(spec.env || {}),
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

  const session = makeSession(meta);
  sessions.set(id, session);
  connectKeeper(session, 20);
  broadcastSessions();
  return session;
}
```

- [ ] **Step 8: `server.js` — ветка `create`**

`case 'create': { … }` заменить целиком:

```js
      case 'create': {
        if (sessions.size >= MAX_SESSIONS) {
          wsSend(ws, { type: 'error', message: 'Достигнут предел числа сессий' });
          break;
        }
        if (!rateAllowCreate(ws.deviceId)) {
          wsSend(ws, { type: 'error', message: 'Слишком часто — подождите немного' });
          break;
        }
        const local = ws.deviceId === 'local';
        createSession({
          cwd: V.str(m.cwd, 1024),
          title: V.cleanTitle(m.title), // L-8
          agentId: V.str(m.agent, 32),
          options: m.options,
          rawArgs: local && Array.isArray(m.args) && m.args.every((a) => typeof a === 'string' && a.length <= 4096)
            ? m.args.slice(0, 64) : [],
          command: local ? V.str(m.command, 1024) : null,
          local,
        }).then((created) => wsSend(ws, { type: 'created', id: created.id }))
          .catch((e) => wsSend(ws, { type: 'error', message: 'Не удалось создать сессию: ' + e.message }));
        break;
      }
```

Проверка: `grep -n "claudeCommand\|claudeArgs" bridge/server.js` → пусто.

- [ ] **Step 9: Конфиг-пример и тест подплана 1**

`bridge/config.example.json` — заменить строки `"claudeCommand": "claude",` и `"claudeArgs": [],` на:

```json
  "defaultAgent": "claude",
  "agents": {
    "claude": {},
    "opencode": {}
  },
```

(Ключ `agents` можно расширять: `"aider": { "type": "generic", "name": "Aider", "command": "aider", "args": [], "scroll": "pageKeys" }`.)

В `bridge/test/server-sessions.test.js` (подплан 1, задача 11) в объекте конфига заменить

```js
    port, host: '127.0.0.1', claudeCommand: process.execPath,
    claudeArgs: ['-e', "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
```

на

```js
    port, host: '127.0.0.1',
    defaultAgent: 'echo',
    agents: { echo: { type: 'generic', command: process.execPath,
      args: ['-e', "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"] } },
```

- [ ] **Step 10: Тесты проходят**

Run: `cd bridge && node --test test/server-agents.test.js test/server-sessions.test.js`
Expected: `# pass 5`, `# fail 0`.

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 11: Commit**

```bash
git add bridge/server.js bridge/config.example.json bridge/test/server-agents.test.js bridge/test/server-sessions.test.js bridge/test/helpers/bridge.js bridge/test/fixtures/fake-agent.js
git commit -m "feat(bridge): sessions via agent adapters; create {agent, options}; agents in sessions (D-5, P-3, D-10)"
```

---

### Task 11: `server.js` — события адаптера, `/hook`, `reply`, закрытие запросов (D-4)

**Files:**
- Modify: `bridge/server.js` (`/hook`, ветки `input`/`reply`, `dropSession`, `createSession`, `restoreSessions`)
- Test: `bridge/test/server-requests.test.js`

- [ ] **Step 1: Интеграционный тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, createAndAttach, sleep, FAKE_AGENT, DEVICE } = require('./helpers/bridge');

let b;
let c;
let sid;
let hookToken;
const PR = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo hi' } };

test.before(async () => {
  b = await startBridge({ devices: [DEVICE], config: {
    defaultAgent: 'claude', agents: { claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] } },
  } });
  c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'claude', cwd: b.cwd });
  sid = r.id;
  hookToken = (await c.waitOutput(sid, /HOOKTOKEN:([0-9a-f]{64})/))[1];
});
test.after(() => b.stop());

async function openRequest() {
  const at = c.mark();
  assert.strictEqual(await b.postHook(sid, hookToken, PR), 200);
  return c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'request', 5000, at);
}

test('hook with a wrong token is refused', async () => {
  assert.strictEqual(await b.postHook(sid, 'a'.repeat(64), PR), 403);
});

test('request -> notify{requestId, choices}; reply once -> key 1; repeat is stale', { timeout: 30000 }, async () => {
  const at0 = c.mark();
  const n = await openRequest();
  assert.match(n.requestId, /^req_[0-9a-f]{16}$/);
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'always', 'reject']);
  assert.match(n.message, /Bash: echo hi/);
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'waiting', 5000, at0);

  let at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'once' });
  const ok = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.strictEqual(ok.ok, true);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 5000, at);
  await c.waitOutput(sid, /ECHO:"1"/);

  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'always' });
  const stale = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.deepStrictEqual([stale.ok, stale.error], [false, 'stale']);
  await sleep(800);
  assert.doesNotMatch(c.output(sid), /ECHO:"2"/);
});

test('PTY input from any client closes the request; focus reports do not', { timeout: 30000 }, async () => {
  const owner = await b.connect(b.owner);
  const n = await openRequest();
  let at = c.mark();
  owner.send({ type: 'input', id: sid, data: '\x1b[I' });
  await sleep(700);
  assert.ok(!c.msgs.slice(at).some((m) => m.type === 'requestClosed'), 'focus report keeps request open');
  owner.send({ type: 'input', id: sid, data: 'x' });
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 5000, at);
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'once' });
  const r = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.strictEqual(r.ok, false);

  const n2 = await openRequest();
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n2.requestId, decision: 'reject' });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'idle', 5000, at);
  await c.waitOutput(sid, /ECHO:"\\u001b"/);
});

test('agent_id events do not change status; Stop -> idle + done', { timeout: 30000 }, async () => {
  let at = c.mark();
  await b.postHook(sid, hookToken, { hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'working', 5000, at);
  at = c.mark();
  await b.postHook(sid, hookToken, { hook_event_name: 'Stop', agent_id: 'sub1' });
  await sleep(700);
  assert.ok(!c.msgs.slice(at).some((m) => m.type === 'status' && m.id === sid), 'subagent Stop ignored');
  await b.postHook(sid, hookToken, { hook_event_name: 'Stop' });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'idle', 5000, at);
  const done = await c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'done', 5000, at);
  assert.match(done.message, /завершил/);
});

test('kill closes pending requests', { timeout: 30000 }, async () => {
  const n = await openRequest();
  const at = c.mark();
  c.send({ type: 'kill', id: sid });
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 10000, at);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/server-requests.test.js`
Expected: FAIL — `не дождались сообщения` (в `notify` нет `event: 'request'`, сообщения `replyResult` нет).

- [ ] **Step 3: `server.js` — подписка на события и применение**

Рядом с `keeperSend` добавить:

```js
/** События адаптера (P-2) -> состояние сессии и рассылка (D-4). */
function emitEvents(session, events) {
  if (!sessions.has(session.id)) return;
  const r = SE.applyEvents(session, events);
  for (const msg of r.messages) broadcast(msg);
  if (r.sessionsChanged) broadcastSessions();
}

function startAgentEvents(session) {
  if (session.adapter.events !== 'sse' || session.unsubscribe) return;
  session.unsubscribe = session.adapter.subscribe(session, (events) => emitEvents(session, events));
}

function stopAgentEvents(session) {
  if (!session.unsubscribe) return;
  try { session.unsubscribe(); } catch { /* уже отписаны */ }
  session.unsubscribe = null;
}
```

`dropSession` заменить целиком:

```js
function dropSession(session, exitCode) {
  if (!sessions.has(session.id)) return;
  session.alive = false;
  stopAgentEvents(session);
  for (const msg of SE.closeAllRequests(session)) broadcast(msg);
  broadcast({ type: 'exit', id: session.id, exitCode: exitCode == null ? -1 : exitCode });
  sessions.delete(session.id);
  broadcastSessions();
}
```

В `createSession` после `connectKeeper(session, 20);` добавить строку `startAgentEvents(session);`. В `restoreSessions` после `connectKeeper(session, 3);` добавить `startAgentEvents(session);`.

- [ ] **Step 4: `server.js` — `/hook` через адаптер**

Обработчик `POST /hook` заменить целиком:

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
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { res.writeHead(400); res.end(); return; }
      // статус, запросы и уведомления — по правилам адаптера агента этой сессии
      if (s.adapter.events === 'hook') emitEvents(s, s.adapter.onHook(s, payload));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
```

- [ ] **Step 5: `server.js` — ветки `input` и `reply`**

`case 'input':` заменить целиком:

```js
      case 'input': {
        const d = V.str(m.data, 65536);
        if (s && s.alive && d !== null) {
          if (s.lastInput !== ws) {
            s.lastInput = ws; // клиент начал печатать — PTY подстраивается под него
            if (ws.desired) resizePty(s, ws.desired.cols, ws.desired.rows);
          }
          // любой ввод в PTY может ответить на диалог агента: запрос больше не актуален
          emitEvents(s, s.adapter.onInput(s, d));
          keeperSend(s, { t: 'in', d });
        }
        break;
      }
```

Добавить новую ветку (рядом с `input`):

```js
      case 'reply': {
        // D-4: семантический ответ на запрос разрешения; мост проверяет, что запрос ещё ждёт
        const requestId = V.str(m.requestId, 128);
        const decision = SE.DECISIONS.includes(m.decision) ? m.decision : null;
        const pend = s && s.alive && requestId ? s.pending.get(requestId) : null;
        if (!pend || !decision || !pend.choices.some((c) => c.id === decision)) {
          wsSend(ws, { type: 'replyResult', id: sid, requestId, ok: false, error: 'stale' });
          break;
        }
        Promise.resolve()
          .then(() => s.adapter.reply(s, pend, decision, { write: (data) => keeperSend(s, { t: 'in', d: data }) }))
          .then((r) => {
            emitEvents(s, r.events);
            wsSend(ws, { type: 'replyResult', id: s.id, requestId, ok: !!r.ok,
              error: r.ok ? undefined : (r.stale ? 'stale' : 'failed') });
          })
          .catch((e) => {
            console.error(`  Ответ на запрос ${requestId}: ${e.message}`);
            wsSend(ws, { type: 'replyResult', id: s.id, requestId, ok: false, error: 'failed' });
          });
        break;
      }
```

- [ ] **Step 6: Тесты проходят**

Run: `cd bridge && node --test test/server-requests.test.js`
Expected: `# pass 5`.

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add bridge/server.js bridge/test/server-requests.test.js
git commit -m "feat(bridge): adapter events, semantic reply with stale protection, request closing (D-4)"
```

---

### Task 12: `server.js` — конфликт resume решает мост (D-7)

Сравнение путей — только на мосту (D-7): при resume-подобном запуске в каталоге, где уже есть живая сессия того же агента, мост отвечает `createConflict` вместо создания; клиент спрашивает пользователя и повторяет `create` с `force: true`.

**Files:**
- Modify: `bridge/server.js` (`createSession`, ветка `create`)
- Test: `bridge/test/server-resume.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, createAndAttach, FAKE_AGENT, DEVICE } = require('./helpers/bridge');

let b;
test.before(async () => {
  b = await startBridge({ devices: [DEVICE], config: {
    defaultAgent: 'claude', agents: { claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] } },
  } });
});
test.after(() => b.stop());

test('resume next to a live session of the same agent -> createConflict, force creates', { timeout: 60000 }, async () => {
  const c = await b.connect(DEVICE.token);
  const first = await createAndAttach(c, { agent: 'claude', cwd: b.cwd });
  assert.strictEqual(first.type, 'created');
  const plain = await createAndAttach(c, { agent: 'claude', cwd: b.cwd.toUpperCase() });
  assert.strictEqual(plain.type, 'created', 'without resume no conflict');
  const conflict = await createAndAttach(c, { agent: 'claude', cwd: b.cwd.toUpperCase(), options: { resume: true } });
  assert.strictEqual(conflict.type, 'createConflict');
  assert.strictEqual(conflict.reason, 'resumeLive');
  assert.strictEqual(conflict.cwd, b.cwd);
  assert.deepStrictEqual(conflict.live.map((x) => x.id).sort(), [first.id, plain.id].sort());
  const forced = await createAndAttach(c, { agent: 'claude', cwd: b.cwd, options: { resume: true }, force: true });
  assert.strictEqual(forced.type, 'created');

  const o = await b.connect(b.owner);
  const raw = await createAndAttach(o, { agent: 'claude', cwd: b.cwd, args: ['-c'] });
  assert.strictEqual(raw.type, 'createConflict', 'owner raw --continue is resume-like too');
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/server-resume.test.js`
Expected: FAIL — `conflict.type` равно `'created'`.

- [ ] **Step 3: Реализация**

Сигнатура `createSession`: `async function createSession({ cwd, agentId, options, rawArgs, command, title, local, force })`. В `createSession` после строки `const extra = local ? (rawArgs || []) : [];` вставить:

```js
  // D-7: живая сессия того же агента в этом каталоге + resume -> решает пользователь
  if (force !== true && adapter.isResumeLike({ options: opts, rawArgs: extra })) {
    const live = [...sessions.values()].filter((x) => x.alive && x.agent === adapter.id && P.samePath(x.cwd, dir));
    if (live.length) return { conflict: { cwd: dir, live: live.map((x) => ({ id: x.id, title: x.title })) } };
  }
```

и в конце функции `return session;` заменить на `return { session };`.

В ветке `create` в объект аргументов `createSession({ … })` добавить `force: m.force === true,`, а строку `}).then((created) => wsSend(ws, { type: 'created', id: created.id }))` (строка `.catch(…)` под ней остаётся) заменить на:

```js
        }).then((r) => {
          if (r.conflict) wsSend(ws, { type: 'createConflict', reason: 'resumeLive', ...r.conflict });
          else wsSend(ws, { type: 'created', id: r.session.id });
        })
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/server-resume.test.js test/server-agents.test.js`
Expected: `# pass 5`.

- [ ] **Step 5: Commit**

```bash
git add bridge/server.js bridge/test/server-resume.test.js
git commit -m "feat(bridge): resume conflict decided by the bridge (D-7)"
```

---

### Task 13: Сквозной тест opencode через мост на фейковом сервисе (D-12, D-14, D-4)

Только тест: проверяет связку задач 7, 10, 11 (создание через API, env keeper'а, SSE → `notify`, `reply` → API, ресинхронизация после обрыва). Если тест падает — чинить код задач 7/10/11, не тест.

**Files:**
- Test: `bridge/test/server-opencode.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBridge, createAndAttach, waitUntil, sleep, FAKE_AGENT, DEVICE } = require('./helpers/bridge');
const { startFakeOpencode } = require('./helpers/fake-opencode');

let fake;
let b;
let c;
let sid;
test.before(async () => {
  fake = await startFakeOpencode();
  const file = fake.writeServiceFile(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ocs-')));
  b = await startBridge({ devices: [DEVICE], config: {
    defaultAgent: 'opencode',
    agents: { opencode: { command: process.execPath, prefixArgs: [FAKE_AGENT], serviceFile: file } },
  } });
  c = await b.connect(DEVICE.token);
});
test.after(async () => { await b.stop(); await fake.close(); });

test('create: API session with ask-shell, TUI args and password env (D-12, D-14)', { timeout: 60000 }, async () => {
  const r = await createAndAttach(c, { agent: 'opencode', cwd: b.cwd, options: { askShell: true } });
  assert.strictEqual(r.type, 'created');
  sid = r.id;
  const body = fake.state.sessions[0].body;
  assert.strictEqual(body.location.directory, b.cwd);
  assert.deepStrictEqual(body.permissions, [{ action: 'shell', resource: '*', effect: 'ask' }]);
  const argv = JSON.parse((await c.waitOutput(sid, /ARGV:(\[[^\]]*\])/))[1]);
  assert.deepStrictEqual(argv, ['--server', fake.url, '--session', 'ses_fake1']);
  await c.waitOutput(sid, new RegExp('OCPW:' + fake.password));
});

test('permission.asked -> notify; foreign session ignored; reply -> API; stale', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  await sleep(200);
  const at = c.mark();
  fake.ask('ses_other', { id: 'per_x' });
  fake.ask('ses_fake1', { id: 'per_1', action: 'shell', resources: ['echo hi'], save: ['echo *'] });
  const n = await c.wait((m) => m.type === 'notify' && m.event === 'request' && m.requestId === 'per_1', 5000, at);
  assert.strictEqual(n.id, sid);
  assert.match(n.message, /shell: echo hi/);
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'always', 'reject']);
  assert.ok(!c.msgs.slice(at).some((m) => m.requestId === 'per_x'));

  c.send({ type: 'reply', id: sid, requestId: 'per_1', decision: 'once' });
  const ok = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_1', 5000, at);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_fake1', requestID: 'per_1', decision: 'once' }]);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === 'per_1', 5000, at);
  const at2 = c.mark();
  c.send({ type: 'reply', id: sid, requestId: 'per_1', decision: 'once' });
  const stale = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_1', 5000, at2);
  assert.deepStrictEqual([stale.ok, stale.error], [false, 'stale']);
});

test('missed request is restored after SSE drop (resync)', { timeout: 30000 }, async () => {
  const at = c.mark();
  fake.addSilently('ses_fake1', { id: 'per_2', action: 'edit', resources: ['a.txt'], save: [] });
  fake.dropSse();
  const n = await c.wait((m) => m.type === 'notify' && m.requestId === 'per_2', 15000, at);
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'reject']);
});

test('execution events -> working / idle + done', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  const at = c.mark();
  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_fake1' } });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'working', 5000, at);
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_fake1' } });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'idle', 5000, at);
  await c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'done', 5000, at);
});
```

- [ ] **Step 2: Запустить**

Run: `cd bridge && node --test test/server-opencode.test.js`
Expected: `# pass 4`. При падении — исправить код задач 7/10/11 (не ослабляя тест) и перезапустить; затем `npm test` → `# fail 0`.

- [ ] **Step 3: Commit**

```bash
git add bridge/test/server-opencode.test.js
git commit -m "test(bridge): end-to-end opencode session through the bridge on a fake service"
```

---

### Task 14: `confirmations.js` — ожидающие подтверждения (D-13)

**Files:**
- Create: `bridge/lib/confirmations.js`
- Test: `bridge/test/confirmations.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Confirmations, confirmView } = require('../lib/confirmations');

test('request / resolve / one pending per action', () => {
  let t = 1000;
  const c = new Confirmations({ ttlMs: 100, now: () => t });
  const runs = [];
  const e = c.request('pairinfo', 'WS', () => runs.push('p'));
  assert.match(e.confirmId, /^cf_[0-9a-f]{16}$/);
  assert.strictEqual(e.requester, 'WS');
  assert.match(e.message, /код сопряжения/);
  assert.strictEqual(c.request('pairinfo', 'WS2', () => {}), null, 'already pending');
  assert.ok(c.request('setInternet', 'WS', () => {}), 'other action independent');
  assert.strictEqual(c.resolve('cf_nope'), null);
  assert.strictEqual(c.resolve(42), null);
  const got = c.resolve(e.confirmId);
  got.run();
  assert.deepStrictEqual(runs, ['p']);
  assert.strictEqual(c.resolve(e.confirmId), null, 'single use');
  assert.throws(() => c.request('rm-rf', 'WS', () => {}), /unknown/);
});

test('expiry: sweep returns expired, resolve ignores them', () => {
  let t = 0;
  const c = new Confirmations({ ttlMs: 100, now: () => t });
  const e = c.request('setInternet', 'WS', () => {});
  t = 150;
  assert.strictEqual(c.resolve(e.confirmId), null);
  assert.deepStrictEqual(c.sweep().map((x) => x.confirmId), [e.confirmId]);
  assert.deepStrictEqual(c.list(), []);
  assert.ok(c.request('setInternet', 'WS', () => {}), 'new request after expiry');
});

test('confirmView exposes no requester or run', () => {
  const c = new Confirmations({ ttlMs: 100, now: () => 5 });
  const e = c.request('pairinfo', 'WS', () => {});
  assert.deepStrictEqual(confirmView(e), {
    type: 'confirmRequest', confirmId: e.confirmId, action: 'pairinfo', message: e.message, at: 5, expiresAt: 105,
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/confirmations.test.js`
Expected: FAIL — `Cannot find module '../lib/confirmations'`.

- [ ] **Step 3: Реализация** — `bridge/lib/confirmations.js`:

```js
'use strict';
// D-13: выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже
// сопряжённом телефоне. Здесь — только учёт ожидающих подтверждений; рассылку и
// выполнение делает server.js.
const crypto = require('crypto');

const MESSAGES = {
  pairinfo: 'Выпустить код сопряжения нового устройства?',
  setInternet: 'Включить доступ к мосту через интернет?',
};

class Confirmations {
  constructor({ ttlMs = 120000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  /** Новое подтверждение; null — такое действие уже ждёт ответа. */
  request(action, requester, run) {
    if (!MESSAGES[action]) throw new Error('unknown action: ' + action);
    const t = this.now();
    for (const e of this.map.values()) if (e.action === action && e.expiresAt > t) return null;
    const e = {
      confirmId: 'cf_' + crypto.randomBytes(8).toString('hex'),
      action, message: MESSAGES[action], at: t, expiresAt: t + this.ttlMs, requester, run,
    };
    this.map.set(e.confirmId, e);
    return e;
  }

  /** Забрать ожидающее подтверждение (однократно); просроченное не выдаётся — его заберёт sweep. */
  resolve(confirmId) {
    if (typeof confirmId !== 'string') return null;
    const e = this.map.get(confirmId);
    if (!e || e.expiresAt <= this.now()) return null;
    this.map.delete(confirmId);
    return e;
  }

  /** Удалить и вернуть просроченные. */
  sweep() {
    const t = this.now();
    const out = [];
    for (const [k, e] of this.map) if (e.expiresAt <= t) { this.map.delete(k); out.push(e); }
    return out;
  }

  list() {
    const t = this.now();
    return [...this.map.values()].filter((e) => e.expiresAt > t);
  }
}

function confirmView(e) {
  return { type: 'confirmRequest', confirmId: e.confirmId, action: e.action, message: e.message, at: e.at, expiresAt: e.expiresAt };
}

module.exports = { Confirmations, confirmView, MESSAGES };
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/confirmations.test.js`
Expected: `# pass 3`.

- [ ] **Step 5: Commit**

```bash
git add bridge/lib/confirmations.js bridge/test/confirmations.test.js
git commit -m "feat(bridge): pending owner confirmations (D-13)"
```

---

### Task 15: `server.js` — подтверждение на сопряжённом телефоне (D-13)

Правило D-13: если сопряжённых устройств нет — достаточно `confirmed: true` от интерактивной консоли (`claude-mobile`, подплан 1); если есть хотя бы одно — подтверждение только с телефона, флаг консоли игнорируется. Выключение интернет-доступа подтверждения не требует.

**Files:**
- Modify: `bridge/server.js` (ветки `pairinfo`, `setInternet`, новая `confirm`, обработчик `connection`)
- Test: `bridge/test/server-confirm.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, sleep, DEVICE } = require('./helpers/bridge');

test('no paired devices: console confirmation flag is required', { timeout: 90000 }, async () => {
  const b = await startBridge();
  try {
    const o = await b.connect(b.owner);
    let at = o.mark();
    o.send({ type: 'pairinfo' });
    const r = await o.wait((m) => m.type === 'confirmRequired' || m.type === 'pairinfo', 5000, at);
    assert.deepStrictEqual([r.type, r.action], ['confirmRequired', 'pairinfo']);
    at = o.mark();
    o.send({ type: 'pairinfo', confirmed: true });
    const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
    assert.match(p.code, /^[0-9A-F]{10}$/);
  } finally { await b.stop(); }
});

test('paired device: owner operations wait for the phone', { timeout: 90000 }, async () => {
  const b = await startBridge({ devices: [DEVICE] });
  try {
    const o = await b.connect(b.owner);
    const d = await b.connect(DEVICE.token);
    let at = o.mark();
    let atD = d.mark();
    o.send({ type: 'pairinfo', confirmed: true });
    const pend = await o.wait((m) => m.type === 'confirmPending', 5000, at);
    const req = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    assert.strictEqual(req.confirmId, pend.confirmId);
    assert.strictEqual(req.action, 'pairinfo');
    assert.match(req.message, /код сопряжения/);

    o.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
    await sleep(500);
    assert.ok(!o.msgs.slice(at).some((m) => m.type === 'pairinfo'), 'owner cannot confirm itself');

    d.send({ type: 'confirm', confirmId: req.confirmId, allow: false });
    const res = await o.wait((m) => m.type === 'confirmResult', 5000, at);
    assert.deepStrictEqual([res.allow, res.reason], [false, 'denied']);
    await d.wait((m) => m.type === 'confirmClosed' && m.confirmId === req.confirmId, 5000, atD);
    assert.ok(!o.msgs.slice(at).some((m) => m.type === 'pairinfo'));

    at = o.mark();
    atD = d.mark();
    o.send({ type: 'pairinfo' });
    const req2 = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
    d.send({ type: 'confirm', confirmId: req2.confirmId, allow: true });
    const p = await o.wait((m) => m.type === 'pairinfo', 5000, at);
    assert.match(p.code, /^[0-9A-F]{10}$/);
    assert.strictEqual((await o.wait((m) => m.type === 'confirmResult', 5000, at)).allow, true);

    at = o.mark();
    o.send({ type: 'setInternet', enabled: false });
    await o.wait((m) => m.type === 'internet' && m.enabled === false, 5000, at);
    o.send({ type: 'setInternet', enabled: true });
    const ip = await o.wait((m) => m.type === 'confirmPending' && m.action === 'setInternet', 5000, at);
    o.send({ type: 'setInternet', enabled: true });
    await o.wait((m) => m.type === 'error' && /уже ожидается/.test(m.message), 5000, at);

    const d2 = await b.connect(DEVICE.token);
    const late = await d2.wait((m) => m.type === 'confirmRequest' && m.confirmId === ip.confirmId, 5000);
    d2.send({ type: 'confirm', confirmId: late.confirmId, allow: false });
    await o.wait((m) => m.type === 'confirmResult' && m.confirmId === ip.confirmId && m.allow === false, 5000, at);
  } finally { await b.stop(); }
});
```

(Разрешение включения интернета тестом не проверяется: оно запустило бы настоящий `bin\claude-tunnel.exe`.)

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/server-confirm.test.js`
Expected: FAIL — `не дождались сообщения` (нет `confirmRequired`/`confirmPending`).

- [ ] **Step 3: Реализация**

К `require` добавить `const { Confirmations, confirmView } = require('./lib/confirmations');`. После функции `devicesMsg` добавить:

```js
// ---------------------------------------------------------------- подтверждения D-13

const confirmations = new Confirmations();

function broadcastToDevices(obj) {
  const msg = JSON.stringify(obj);
  for (const c of allClients) if (c.deviceId && c.deviceId !== 'local' && c.readyState === 1) c.send(msg);
}

function finishConfirmation(e, allow, reason) {
  broadcastToDevices({ type: 'confirmClosed', confirmId: e.confirmId });
  wsSend(e.requester, { type: 'confirmResult', confirmId: e.confirmId, action: e.action, allow, reason });
  if (allow) e.run();
}

setInterval(() => {
  for (const e of confirmations.sweep()) finishConfirmation(e, false, 'timeout');
}, 5000).unref();

/** Операция владельца: без сопряжённых устройств — флаг интерактивной консоли (P-9),
 *  иначе — только подтверждение на телефоне (D-13). */
function ownerConfirmed(ws, m, action, run) {
  if (pairings.devices.length === 0) {
    if (m.confirmed === true) run();
    else wsSend(ws, { type: 'confirmRequired', action });
    return;
  }
  const e = confirmations.request(action, ws, run);
  if (!e) {
    wsSend(ws, { type: 'error', message: 'Подтверждение этой операции уже ожидается на телефоне' });
    return;
  }
  wsSend(ws, { type: 'confirmPending', confirmId: e.confirmId, action,
    message: 'Подтвердите операцию на сопряжённом телефоне (2 минуты)…' });
  broadcastToDevices(confirmView(e));
}

function sendPairinfo(ws) {
  if (!ws || ws.readyState !== 1) return; // запросивший ушёл — код не выпускаем
  const p = regenPairCode();
  wsSend(ws, {
    type: 'pairinfo',
    host: lanAddress(),
    port: CONFIG.port,
    code: p.code,
    ttlMin: Math.round(PAIR_TTL_MS / 60000),
    fp: FINGERPRINT,
    internet: internetMsg(),
  });
}
```

Ветки `setInternet` и `pairinfo` заменить целиком и добавить `confirm`:

```js
      case 'setInternet':
        if (ws.deviceId !== 'local') break;
        if (m.enabled !== true) { setInternet(false); broadcastInternet(); break; } // выключение безопасно
        ownerConfirmed(ws, m, 'setInternet', () => { setInternet(true); broadcastInternet(); });
        break;
      case 'pairinfo':
        if (ws.deviceId === 'local') ownerConfirmed(ws, m, 'pairinfo', () => sendPairinfo(ws));
        break;
      case 'confirm':
        // подтверждает только сопряжённое устройство, не владелец (D-13)
        if (ws.deviceId && ws.deviceId !== 'local') {
          const e = confirmations.resolve(V.str(m.confirmId, 64));
          if (e) finishConfirmation(e, m.allow === true, m.allow === true ? 'allowed' : 'denied');
        }
        break;
```

В обработчике `connection` после отправки первого `sessions` добавить:

```js
  // устройство, подключившееся после запроса, тоже видит ожидающие подтверждения
  if (ws.deviceId !== 'local') for (const e of confirmations.list()) wsSend(ws, confirmView(e));
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/server-confirm.test.js`
Expected: `# pass 2`.

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bridge/server.js bridge/test/server-confirm.test.js
git commit -m "feat(bridge): owner operations confirmed on a paired phone (D-13)"
```

---

### Task 16: `claude-mobile` — `--agent`, конфликт resume, подтверждения D-13, QR без ручного кода

Правки — относительно `attach.js` после задачи 14 подплана 1.

**Files:**
- Modify: `bridge/attach.js`
- Test: `bridge/test/attach.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const { startBridge, waitUntil, stripAnsi, FAKE_AGENT, DEVICE } = require('./helpers/bridge');

const ATTACH = path.join(__dirname, '..', 'attach.js');
let b;
test.before(async () => {
  b = await startBridge({ devices: [DEVICE], config: {
    defaultAgent: 'echo', agents: { echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [FAKE_AGENT] } },
  } });
});
test.after(() => b.stop());

function run(args) {
  const p = spawn(process.execPath, [ATTACH, ...args], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: b.home }, cwd: b.cwd, windowsHide: true,
  });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  const done = new Promise((r) => p.on('exit', (code) => r(code)));
  return { p, done, out: () => stripAnsi(out), err: () => err };
}

test('--agent starts that agent with raw args; -l shows the agent', { timeout: 60000 }, async () => {
  const a = run(['--agent', 'echo', '--x']);
  await waitUntil(() => /ARGV:\["--x"\]/.test(a.out()), 20000);
  a.p.kill();
  const l = run(['-l']);
  assert.strictEqual(await l.done, 0);
  assert.match(l.out(), /\tEcho\t|\techo\t/);
});

test('--agent without id fails', async () => {
  const a = run(['--agent']);
  assert.strictEqual(await a.done, 1);
  assert.match(a.err(), /id агента/);
});

test('--qr with a paired phone waits for the phone (D-13); QR has no manual code line (P-7)', { timeout: 60000 }, async () => {
  const d = await b.connect(DEVICE.token);
  const atD = d.mark();
  const a = run(['--qr']);
  await waitUntil(() => /сопряжённом телефоне/.test(a.out()), 10000);
  const req = await d.wait((m) => m.type === 'confirmRequest', 5000, atD);
  d.send({ type: 'confirm', confirmId: req.confirmId, allow: true });
  assert.strictEqual(await a.done, 0);
  assert.match(a.out(), /Сопряжение нового устройства/);
  assert.doesNotMatch(a.out(), /ручного ввода/);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/attach.test.js`
Expected: FAIL — `условие не выполнено` (без `--agent` аргументы уходят агенту как есть, `--qr` спрашивает консоль).

- [ ] **Step 3: Справка** — константу `USAGE` заменить целиком:

```js
const USAGE = `claude-mobile — агент через мост (зеркало на телефон)

  claude-mobile [args…]             новая сессия агента по умолчанию в текущем каталоге;
                                    аргументы передаются самому агенту (--resume, --continue…)
  claude-mobile --agent <id> [args…] новая сессия указанного агента (claude, opencode, …)
  claude-mobile -l                  список сессий
  claude-mobile -a [id]             подключиться к сессии (без id — к последней живой)
  claude-mobile --device            доверенные устройства и интернет-доступ
  claude-mobile --qr                QR-код сопряжения нового устройства
  claude-mobile --open              открыть веб-интерфейс моста в браузере (одноразовая ссылка)
  claude-mobile --rotate-token      перевыпустить токен владельца
  claude-mobile -h                  эта справка

Если уже есть сопряжённый телефон, выпуск кода и включение интернет-доступа
подтверждаются на нём; иначе — здесь, в консоли.

Ctrl+\\ — отсоединиться: сессия продолжит жить, вернуться — claude-mobile -a.`;
```

- [ ] **Step 4: Разбор `--agent`** — сразу после блока проверки `TYPOS` добавить:

```js
// D-5: агент новой сессии; остальные аргументы, как и раньше, уходят самому агенту
let agentId = null;
if (args[0] === '--agent') {
  agentId = args[1];
  if (!agentId || agentId.startsWith('-')) {
    console.error('Укажите id агента: claude-mobile --agent <id> [аргументы…]');
    process.exit(1);
  }
  args.splice(0, 2);
}
// последняя операция, требующая подтверждения (D-13) — для повтора с confirmed:true
let lastSensitive = null;
function sendSensitive(obj) { lastSensitive = obj; send(obj); }
```

- [ ] **Step 5: Создание сессии** — функции `doCreate` и `maybeCreate` заменить на:

```js
function doCreate(force) {
  createdAtMs = Date.now();
  const shown = (agentId || 'агент по умолчанию') + (args.length ? ' ' + args.join(' ') : '');
  console.log(`Запускаю: ${shown}  (каталог ${process.cwd()})`);
  send({ type: 'create', cwd: process.cwd(), agent: agentId || undefined, args, force: force === true });
}
```

В ветке `case 'sessions':` вызов `maybeCreate(m.sessions);` заменить на `doCreate(false);`; строку `--qr` (после подплана 1 — `confirmHuman(…, () => send({ type: 'pairinfo', confirmed: true }))`) заменить на `sendSensitive({ type: 'pairinfo' });`; строку вывода `-l` — на:

```js
          console.log(`${s.id}\t${s.alive ? 'жива' : 'завершена'}\t${s.agentName || s.agent || '-'}\t${s.title}\t${s.cwd}`);
```

В ветке `case 'exit':` текст подсказки `claude вышел сразу после старта — возможно, не принял аргументы: claude ${args.join(' ')}` заменить на `агент вышел сразу после старта — возможно, не принял аргументы: ${args.join(' ')}`.

- [ ] **Step 6: Новые сообщения моста** — в `switch (m.type)` добавить ветки:

```js
    case 'createConflict': {
      // D-7: мост сам сравнил каталоги и нашёл живые сессии этого агента
      console.log('⚠ В этом каталоге уже есть живые сессии этого агента:');
      for (const s of m.live) console.log(`    ${s.id}\t${s.title}`);
      console.log('Если ваша беседа ещё открыта в одной из них, resume создаст её КОПИЮ.');
      console.log(`Вернуться в живую сессию: claude-mobile -a ${m.live[m.live.length - 1].id}`);
      if (!process.stdin.isTTY) { die('Отменено (нет интерактивной консоли).', 1); break; }
      const q = readline.createInterface({ input: process.stdin, output: process.stdout });
      q.question('Всё равно продолжить с resume? [y/N]: ', (ans) => {
        q.close();
        if (/^[yд]/i.test(ans.trim())) doCreate(true); else die('Отменено.');
      });
      break;
    }
    case 'confirmRequired':
      // D-13: сопряжённых телефонов нет — подтверждает человек в этой консоли (P-9)
      confirmHuman(m.action === 'pairinfo' ? 'Выпустить код сопряжения нового устройства?' : 'Включить доступ через интернет?',
        () => {
          send({ ...lastSensitive, confirmed: true });
          if (m.action === 'setInternet') setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
        });
      break;
    case 'confirmPending':
      console.log(m.message || 'Подтвердите операцию на сопряжённом телефоне…');
      break;
    case 'confirmResult':
      if (!m.allow) {
        die(m.reason === 'timeout' ? 'Время подтверждения истекло.' : 'Отклонено на телефоне.', 1);
      } else if (m.action === 'setInternet') {
        console.log('Подтверждено на телефоне.');
        setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
      }
      break;
    case 'error':
      if (!sid) die('Мост: ' + m.message, 1);
      break;
```

- [ ] **Step 7: QR без ручного кода (P-7)** — ветку `case 'pairinfo':` заменить целиком:

```js
    case 'pairinfo': {
      const qrcode = require(path.join(__dirname, 'node_modules', 'qrcode-terminal'));
      console.log('\nСопряжение нового устройства с Claude Bridge');
      console.log(`Адрес моста: ${m.host}:${m.port}`);
      if (m.internet) console.log(`Доступ через интернет: ${fmtInet(m.internet)}`);
      console.log(`Отсканируйте QR в приложении (действует ${m.ttlMin || 10} минут)\n`);
      qrcode.generate(JSON.stringify({ cb: 1, host: m.host, port: m.port, code: m.code, fp: m.fp }),
        { small: true }, (q) => { console.log(q); process.exit(0); });
      break;
    }
```

- [ ] **Step 8: Интернет из меню устройств** — в `deviceTui` ветку `if (/^[iи]$/i.test(ans)) { … }` заменить целиком:

```js
    if (/^[iи]$/i.test(ans)) {
      const enable = !(inetState && inetState.enabled);
      rl.close(); // подтверждение (консоль или телефон) не должно делить stdin с меню
      rl = null;
      sendSensitive({ type: 'setInternet', enabled: enable });
      if (!enable) setTimeout(() => { send({ type: 'internet' }); send({ type: 'devices' }); }, 400);
      return;
    }
```

- [ ] **Step 9: Тесты проходят**

Run: `cd bridge && node --test test/attach.test.js`
Expected: `# pass 3`.

Run: `cd bridge && npm test`
Expected: `# fail 0`.

- [ ] **Step 10: Commit**

```bash
git add bridge/attach.js bridge/test/attach.test.js
git commit -m "feat(bridge): claude-mobile --agent, bridge-side resume conflict, phone confirmations, QR-only text (D-5, D-7, D-13, P-7)"
```

---

### Task 17: Инструменты проверки и ручная сквозная проверка на реальных агентах

**Files:**
- Create: `bridge/tools/hook-settings.js`, `bridge/tools/ws-watch.js`
- Test: `bridge/test/hook-settings.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookSettings } = require('../tools/hook-settings');

test('exec-form hook for every event the claude adapter uses', () => {
  const s = hookSettings('C:\\b\\bridge-hook.js');
  assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['Notification', 'PermissionDenied', 'PermissionRequest',
    'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.deepStrictEqual(s.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['C:\\b\\bridge-hook.js'] }] }]);
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'node', args: ['C:\\b\\bridge-hook.js'] }] }]);
});

test('CLI prints JSON with the absolute hook path', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'hook-settings.js')], { encoding: 'utf8' });
  const s = JSON.parse(r.stdout);
  assert.strictEqual(s.hooks.Stop[0].hooks[0].args[0], path.join(__dirname, '..', 'hooks', 'bridge-hook.js'));
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd bridge && node --test test/hook-settings.test.js`
Expected: FAIL — `Cannot find module '../tools/hook-settings'`.

- [ ] **Step 3: Реализация** — `bridge/tools/hook-settings.js`:

```js
#!/usr/bin/env node
'use strict';
// Фрагмент настроек Claude Code с хуком моста в exec-форме (P-4, P-6; живая проба:
// строковая форма идёт через Git Bash) для событий, которые использует адаптер claude.
// Ручная проверка: claude-mobile --settings <файл>; установщик (подплан 4) сливает его
// с %USERPROFILE%\.claude\settings.json.
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'bridge-hook.js');
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
const OTHER_EVENTS = ['Notification', 'UserPromptSubmit', 'Stop'];

function hookSettings(hookPath = HOOK) {
  const entry = { type: 'command', command: 'node', args: [hookPath] };
  const hooks = {};
  for (const e of TOOL_EVENTS) hooks[e] = [{ matcher: '*', hooks: [entry] }];
  for (const e of OTHER_EVENTS) hooks[e] = [{ hooks: [entry] }];
  return { hooks };
}

if (require.main === module) process.stdout.write(JSON.stringify(hookSettings(), null, 2) + '\n');

module.exports = { hookSettings, TOOL_EVENTS, OTHER_EVENTS };
```

`bridge/tools/ws-watch.js`:

```js
#!/usr/bin/env node
'use strict';
// Отладка протокола D-4/D-5 от имени владельца: печатает notify/status/requestClosed/replyResult.
// Ввод: номер варианта — ответить на последний запрос; «new <agent> [опция,опция]» — новая
// сессия агента в текущем каталоге с опциями (например: new opencode askShell).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { ensureDataDirs } = require('../lib/datadir');
const { pinnedTlsOptions } = require('../lib/cert');

const DATA = ensureDataDirs();
const port = JSON.parse(fs.readFileSync(DATA.config, 'utf8')).port || 8790;
const der = fs.readFileSync(path.join(DATA.certs, 'bridge.cer'));
const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
  ...pinnedTlsOptions(new crypto.X509Certificate(der).toString(), crypto.createHash('sha256').update(der).digest('hex')),
  headers: { Authorization: 'Bearer ' + fs.readFileSync(DATA.ownerToken, 'utf8').trim() },
});
let last = null;
const time = () => new Date().toLocaleTimeString('ru-RU');

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'notify') {
    console.log(`${time()} [notify ${m.event}] ${m.id} ${m.message}`);
    if (m.requestId) { last = m; m.choices.forEach((c, i) => console.log(`    ${i + 1}) ${c.label} (${c.id})`)); }
  } else if (['status', 'requestClosed', 'replyResult', 'created', 'createConflict', 'error'].includes(m.type)) {
    console.log(`${time()} [${m.type}] ${JSON.stringify(m)}`);
  } else if (m.type === 'sessions') {
    console.log(`${time()} [sessions] ${m.sessions.map((s) => `${s.id}:${s.agent}:${s.status}`).join(' ') || '—'}` +
      `  агенты: ${(m.agents || []).map((a) => a.id).join(', ')}`);
  }
});
ws.on('error', (e) => { console.error('Мост недоступен: ' + e.message); process.exit(1); });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const l = line.trim();
  const nm = l.match(/^new\s+(\S+)(?:\s+(\S+))?$/);
  if (nm) {
    const options = {};
    for (const o of (nm[2] || '').split(',').filter(Boolean)) options[o] = true;
    ws.send(JSON.stringify({ type: 'create', agent: nm[1], options, cwd: process.cwd() }));
    return;
  }
  const n = parseInt(l, 10);
  if (!last || !(n >= 1 && n <= last.choices.length)) { console.log('нет активного запроса или неверный номер'); return; }
  ws.send(JSON.stringify({ type: 'reply', id: last.id, requestId: last.requestId, decision: last.choices[n - 1].id }));
});
```

- [ ] **Step 4: Тесты проходят**

Run: `cd bridge && node --test test/hook-settings.test.js`
Expected: `# pass 2`.

- [ ] **Step 5: Ручная проверка — Claude Code** (мост с реальным каталогом данных; токены — один короткий запрос)

1. Окно 1: `cd bridge && node server.js` → в логе строка `Агенты: claude, opencode` (или те, что установлены).
2. Окно 2: `cd bridge && node tools/ws-watch.js` → `[sessions] —  агенты: claude, opencode`.
3. Окно 3: `cd bridge && node tools/hook-settings.js > %TEMP%\cb-hooks.json`, затем в каталоге любого проекта из `projects`: `bridge\claude-mobile.cmd --agent claude --settings %TEMP%\cb-hooks.json --model haiku`. Хуки подключаются только к этой сессии через `--settings`; пользовательский `settings.json` не меняется (это задача установщика, подплан 4).
4. В Claude: `Run this exact shell command with the Bash tool and nothing else: echo cb-e2e`.
Expected в окне 2: `[notify request] sN-… Claude просит разрешение — Bash: echo cb-e2e` и варианты `1) Да 2) Всегда 3) Нет` — сразу (если `PermissionRequest` работает, задача 2) или через ~8 с; `[status] … waiting`.
5. В окне 2 ввести `1`. Expected: `[replyResult] … "ok":true`, `[requestClosed] …`; Claude выполняет команду; затем `[status] … idle` и `[notify done] … Claude завершил ответ`.
6. Повторить шаг 4, но ответить `Esc` в окне 3 (на ПК). Expected: `[requestClosed]` сразу после нажатия; ввод `1` в окне 2 после этого — `нет активного запроса…` или `[replyResult] … "error":"stale"`; в поле ввода Claude ничего не попадает.

- [ ] **Step 6: Ручная проверка — opencode** (токены — один короткий запрос)

1. В окне 2 (в каталоге проекта): `new opencode askShell`. Expected: `[created] …`; при остановленном сервисе opencode мост сам выполняет `opencode service start` (до 20 с).
2. Окно 3: `bridge\claude-mobile.cmd -a <id из created>` → TUI opencode этой сессии; попросить: `run the shell command: echo cb-e2e`.
Expected в окне 2: `[notify request] … opencode просит разрешение — shell: echo cb-e2e` с вариантами.
3. Ввести `1` в окне 2. Expected: `[replyResult] … "ok":true`, команда выполнена в TUI, затем `[notify done] … opencode завершил ответ`.
4. Повторить запрос, ответить в TUI (окно 3). Expected: `[requestClosed]` по событию `permission.replied`.
5. Окно 1: Ctrl+C (мост остановлен), в TUI снова попросить команду, запустить мост заново и `node tools/ws-watch.js`. Expected: после рестарта приходит `[notify request]` для запроса, появившегося без моста (ресинхронизация).

Результаты шагов 5–6 (фактические тексты и задержки) — в отчёт по задаче.

- [ ] **Step 7: Commit**

```bash
git add bridge/tools/hook-settings.js bridge/tools/ws-watch.js bridge/test/hook-settings.test.js
git commit -m "chore(bridge): hook settings generator and ws-watch debug client"
```

---

## Самопроверка плана

**Покрытие решений:**

| Решение | Задачи |
|---|---|
| D-2 / D-12 (opencode через фоновый сервис, v2 API, `--server/--session`, SSE, ответы через API) | 5, 6, 7, 8, 13, 17 |
| D-3 + P-2 (адаптеры `claude`/`opencode`/`generic`, контракт) | 3, 4, 7 (контракт — JSDoc в `agents/index.js`) |
| D-4 (`notify{requestId, choices}` → `reply{requestId, decision}`, защита от устаревших) | 4, 7, 9, 11, 13 |
| D-5 + P-3 (агент на сессию, `agents` в `sessions`, телефон шлёт только id) | 3, 10, 16 |
| D-7 (сравнение путей только на мосту; признак конфликта resume) | 12, 16 |
| D-10 (`scroll` объявляет адаптер, передаётся в `sessions`) | 3, 4, 7, 10 |
| D-11 (секрет keeper'а; env агента = childEnv без секрета) | 10 (`createSession` сохраняет схему подплана 1) |
| D-13 (подтверждение на сопряжённом телефоне; консоль — только без устройств) | 14, 15, 16 |
| D-14 (опция «Спрашивать разрешение на команды» → `permissions shell:ask`) | 7, 13 |
| P-6 (хук exec-формой; регистрация — установщик) | 17 (`hook-settings.js`; установщик — подплан 4) |
| P-7 (QR-only — текст консоли) | 16 (приложение — подплан 3) |
| L-8 (очистка `title`) | 10 (`V.cleanTitle` в `create`) |
| Живая проба Claude Code 2.1.284 (`claude.exe` напрямую, `1/2/Esc`, опоздание `Notification`, нет хуков после отказа, `agent_id`) | 1, 2, 4, 11 |
| Живая проба opencode v2.1.4 (`service.json`, Basic, `ses_…`, `OPENCODE_PASSWORD`, SSE без `event:`, 204/404, `session.execution.*`) | 5, 6, 7, 8 |

**Проверено при написании плана:** код и тесты задач 1, 3–9, 14 и `hook-settings` задачи 17 (плюс `web/lib.js` подплана 3) извлечены из этого документа в копию `bridge/` и прогнаны: 41 pass, 1 skipped (live), 0 fail. Интеграционные задачи 10–13, 15, 16 зависят от `server.js`/`attach.js` после подплана 1 и не прогонялись.

**Допущения, которые нужно проверить (и где):**

1. Хук `PermissionRequest` в 2.1.284 приходит до показа диалога с полями `tool_name`/`tool_input` (строки есть в `claude.exe`, поведение не проверено) — задача 2; при отрицательном результате работает запасной путь через `Notification`.
2. `PermissionDenied` срабатывает на отказ пользователя (`Esc`) — задача 2; если нет, запрос всё равно закрывается по вводу в PTY.
3. `PreToolUse` следующего инструмента не приходит раньше `PermissionRequest` текущего при параллельных вызовах инструментов — не проверено; при нарушении запрос закроется раньше времени (ответ получит отказ `stale`, вреда нет).
4. Окно 3 с для «запоздавшего» `Notification` достаточно — по пробе уведомление идёт через 7–8 с после диалога, а не после ответа.
5. `GET /api/session/{id}/permission` возвращает `{data:[…]}` с объектами формата `permission.asked` — задача 8 (live).
6. `permission.replied` и `session.execution.*` несут `data.sessionID`; `permission.replied` — `data.requestID` — задача 17, шаг 6.
7. `opencode service start` возвращает управление быстро и пишет `service.json` (ожидание до 20 с) — задачи 8, 17.
8. URL сервиса — `http://127.0.0.1:<порт>` (https с самоподписанным сертификатом клиент не поддерживает) — задача 8.
9. ~~Фейковый агент в ConPTY получает посимвольный ввод в raw-режиме~~ — проверено при написании плана (node-pty 1.1, системный ConPTY): `1` и `Esc` доходят как `ECHO:"1"` и `ECHO:"\u001b"`; отчёт фокуса `\x1b[I`, записанный в ConPTY, приложению не доставляется (поглощается).
10. Отчёты фокуса `CSI I/O` от xterm.js не закрывают запрос; нажатия мыши закрывают — правило `PASSIVE_INPUT` в задаче 4.
11. Пароль сервиса opencode не меняется между созданием сессии и её восстановлением после рестарта моста; иначе TUI теряет связь с сервисом (не обрабатывается).

**Отклонения от текста решений, требующие подтверждения контроллером:** формат контракта (имена WS-сообщений `reply`/`replyResult`/`requestClosed`/`createConflict`/`confirmRequest`/`confirm`/`confirmPending`/`confirmRequired`/`confirmResult`/`confirmClosed`, `notify.event` ∈ `request|done|info`, `choices: [{id,label}]`), формат «готового признака» D-7 (ответ `createConflict` на `create` вместо поля в `sessions`), изменения интерфейса P-2 (асинхронный `spawnSpec`, без `helpers`, `onInput`, `isResumeLike`, `notify.done`), формат конфига (`defaultAgent`, `agents.{id}.{type,name,command,prefixArgs,args,scroll,serviceFile}`), отсутствие раскладки клавиш `generic` (без источника событий кнопок не бывает), D-13 «сопряжение нового устройства» покрыто подтверждением выпуска кода — перечислены в отчёте контроллеру.
