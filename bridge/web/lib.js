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
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  }

  return { filterPaste };
});
