'use strict';
// P-1: второй слой против H-1 (CSWSH). Браузер всегда шлёт Origin; CLI-клиенты — нет.
const WEBVIEW_ORIGIN = 'http://127.0.0.1:38471'; // LocalGateway в Android-приложении

function originAllowed(origin, port) {
  if (origin === undefined) return true;
  return origin === `https://127.0.0.1:${port}` ||
    origin === `https://localhost:${port}` ||
    origin === WEBVIEW_ORIGIN;
}

module.exports = { originAllowed, WEBVIEW_ORIGIN };
