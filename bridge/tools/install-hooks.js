#!/usr/bin/env node
'use strict';
// P-6: хук моста в пользовательском settings.json Claude Code (exec-форма из hook-settings.js).
// Установка сливает записи с хуками пользователя и идемпотентна; перед записью существующего
// файла — резервная копия. Удаление снимает только записи хука моста (в args есть файл
// bridge-hook.js из любого каталога) — хуки пользователя и прочие ключи не трогаются.
//
//   node tools/install-hooks.js install   [--settings <файл>] [--dry-run]
//   node tools/install-hooks.js uninstall [--settings <файл>] [--dry-run]
//   node tools/install-hooks.js status    [--settings <файл>]      код 0 — установлен, 2 — нет
// Файл по умолчанию — %USERPROFILE%\.claude\settings.json. Код 1 — ошибка, файл не изменён.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hookSettings } = require('./hook-settings');

const HOOK = path.join(__dirname, '..', 'hooks', 'bridge-hook.js');
const DEFAULT_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const USAGE = 'node tools/install-hooks.js install|uninstall|status [--settings <файл>] [--dry-run]';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const normPath = (p) => path.win32.normalize(p).toLowerCase();

/** Запись хука моста: в args — путь к bridge-hook.js (каталог любой). */
function isBridgeEntry(h) {
  return isObj(h) && Array.isArray(h.args) &&
    h.args.some((a) => typeof a === 'string' && path.win32.basename(a).toLowerCase() === 'bridge-hook.js');
}

function checkShape(settings) {
  if (!isObj(settings)) throw new Error('корень настроек — не JSON-объект');
  if (settings.hooks === undefined) return;
  if (!isObj(settings.hooks)) throw new Error('ключ hooks — не объект');
  for (const [ev, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${ev} — не массив`);
  }
}

const entriesOf = (groups) => (groups || []).flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []));

/** На каждом событии моста — ровно одна запись моста, exec-форма с этим путём. */
function isInstalled(settings, hookPath = HOOK) {
  checkShape(settings);
  const hooks = settings.hooks || {};
  return Object.keys(hookSettings(hookPath).hooks).every((ev) => {
    const ours = entriesOf(hooks[ev]).filter(isBridgeEntry);
    return ours.length === 1 && ours[0].type === 'command' && ours[0].command === 'node' &&
      ours[0].args.length === 1 && normPath(ours[0].args[0]) === normPath(hookPath);
  });
}

function removeBridgeHooks(settings) {
  checkShape(settings);
  const out = JSON.parse(JSON.stringify(settings));
  let removed = 0;
  if (!out.hooks) return { settings: out, removed };
  for (const ev of Object.keys(out.hooks)) {
    const before = removed;
    const kept = [];
    for (const g of out.hooks[ev]) {
      if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isBridgeEntry(h));
      removed += g.hooks.length - rest.length;
      // группа только из хука моста удаляется целиком; пустая группа пользователя остаётся как была
      if (rest.length || !g.hooks.length) kept.push(rest.length === g.hooks.length ? g : { ...g, hooks: rest });
    }
    if (removed > before && !kept.length) delete out.hooks[ev];
    else out.hooks[ev] = kept;
  }
  if (removed && !Object.keys(out.hooks).length) delete out.hooks;
  return { settings: out, removed };
}

function mergeBridgeHooks(settings, hookPath = HOOK) {
  if (isInstalled(settings, hookPath)) return { settings, changed: false, replaced: 0 };
  const { settings: out, removed } = removeBridgeHooks(settings); // записи со старым путём
  const want = hookSettings(hookPath).hooks;
  out.hooks = out.hooks || {};
  for (const ev of Object.keys(want)) out.hooks[ev] = [...(out.hooks[ev] || []), ...want[ev]];
  return { settings: out, changed: true, replaced: removed };
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, settings: {} };
    throw e;
  }
  text = text.replace(/^\uFEFF/, '');
  const settings = text.trim() ? JSON.parse(text) : {};
  checkShape(settings);
  return { exists: true, settings };
}

function backupName(file, now = new Date()) {
  return `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/** Резервных копий установщика (имя из backupName) хранится не больше (ревью M-5). */
const KEEP_BACKUPS = 5;
const BACKUP_RE = /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** Удалить старые копии установщика, кроме последних KEEP_BACKUPS; чужие файлы не трогаются. */
function pruneBackups(file, keep = KEEP_BACKUPS) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.bak-';
  const ours = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && BACKUP_RE.test(f) && f.length === prefix.length + 24)
    .sort(); // ISO-время в имени — сортировка по имени = по времени
  for (const f of ours.slice(0, Math.max(0, ours.length - keep))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* занят — удалим в следующий раз */ }
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** rename с повтором: на Windows файл настроек может быть кратко занят (антивирус, редактор). */
function renameWithRetry(from, to, rename, retries = 3, delayMs = 100) {
  for (let i = 0; ; i++) {
    try { return rename(from, to); } catch (e) {
      if (i >= retries || !['EPERM', 'EBUSY'].includes(e.code)) throw e;
      sleepSync(delayMs * (i + 1));
    }
  }
}

const tryUnlink = (p) => { try { fs.unlinkSync(p); } catch { /* нет файла */ } };

/**
 * Записать настройки: временный файл -> резервная копия существующего -> rename (ревью M-1).
 * При любой ошибке временный файл и сделанная копия удаляются, файл настроек не меняется.
 * io — подмена операций для тестов. Возвращает путь копии или null.
 */
function writeSettings(file, settings, exists, io = {}) {
  const writeFile = io.writeFile || fs.writeFileSync;
  const rename = io.rename || fs.renameSync;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  let backup = null;
  try {
    writeFile(tmp, JSON.stringify(settings, null, 2) + '\n');
    if (exists) {
      backup = backupName(file);
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    }
    renameWithRetry(tmp, file, rename, 3, io.delayMs === undefined ? 100 : io.delayMs);
  } catch (e) {
    tryUnlink(tmp);
    if (backup) tryUnlink(backup);
    throw e;
  }
  if (backup) pruneBackups(file);
  return backup;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let file = DEFAULT_SETTINGS;
  let dry = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--settings' && rest[i + 1]) file = path.resolve(rest[++i]);
    else if (rest[i] === '--dry-run') dry = true;
    else { console.error(`Неизвестный аргумент: ${rest[i]}\n${USAGE}`); return 1; }
  }
  if (!['install', 'uninstall', 'status'].includes(cmd)) { console.error(USAGE); return 1; }
  const pre = dry ? '[dry-run] ' : '';
  try {
    const cur = readSettings(file);
    if (cmd === 'status') {
      const ok = isInstalled(cur.settings);
      console.log(`Хук моста ${ok ? 'установлен' : 'не установлен'}: ${file}`);
      return ok ? 0 : 2;
    }
    if (cmd === 'install') {
      const r = mergeBridgeHooks(cur.settings);
      if (!r.changed) { console.log(`Хук моста уже установлен: ${file}`); return 0; }
      const old = r.replaced ? ` (записей со старым путём: ${r.replaced})` : '';
      if (dry) { console.log(`${pre}Хук моста будет добавлен в ${file}${old}`); return 0; }
      const backup = writeSettings(file, r.settings, cur.exists);
      console.log(`Хук моста добавлен в ${file}${old}`);
      if (backup) console.log(`Резервная копия: ${backup}`);
      return 0;
    }
    const r = removeBridgeHooks(cur.settings);
    if (!r.removed) { console.log(`Хука моста нет: ${file}`); return 0; }
    if (dry) { console.log(`${pre}Хук моста будет удалён из ${file} (записей: ${r.removed})`); return 0; }
    const backup = writeSettings(file, r.settings, true);
    console.log(`Хук моста удалён из ${file} (записей: ${r.removed})`);
    console.log(`Резервная копия: ${backup}`);
    return 0;
  } catch (e) {
    console.error(`Ошибка: ${file}: ${e.message} — файл не изменён`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { HOOK, DEFAULT_SETTINGS, isBridgeEntry, isInstalled, removeBridgeHooks, mergeBridgeHooks,
  readSettings, writeSettings, backupName, pruneBackups, renameWithRetry, KEEP_BACKUPS, main };
