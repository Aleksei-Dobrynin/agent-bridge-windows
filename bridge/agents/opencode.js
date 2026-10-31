'use strict';
// Адаптер opencode v2 (D-2, D-12, D-14). Сессия создаётся через API фонового сервиса,
// keeper запускает TUI `opencode.exe --server <url> --session <id>` с OPENCODE_PASSWORD
// в окружении (keeper наследует childEnv моста), события — SSE, ответы — через API.
const { spawn } = require('child_process');
const { npmShimExe } = require('../lib/agent-exe');
const { findOnPath } = require('../lib/which');
const { cleanText, clipMiddle, displayText } = require('../lib/display-text');
const { OpencodeClient } = require('./opencode-client');

const EXE_REL = ['node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'];
const OPTIONS = [{ id: 'askShell', label: 'Спрашивать разрешение на команды', type: 'bool' }];
const ASK_SHELL = [{ action: 'shell', resource: '*', effect: 'ask' }];
const DECISIONS = new Set(['once', 'always', 'reject']);
const MAX_CLOSED = 256;
// D-19 п. 2 (общий санитайзер): длинное значение — «начало…конец (N симв.)»
const ACTION_CLIP = { max: 40, head: 24, tail: 10 };
const MESSAGE_CLIP = { max: 120, head: 60, tail: 40 };

function describe(p) {
  const action = (typeof p.action === 'string' && displayText(p.action, ACTION_CLIP)) || 'действие';
  const res = Array.isArray(p.resources) ? p.resources.filter((x) => typeof x === 'string').map(cleanText).filter(Boolean) : [];
  let text = `opencode просит разрешение — ${action}`;
  if (res.length) text += ': ' + clipMiddle(res.join(', '));
  // необязательный текст запроса для человека (в v2.1.4 его нет, D-12 «Живая проба»)
  const message = typeof p.message === 'string' ? displayText(p.message, MESSAGE_CLIP) : '';
  if (message) text += ' — ' + message;
  return text;
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
  const now = opts.now || (() => performance.now());
  const command = typeof cfg.command === 'string' && cfg.command ? cfg.command : findExe();
  const prefixArgs = Array.isArray(cfg.prefixArgs) ? cfg.prefixArgs.filter((a) => typeof a === 'string') : [];
  const client = opts.opencodeClient || new OpencodeClient({
    file: typeof cfg.serviceFile === 'string' && cfg.serviceFile ? cfg.serviceFile : undefined,
    start: () => {
      if (!command) return;
      try {
        const child = spawn(command, [...prefixArgs, 'service', 'start'], { detached: true, windowsHide: true, stdio: 'ignore' });
        child.on('error', (e) => console.error('[opencode] opencode service start:', e.message));
        child.unref();
      } catch (e) {
        console.error('[opencode] opencode service start:', e.message);
      }
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
        title, directory: cwd, permissions: options && options.askShell ? ASK_SHELL : undefined,
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
    // ответ в самом TUI придёт как permission.replied из SSE
    onInput: () => [],

    subscribe(session, emit) {
      const sid = session && session.agentState && session.agentState.opencodeSessionId;
      if (typeof sid !== 'string') return () => {};
      const known = new Map(); // requestId -> момент, когда запрос стал известен (now())
      const closed = new Set(); // id запросов закрыты навсегда (id не переиспользуются)
      const markClosed = (rid) => {
        known.delete(rid);
        closed.add(rid);
        if (closed.size > MAX_CLOSED) closed.delete(closed.values().next().value);
      };
      const opened = (p) => {
        known.set(p.id, now());
        return [{ kind: 'request', requestId: p.id, message: describe(p), choices: choicesFor(p) },
          { kind: 'status', status: 'waiting' }];
      };
      const finished = (message) => [{ kind: 'status', status: 'idle' }, { kind: 'notify', message, done: true }];
      return client.subscribe(sid, (evt) => {
        const d = evt.data || {};
        switch (evt.type) {
          case 'permission.asked':
            if (typeof d.id === 'string' && !known.has(d.id) && !closed.has(d.id)) emit(opened(d));
            break;
          case 'permission.replied':
            if (typeof d.requestID === 'string') {
              markClosed(d.requestID);
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
            // список отражает только события, полученные до запроса списка (startedAt):
            // ответ на запрос мог прийти по SSE раньше, чем устаревший список
            const startedAt = typeof d.startedAt === 'number' ? d.startedAt : Infinity;
            const listed = new Set();
            const out = [];
            for (const p of Array.isArray(d.permissions) ? d.permissions : []) {
              if (!p || typeof p.id !== 'string') continue;
              listed.add(p.id);
              if (!known.has(p.id) && !closed.has(p.id)) out.push(...opened(p));
            }
            for (const [k, at] of [...known]) {
              if (!listed.has(k) && at < startedAt) { markClosed(k); out.push({ kind: 'requestClosed', requestId: k }); }
            }
            if (out.length) emit(out);
            break;
          }
          default:
            break;
        }
      });
    },

    /** Не бросает: сбой связи с сервисом -> { ok:false, error:'failed' }, запрос остаётся открытым. */
    async reply(session, request, decision) {
      const sid = session && session.agentState && session.agentState.opencodeSessionId;
      const rid = request && request.requestId;
      if (!DECISIONS.has(decision) || typeof sid !== 'string' || typeof rid !== 'string' || !rid) {
        return { ok: false, events: [] };
      }
      let r;
      try {
        r = await client.replyPermission(sid, rid, decision);
      } catch (e) {
        console.error('[opencode] ответ на разрешение:', e.message);
        return { ok: false, error: 'failed', events: [] };
      }
      const events = [{ kind: 'requestClosed', requestId: rid }];
      return r === 'ok' ? { ok: true, events } : { ok: false, stale: true, events };
    },
  };
}

module.exports = { create, describe };
