'use strict';
// Чистые функции веб-клиента (без DOM): в браузере — window.CB, в node:test — require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CB = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** L-10: вставляемый текст без управляющих символов — ESC/CSI из буфера обмена
   *  не должны управлять TUI агента. Остаются текст, \t и \n (\r\n -> \n). */
  function filterPaste(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  }

  /** D-10: прокрутка альтернативного экрана способом, который объявил адаптер агента:
   *  'wheel' — события колеса мыши SGR в центр экрана, иначе PageUp/PageDown. */
  function scrollSequence(mode, lines, col, row) {
    const n = Math.min(Math.abs(Math.trunc(lines)), 10);
    let out = '';
    for (let i = 0; i < n; i++) {
      if (mode === 'wheel') out += `\x1b[<${lines > 0 ? 64 : 65};${col};${row}M`;
      else out += lines > 0 ? '\x1b[5~' : '\x1b[6~';
    }
    return out;
  }

  /** P-3: с устройства уходят только id агента и id включённых опций — команду строит мост.
   *  Агент не выбран — null: агент по умолчанию (D-22.4). */
  function buildCreate(agent, checkedOptionIds, cwd) {
    const options = {};
    for (const id of checkedOptionIds || []) if (typeof id === 'string' && id) options[id] = true;
    return { type: 'create', agent: typeof agent === 'string' && agent ? agent : null, options, cwd };
  }

  return { filterPaste, scrollSequence, buildCreate };
});
