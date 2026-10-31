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

  /** D-13: текст диалога подтверждения операции владельца на телефоне; D-22.3: контрольный код
   *  из 4 цифр человек сверяет с консолью ПК — показывается отдельно и крупно. */
  function confirmPrompt(m) {
    const msg = m && typeof m.message === 'string' && m.message ? m.message : 'Разрешить операцию на ПК?';
    const code = m && typeof m.checkCode === 'string' && /^\d{4}$/.test(m.checkCode) ? m.checkCode : '';
    return { text: msg + '\n\nЕсли вы этого не запускали — отклоните.', code };
  }

  /** Текст баннера для ответов моста на операцию владельца (confirmPending/Required/Result);
   *  null — не такое сообщение. D-22.3: пауза после отказа — reason 'cooldown', retryAfterSec. */
  function confirmStatusText(m) {
    if (!m) return null;
    if (m.type === 'confirmPending') {
      return '📱 ' + (m.message || 'Подтвердите операцию на телефоне') +
        (typeof m.checkCode === 'string' && m.checkCode ? ' Код: ' + m.checkCode : '');
    }
    if (m.type === 'confirmRequired') return '⚠ Операция требует подтверждения в консоли claude-mobile';
    if (m.type !== 'confirmResult') return null;
    if (m.allow === true) return '✔ Подтверждено на телефоне';
    if (m.reason === 'cooldown') {
      const sec = Math.max(1, Math.ceil(Number(m.retryAfterSec) || 0));
      const wait = sec >= 60 ? Math.ceil(sec / 60) + ' мин' : sec + ' с';
      return '⏳ Повторить можно через ' + wait + ' — после отказа на телефоне действует пауза';
    }
    if (m.reason === 'timeout') return '✖ Телефон не ответил — операция отменена';
    return '✖ Отклонено на телефоне';
  }

  /** D-19.1: пока xterm проигрывает буфер scrollback, его ответы на запросы терминала из буфера
   *  (DA, CPR, DECRPM, OSC…) — не ввод человека и в PTY не отправляются. begin() — начало
   *  проигрывания, возвращает функцию завершения (повторный вызов ничего не делает). */
  function replayGate() {
    let n = 0;
    return {
      begin() {
        n++;
        let done = false;
        return () => { if (!done) { done = true; n--; } };
      },
      active: () => n > 0,
    };
  }

  return { filterPaste, scrollSequence, buildCreate, confirmPrompt, confirmStatusText, replayGate };
});
