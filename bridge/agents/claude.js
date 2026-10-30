'use strict';
// Адаптер Claude Code (D-3, P-2, D-4, D-15 п. 9). Факты — «Живая проба Claude Code 2.1.284»
// в реестре решений, включая пробу PermissionRequest (подплан 2, задача 2):
// PermissionRequest приходит вместе с диалогом и не задерживает его; Notification
// [permission_prompt] — через ~6–8 с или не приходит; после отказа (Esc) хуков нет.
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
// Notification [permission_prompt] опаздывает на ~6–8 с: пришедшее сразу после закрытия
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
      const o = options || {};
      const args = [...prefixArgs];
      if (o.resume) args.push('--resume');
      if (o.skipPermissions) args.push('--dangerously-skip-permissions');
      return { command, args: [...args, ...(rawArgs || [])], env: {}, state: {} };
    },

    isResumeLike({ options, rawArgs }) {
      return (options || {}).resume === true || (rawArgs || []).some((a) => RESUME_FLAGS.has(a));
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
      // Esc — отказ; «4» — No в диалоге с пунктом auto mode (в диалоге из 3 пунктов No — «3»,
      // но там же «3» значит «да + auto mode» в 4-пунктовом — по цифре не различить)
      const rejectish = data === '\x1b' || data === '4';
      return [...closeOpen(r), { kind: 'status', status: rejectish ? 'idle' : 'working' }];
    },

    async reply(session, request, decision, io) {
      const r = rt(session);
      if (!request || r.open !== request.requestId || !Object.prototype.hasOwnProperty.call(KEYS, decision)) {
        const requestId = request && request.requestId;
        return { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId }] };
      }
      io.write(KEYS[decision]);
      return { ok: true, events: [...closeOpen(r), { kind: 'status', status: decision === 'reject' ? 'idle' : 'working' }] };
    },
  };
}

module.exports = { create };
