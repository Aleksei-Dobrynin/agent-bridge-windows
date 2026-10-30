'use strict';
// D-3, D-15 п. 5: универсальный адаптер «только зеркало» для любого TUI-агента из конфига.
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
