'use strict';
// P-10: проверка типов всех входов (M-2, L-1, L-2, L-8). Каждая функция
// возвращает нормализованное значение или null.
function wsMessage(m) {
  return m && typeof m === 'object' && !Array.isArray(m) && typeof m.type === 'string' ? m : null;
}
function str(v, max = 1 << 20) {
  return typeof v === 'string' && v.length <= max ? v : null;
}
function int(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}
function sessionId(v) {
  return typeof v === 'string' && /^s\d{1,9}-[0-9a-f]{6}$/.test(v) ? v : null;
}
function nodeId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}
// Управляющие, bidi-переопределения и zero-width символы вырезаются; обрезка по code points.
const INVISIBLE = /[\x00-\x1f\x7f-\x9f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u2028\u2029\u061C\u2060-\u2064\u180E]/g;
function cleanTitle(v, max = 120) {
  if (typeof v !== 'string') return null;
  return Array.from(v.replace(INVISIBLE, '')).slice(0, max).join('');
}
function pairBody(p) {
  if (!p || typeof p !== 'object' || typeof p.code !== 'string' || p.code.length > 64) return null;
  return { code: p.code.toUpperCase(), name: cleanTitle(p.name, 64) || '' };
}
function cookieToken(v) {
  return typeof v === 'string' && /^[0-9a-f]{48}$|^[0-9a-f]{64}$/.test(v) ? v : null;
}
module.exports = { wsMessage, str, int, sessionId, nodeId, cleanTitle, pairBody, cookieToken };
