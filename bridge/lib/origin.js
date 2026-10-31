'use strict';
// P-1: второй слой против H-1 (CSWSH). Браузер всегда шлёт Origin; CLI-клиенты — нет.
const WEBVIEW_ORIGIN = 'http://127.0.0.1:38471'; // LocalGateway в Android-приложении

/**
 * Origin допустим? WEBVIEW_ORIGIN — только при `device: true` (m-1): его присылает лишь
 * LocalGateway телефона на WS-апгрейде с токеном устройства; владельцу (WS и HTTP) и любому
 * HTTP-запросу этот Origin не положен.
 */
function originAllowed(origin, port, { device = false } = {}) {
  if (origin === undefined) return true;
  if (origin === WEBVIEW_ORIGIN) return device === true;
  return origin === `https://127.0.0.1:${port}` ||
    origin === `https://localhost:${port}`;
}

module.exports = { originAllowed, WEBVIEW_ORIGIN };
