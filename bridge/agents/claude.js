'use strict';
// Адаптер Claude Code (D-3, P-2, D-4, D-15 п. 9, D-19). Факты — «Живая проба Claude Code 2.1.284»
// в реестре решений, включая пробу PermissionRequest (подплан 2, задача 2):
// PermissionRequest приходит вместе с диалогом и не задерживает его, без tool_use_id;
// Notification [permission_prompt] — через ~6–8 с или не приходит; после отказа (Esc) хуков нет.
// Очередь параллельных запросов (D-19 п. 3) проверяется вживую в задаче 17.
const crypto = require('crypto');
const { npmShimExe } = require('../lib/agent-exe');
const { findOnPath } = require('../lib/which');
const { displayText } = require('../lib/display-text');

const EXE_REL = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];
const OPTIONS = Object.freeze([
  Object.freeze({ id: 'resume', label: 'Продолжить беседу (--resume)', type: 'bool' }),
  Object.freeze({ id: 'skipPermissions', label: 'Без запросов разрешений (--dangerously-skip-permissions)', type: 'bool' }),
]);
const RESUME_FLAGS = new Set(['--resume', '-r', '--continue', '-c']);
const ONCE = { id: 'once', label: 'Да' };
const ALWAYS = { id: 'always', label: 'Всегда' };
const REJECT = { id: 'reject', label: 'Нет' };
// диалог разрешения: 1 — да, 2 — всегда (текст зависит от команды), Esc — отказ; без Enter
const KEYS = { once: '1', always: '2', reject: '\x1b' };
// D-19 п. 4: кнопки — только для диалогов разрешения этих инструментов; в других диалогах
// (AskUserQuestion, ExitPlanMode) клавиши 1/2 значат другое
const BUTTON_TOOLS = new Set(['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep', 'Task']);
const toolHasButtons = (n) => typeof n === 'string' && (BUTTON_TOOLS.has(n) || /^mcp__\S/.test(n));
// Notification [permission_prompt] опаздывает на ~6–8 с: пришедшее в течение этого окна
// после активного ввода относится к уже отвеченному диалогу
const LATE_NOTIFICATION_MS = 8000;
const ANSWERED_MAX = 16;

// D-19 п. 1, M-4: ввод, который не является ответом на диалог. Ввод пассивен, только если
// целиком состоит из таких последовательностей. Мышь: колесо (бит 64) и движение (бит 32) —
// пассивны, нажатия кнопок — ответ.
const passiveButton = (b) => Number.isInteger(b) && b >= 0 && ((b & 64) !== 0 || (b & 32) !== 0);
const PASSIVE_TOKENS = [
  [/\x1b\[[IO]/y],                                   // отчёт фокуса (?1004h)
  [/\x1b\[\d+;\d+R/y],                               // CPR
  [/\x1b\[[?>][\d;]*c/y],                            // DA1/DA2
  [/\x1b\[\??[\d;]+\$y/y],                           // DECRPM
  [/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y],            // OSC-ответ (цвета и т.п.)
  [/\x1bP[^\x1b]*\x1b\\/y],                          // DCS-ответ (XTVERSION, DECRQSS)
  [/\x1b\[\?\d*u/y],                                 // ответ kitty keyboard
  [/\x1b\[<(\d+);\d+;\d+[Mm]/y, (m) => passiveButton(Number(m[1]))],          // SGR-мышь
  [/\x1b\[M([\s\S])[\s\S]{2}/y, (m) => passiveButton(m[1].charCodeAt(0) - 32)], // X10-мышь
  [/\x1b\[(\d+);\d+;\d+M/y, (m) => passiveButton(Number(m[1]) - 32)],          // urxvt-мышь
];

function isPassiveInput(data) {
  let i = 0;
  next: while (i < data.length) {
    for (const [re, ok] of PASSIVE_TOKENS) {
      re.lastIndex = i;
      const m = re.exec(data);
      if (m && (!ok || ok(m))) { i = re.lastIndex; continue next; }
    }
    return false;
  }
  return data.length > 0;
}

function describeTool(p) {
  const name = typeof p.tool_name === 'string' && p.tool_name ? p.tool_name : 'инструмент';
  const ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const detail = [ti.command, ti.file_path, ti.url, ti.pattern, ti.path].find((v) => typeof v === 'string' && v) || '';
  // D-19 п. 2: невидимые/bidi символы и переводы строк не прячут хвост команды
  return displayText(name + (detail ? ': ' + detail : ''));
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** Ключ вызова инструмента: PermissionRequest не несёт tool_use_id — сравниваем имя и ввод. */
function callKey(p) {
  return typeof p.tool_name === 'string' && p.tool_name ? p.tool_name + '\u0000' + stable(p.tool_input) : null;
}

function rt(session) {
  if (!session.runtime || typeof session.runtime !== 'object') session.runtime = {};
  if (!session.runtime.claude) {
    session.runtime.claude = { open: null, queue: [], answered: [], sawPermissionRequest: false, lastActiveAt: -Infinity };
  }
  return session.runtime.claude;
}

const status = (s) => ({ kind: 'status', status: s });

function create(id, cfg, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const findExe = opts.findExe || findClaudeExe;
  const command = typeof cfg.command === 'string' && cfg.command ? cfg.command : findExe();
  const prefixArgs = Array.isArray(cfg.prefixArgs) ? cfg.prefixArgs.filter((a) => typeof a === 'string') : [];

  function show(r, item) {
    r.open = { ...item, id: 'req_' + crypto.randomBytes(8).toString('hex') };
    return [
      { kind: 'request', requestId: r.open.id, message: item.message, choices: item.choices.map((c) => ({ ...c })) },
      status('waiting'),
    ];
  }

  /**
   * Закрыть открытый запрос и показать следующий из очереди (D-19 п. 3).
   * answered — запрос отвечен (его PostToolUse не должен закрыть следующий);
   * dropQueue — ход прерван/закончен, ожидающих диалогов больше нет;
   * idleStatus — статус, если открытых запросов не осталось.
   */
  function finish(r, { answered = false, dropQueue = false, idleStatus = null } = {}) {
    const out = [];
    if (r.open) {
      out.push({ kind: 'requestClosed', requestId: r.open.id });
      if (answered && r.open.key) {
        r.answered.push(r.open.key);
        if (r.answered.length > ANSWERED_MAX) r.answered.shift();
      }
      r.open = null;
    }
    if (dropQueue) r.queue = [];
    if (r.queue.length) return out.concat(show(r, r.queue.shift()));
    if (idleStatus) out.push(status(idleStatus));
    return out;
  }

  function onHook(session, p) {
    if (!p || typeof p !== 'object') return [];
    const r = rt(session);
    const sub = typeof p.agent_id === 'string' && p.agent_id !== '';
    switch (p.hook_event_name) {
      case 'PermissionRequest': {
        // диалог показывается и для субагента — запрос открываем независимо от agent_id
        r.sawPermissionRequest = true;
        if (!toolHasButtons(p.tool_name)) {
          return [{ kind: 'notify', message: 'Claude ждёт ответа в терминале — ' + describeTool(p) }];
        }
        const withAlways = Array.isArray(p.permission_suggestions) && p.permission_suggestions.length > 0;
        const item = {
          message: 'Claude просит разрешение — ' + describeTool(p),
          choices: withAlways ? [ONCE, ALWAYS, REJECT] : [ONCE, REJECT],
          key: callKey(p),
        };
        if (r.open) { r.queue.push(item); return []; }
        return show(r, item);
      }
      case 'Notification': {
        const msg = typeof p.message === 'string' && p.message ? displayText(p.message) : '';
        if (p.notification_type === 'permission_prompt') {
          if (r.open || now() - r.lastActiveAt < LATE_NOTIFICATION_MS) return [];
          if (r.sawPermissionRequest) return [{ kind: 'notify', message: msg || 'Claude просит разрешение' }];
          // запасной путь: хук PermissionRequest не зарегистрирован
          return show(r, { message: msg || 'Claude просит разрешение', choices: [ONCE, REJECT], key: null });
        }
        return [{ kind: 'notify', message: msg || 'Claude Code ждёт ввода' }];
      }
      case 'UserPromptSubmit':
        if (sub) return [];
        r.answered = [];
        return finish(r, { dropQueue: true, idleStatus: 'working' });
      case 'PreToolUse':
        // без tool_use_id не сопоставить с открытым диалогом — открытый запрос не трогаем
        if (sub || r.open) return [];
        return [status('working')];
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (sub) return [];
        const key = callKey(p);
        const i = key ? r.answered.indexOf(key) : -1;
        if (i >= 0) { // завершился уже отвеченный вызов — открытый диалог относится к другому
          r.answered.splice(i, 1);
          return r.open ? [] : [status('working')];
        }
        return finish(r, { idleStatus: 'working' });
      }
      case 'PermissionDenied':
        if (sub) return [];
        return finish(r);
      case 'Stop':
        if (sub) return [];
        r.answered = [];
        return finish(r, { dropQueue: true }).concat(status('idle'),
          { kind: 'notify', message: 'Claude завершил ответ', done: true });
      default:
        return [];
    }
  }

  function onInput(session, data) {
    if (typeof data !== 'string' || data === '' || isPassiveInput(data)) return [];
    const r = rt(session);
    r.lastActiveAt = now();
    if (!r.open) return [];
    // Esc — отказ (ход прерывается, остальные диалоги исчезают); «4» — No в диалоге с пунктом
    // auto mode. «3» в 3-пунктовом диалоге (= No) оставляет working — принято (поправка 8 плана)
    const reject = data === '\x1b' || data === '4';
    return finish(r, { answered: true, dropQueue: reject, idleStatus: reject ? 'idle' : 'working' });
  }

  async function reply(session, request, decision, io) {
    const r = rt(session);
    const requestId = request && typeof request === 'object' ? request.requestId : undefined;
    if (!r.open || r.open.id !== requestId) {
      return { ok: false, stale: true, events: requestId ? [{ kind: 'requestClosed', requestId }] : [] };
    }
    if (!r.open.choices.some((c) => c.id === decision)) return { ok: false, events: [] };
    let written = false;
    try { written = io.write(KEYS[decision]); } catch { written = false; }
    // D-19 п. 6: клавиша не дошла — запрос остаётся открытым
    if (!written) return { ok: false, error: 'failed', events: [] };
    r.lastActiveAt = now();
    const reject = decision === 'reject';
    return { ok: true, events: finish(r, { answered: true, dropQueue: reject, idleStatus: reject ? 'idle' : 'working' }) };
  }

  // адаптер не бросает: payload и ввод — недоверенные
  const safe = (fn) => (...a) => { try { return fn(...a); } catch { return []; } };

  return {
    id,
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name.slice(0, 40) : 'Claude Code',
    command,
    options: OPTIONS,
    scroll: 'wheel',
    events: 'hook',
    available: () => !!command && !!findOnPath(command),

    async spawnSpec({ options, rawArgs }) {
      const o = options || {};
      const args = [...prefixArgs];
      if (o.resume) args.push('--resume');
      if (o.skipPermissions) args.push('--dangerously-skip-permissions');
      return { command, args: [...args, ...(rawArgs || [])], env: {}, state: {} };
    },

    isResumeLike({ options, rawArgs }) {
      return (options || {}).resume === true || (rawArgs || []).some((a) => RESUME_FLAGS.has(a));
    },

    onHook: safe(onHook),
    onInput: safe(onInput),
    async reply(session, request, decision, io) {
      try { return await reply(session, request, decision, io); } catch { return { ok: false, error: 'failed', events: [] }; }
    },
  };
}

/** npm-шим claude.cmd → его claude.exe; иначе claude.exe из PATH (нативный установщик, D-19 п. 5). */
function findClaudeExe() {
  return npmShimExe('claude', EXE_REL) || findOnPath('claude.exe');
}

module.exports = { create, findClaudeExe };
