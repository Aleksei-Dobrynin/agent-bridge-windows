'use strict';
/**
 * Реестр адаптеров агентов (D-3, P-2, D-5). Контракт адаптера (финализация P-2, D-15 п. 3):
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
 *   onInput(session, data): Event[],                 // ввод в PTY с любого клиента: вызывается ТОЛЬКО
 *       // для WS-сообщений input (не для scroll и не для записей самого адаптера в reply)
 *   subscribe(session, emit): unsubscribe,           // events:'sse'; emit(Event[])
 *   async reply(session, request, decision, io) -> { ok, stale?, error?: 'failed', events: Event[] },
 *       // decision: 'once' | 'always' | 'reject'; io.write(data) -> boolean — запись в PTY сессии;
 *       // false (клавиша не дошла, keeper переподключается) -> { ok:false, error:'failed' }, запрос
 *       // остаётся открытым (D-19 п. 6); stale — запрос уже закрыт; неверное decision -> { ok:false }
 * }
 * Адаптеры не бросают исключений из onHook/onInput/reply (вход — недоверенный payload);
 * session.runtime может отсутствовать — адаптер создаёт его сам.
 * Event: { kind:'status', status:'working'|'waiting'|'idle' }
 *      | { kind:'request', requestId, message, choices:[{ id, label }] }
 *      | { kind:'requestClosed', requestId }
 *      | { kind:'notify', message, done?: true }      // done — «агент закончил ответ»
 * session (как его видит адаптер): { id, cwd, title, agentState, runtime }
 *   agentState — из spawnSpec().state, хранится в meta-файле; onHook может его дополнить — мост
 *   перепишет meta, если agentState изменился (M-6); runtime — объект в памяти моста.
 * Отличия от наброска P-2: spawnSpec асинхронный (opencode создаёт сессию через API), без helpers
 * (D-12: сервис opencode общий), добавлены title/state, onInput, isResumeLike, Event.notify.done.
 */
const TYPES = { claude: './claude', opencode: './opencode', generic: './generic' };
const DEFAULT_AGENTS = { claude: {}, opencode: {} };
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

function loadAgents(config, opts = {}) {
  const log = opts.log || ((...a) => console.log(...a));
  const given = config && Object.prototype.hasOwnProperty.call(config, 'agents') && config.agents !== undefined;
  const isObj = given && config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents);
  // M-8: ключ agents есть, но это не объект — сказать, а не молча взять умолчание
  if (given && !isObj) log('  Конфиг: agents — не объект {id: {...}}; используются агенты по умолчанию (claude, opencode)');
  const src = isObj ? config.agents : DEFAULT_AGENTS;
  const map = new Map();
  for (const [id, raw] of Object.entries(src)) {
    if (!ID_RE.test(id)) { log(`  Агент «${id}»: недопустимый id — пропущен`); continue; }
    const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const type = cfg.type || (id === 'claude' || id === 'opencode' ? id : 'generic');
    if (!Object.prototype.hasOwnProperty.call(TYPES, type)) {
      log(`  Агент «${id}»: неизвестный тип ${type} — пропущен`);
      continue;
    }
    for (const key of ['args', 'prefixArgs']) {
      const v = cfg[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((a) => typeof a !== 'string'))) {
        log(`  Агент «${id}»: ${key} — не массив строк; нестроковые значения отброшены`);
      }
    }
    let adapter;
    try {
      adapter = require(TYPES[type]).create(id, cfg, opts);
    } catch (e) {
      log(`  Агент «${id}»: ${e.message} — пропущен`);
      continue;
    }
    if (!adapter.available()) {
      // M-8: какую команду искали; null — автопоиск (npm-шим / PATH) ничего не нашёл
      const what = typeof adapter.command === 'string' && adapter.command ? adapter.command : `${type} (автопоиск npm-шима и PATH)`;
      log(`  Агент «${id}» недоступен: исполняемый файл не найден: ${what}`);
      continue;
    }
    map.set(id, adapter);
  }
  const ids = [...map.keys()];
  const wanted = config && config.defaultAgent !== undefined ? config.defaultAgent : undefined;
  const defaultId = typeof wanted === 'string' && map.has(wanted) ? wanted : (ids[0] || null);
  // M-8: настроенный агент по умолчанию недоступен — какой используется вместо него
  if (wanted !== undefined && defaultId !== wanted) {
    log(`  Агент по умолчанию «${String(wanted).slice(0, 40)}» недоступен — ` +
      (defaultId ? `используется «${defaultId}»` : 'нет доступных агентов'));
  } else if (!defaultId) {
    log('  нет доступных агентов');
  }
  return {
    defaultId,
    get: (id) => (typeof id === 'string' ? map.get(id) || null : null),
    // копии: вызывающий (сериализация в sessions) не может испортить объявление адаптера
    list: () => [...map.values()].map((a) => ({
      id: a.id, name: a.name, options: a.options.map((o) => ({ ...o })), scroll: a.scroll,
    })),
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
