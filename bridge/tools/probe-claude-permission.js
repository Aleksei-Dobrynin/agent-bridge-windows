#!/usr/bin/env node
'use strict';
// Живая проба (подплан 2, задача 2): когда приходит хук PermissionRequest относительно
// диалога разрешения, задерживает ли он диалог, приходит ли Notification [permission_prompt],
// что приходит после Esc. Запускает claude.exe в ConPTY в каталоге пробы с хуками в
// проектном <каталог>\.claude\settings.json (только для пробы; в работе хуки ставит
// установщик в пользовательский settings.json — P-6). Пользовательский settings.json не трогает.
// Тратит один короткий запрос к модели haiku.
// Запуск: cd bridge && node tools/probe-claude-permission.js [каталог пробы]
// (по умолчанию — новый временный каталог; каталог должен быть пустым или отсутствовать)
// Побочные эффекты вне каталога пробы (их оставляет сам Claude Code): отметка доверия каталогу
// в %USERPROFILE%\.claude.json, беседа в %USERPROFILE%\.claude\projects\<закодированный путь>\,
// scratchpad в %TEMP%\claude\<закодированный путь>\. После пробы их можно удалить вручную.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));
const { npmShimExe } = require('../lib/agent-exe');

const exe = npmShimExe('claude', ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
if (!exe) { console.error('claude.exe не найден рядом с claude.cmd'); process.exit(1); }

let dir;
if (process.argv[2]) {
  fs.mkdirSync(process.argv[2], { recursive: true });
  if (fs.readdirSync(process.argv[2]).length) { console.error('каталог пробы не пуст'); process.exit(1); }
  dir = fs.realpathSync.native(process.argv[2]);
} else {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-probe-')));
}
const log = path.join(dir, 'hooks.jsonl');
const logger = path.join(dir, 'logger.js');
// PermissionRequest-хук нарочно спит HOLD_MS: если диалог появится только после конца хука —
// хук задерживает диалог (вопрос «б»); ts — старт процесса хука, t — запись в журнал.
const HOLD_MS = 2500;
fs.writeFileSync(logger,
  "const ts=Date.now();const fs=require('fs');let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{" +
  "let p={};try{p=JSON.parse(b)}catch{}" +
  "const w=()=>fs.appendFileSync(" + JSON.stringify(log) + ",JSON.stringify({ts,t:Date.now(),e:p.hook_event_name," +
  "nt:p.notification_type||null,tool:p.tool_name||null,agent:p.agent_id||null,msg:p.message||null," +
  "keys:Object.keys(p),payload:p})+'\\n');" +
  `if(p.hook_event_name==='PermissionRequest')setTimeout(w,${HOLD_MS});else w();});`);

const entry = [{ type: 'command', command: process.execPath, args: [logger] }];
const withMatcher = [{ matcher: '*', hooks: entry }];
const plain = [{ hooks: entry }];
fs.mkdirSync(path.join(dir, '.claude'));
fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
  // пользовательские настройки не грузятся (--setting-sources); fullscreen — как у автора
  permissions: { defaultMode: 'default' },
  tui: 'fullscreen',
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
// fullscreen-TUI рисует позиционированием курсора: CUF/CUP → пробел/перевод строки
const strip = (s) => s
  .replace(/\x1b\[\d*C/g, ' ')
  .replace(/\x1b\[\d*(?:;\d*)?H/g, '\n')
  .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b[@-_]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// команда с записью (echo может быть разрешён целиком или считаться безопасной)
const PROMPT = 'Run this exact shell command with the Bash tool and nothing else: touch cb-probe.txt';
// --setting-sources project,local: без пользовательских хуков SessionStart, allow-списка и
// defaultMode (в первой попытке хук SessionStart увёл модель от команды); без MCP и навыков —
// меньше токенов. Хуки пробы — только из проектного settings.json.
const ARGS = ['--model', 'haiku', '--permission-mode', 'default', '--setting-sources', 'project,local',
  '--strict-mcp-config', '--disable-slash-commands'];
const term = pty.spawn(exe, ARGS, {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: dir, env,
});
term.onExit(({ exitCode }) => { mark(`claude.exe завершился (код ${exitCode})`); setTimeout(finish, 1000); });
const raw = fs.openSync(path.join(dir, 'screen.raw'), 'w');
let screen = '';
term.onData((d) => {
  if (finished) return;
  fs.writeSync(raw, d);
  screen += strip(d);
  if (screen.length > 200000) screen = screen.slice(-100000);
});
async function waitScreen(re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(screen)) return true; await sleep(100); }
  return false;
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  const pid = term.pid;
  try { term.kill(); } catch { /* уже завершён */ }
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* уже завершён */ }
  fs.closeSync(raw);
  const events = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  console.log('\n=== Хуки (время от старта: запуск процесса хука → запись) ===');
  for (const e of events) {
    console.log(`${sec(e.ts)}→${sec(e.t)}  ${e.e}${e.nt ? ' [' + e.nt + ']' : ''}${e.tool ? ' tool=' + e.tool : ''}` +
      `${e.agent ? ' agent_id' : ''}${e.msg ? ' msg=' + JSON.stringify(e.msg) : ''}  keys=${e.keys.join(',')}`);
  }
  for (const e of events.filter((x) => x.e === 'PermissionRequest' || x.e === 'PermissionDenied')) {
    console.log(`\n${e.e} payload: ${JSON.stringify(e.payload)}`);
  }
  console.log('\n=== Отметки ===');
  for (const m of marks) console.log(`${sec(m.t)}  ${m.what}`);
  console.log(`\nclaude.exe PID ${pid} завершён; каталог пробы: ${dir}`);
  setTimeout(() => process.exit(0), 500);
}
setTimeout(finish, 180000).unref();

(async () => {
  if (await waitScreen(/trust/i, 15000)) {
    // в 2.1.284 по умолчанию выбран «No, exit» — сначала стрелка вниз на «Yes, I trust this folder»
    await sleep(500);
    mark('диалог доверия каталогу — ↓ + Enter');
    screen = '';
    term.write('\x1b[B');
    await sleep(300);
    term.write('\r');
  }
  await sleep(4000);
  mark('отправляю запрос');
  screen = '';
  term.write(PROMPT);
  await sleep(300);
  term.write('\r');
  if (!(await waitScreen(/Do\s*you\s*want/i, 90000))) { mark('диалог разрешения не появился за 90 с'); finish(); return; }
  mark('диалог разрешения на экране');
  await sleep(12000); // ждём Notification [permission_prompt] (~7–8 с по прошлой пробе)
  mark('нажимаю Esc (отказ)');
  term.write('\x1b');
  await sleep(6000);
  finish();
})();
