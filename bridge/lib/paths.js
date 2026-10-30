'use strict';
// D-7: вся работа с путями моста — здесь. Только Windows (D-9).
const fs = require('fs');
const os = require('os');
const win = require('path').win32;

/** Путь из конфига: раскрыть ~ и %VAR%, принять / и \. Пустое/не строка -> null. */
function expandConfigPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = os.homedir() + s.slice(1);
  s = s.replace(/%([A-Za-z0-9_()]+)%/g, (m, name) =>
    (process.env[name] !== undefined ? process.env[name] : m));
  s = win.normalize(s);
  // Только абсолютный путь с диском: «projects», «C:», «C:foo» иначе молча
  // разрешились бы относительно process.cwd().
  return isAcceptableRemoteForm(s) ? s : null;
}

/** Форма пути, пришедшего по сети: только «X:\...». UNC, \\?\, \\.\, X:foo — нет. */
function isAcceptableRemoteForm(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return false;
  if (/[\x00-\x1f]/.test(p)) return false;
  const s = p.replace(/\//g, '\\');
  if (s.startsWith('\\\\')) return false;
  return /^[A-Za-z]:\\/.test(s);
}

/** Канонический путь от ОС: регистр, 8.3, junction, subst. Нет пути -> null. */
function canonical(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/** Канонический путь, который существует и является каталогом (файл как cwd — нет). */
function canonicalDir(p) {
  const c = canonical(p);
  if (!c) return null;
  try { return fs.statSync(c).isDirectory() ? c : null; } catch { return null; }
}

// Регистронезависимость — осознанная: per-directory case sensitivity (WSL) вне модели угроз.
function isInside(root, p) {
  const rel = win.relative(win.resolve(root), win.resolve(p)); // relative на win32 регистронезависим
  if (rel === '') return true;
  if (win.isAbsolute(rel)) return false;                      // другой диск
  return rel !== '..' && !rel.startsWith('..\\');
}

function key(p) {
  return win.normalize(String(p)).replace(/\\+$/, '').toLowerCase();
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return key(a) === key(b);
}

/** cwd с телефона: допустимая форма + существует + внутри одного из корней; иначе fallback. */
function resolveRemoteCwd(cwd, roots, fallback) {
  if (!isAcceptableRemoteForm(cwd)) return fallback;
  const real = canonicalDir(cwd);
  if (!real) return fallback;
  // TOCTOU между проверкой и spawn принимается: атакующий под тем же пользователем вне модели угроз.
  const ok = (roots || []).some((r) => {
    const rr = canonical(r);
    return rr && isInside(rr, real);
  });
  return ok ? real : fallback;
}

/** cwd владельца: без ограничений, но канонический (иначе --resume не найдёт беседы). */
function resolveLocalCwd(cwd, fallback) {
  if (typeof cwd !== 'string' || !cwd) return fallback;
  return canonicalDir(cwd) || fallback;
}

module.exports = {
  expandConfigPath, isAcceptableRemoteForm, canonical, canonicalDir, isInside, samePath,
  resolveRemoteCwd, resolveLocalCwd,
};
