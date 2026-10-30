'use strict';
// Вход браузера владельца (claude-mobile --open): одноразовая ссылка и запуск браузера.
const childProcess = require('child_process');

const URL_RE = /^https:\/\/127\.0\.0\.1:\d{1,5}\/\?ott=[0-9a-f]{64}$/;

/** Ссылка из ответа моста loginToken {port, token}; что-то не так -> null. */
function buildLoginUrl(m) {
  if (!m || typeof m !== 'object') return null;
  const port = Number.isInteger(m.port) && m.port > 0 && m.port < 65536 ? m.port : null;
  const token = typeof m.token === 'string' && /^[0-9a-f]{64}$/.test(m.token) ? m.token : null;
  return port && token ? `https://127.0.0.1:${port}/?ott=${token}` : null;
}

/**
 * Открыть ссылку в браузере по умолчанию. Строка cmd.exe целиком + windowsVerbatimArguments:
 * иначе Node экранирует пустой заголовок окна "" как \"\", и start принял бы его за программу.
 * Метасимволов cmd.exe в ссылке нет — это гарантирует URL_RE.
 */
function openInBrowser(url, { spawn = childProcess.spawn, onError = () => {} } = {}) {
  if (typeof url !== 'string' || !URL_RE.test(url)) throw new Error('недопустимая ссылка входа');
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" "${url}""`], {
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  });
  child.on('error', onError);
  child.unref();
  return child;
}

module.exports = { buildLoginUrl, openInBrowser };
