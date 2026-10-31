'use strict';
// node-pty на Windows запускает файл через CreateProcess: нужен реальный .exe.
// npm-шимы (.cmd/.bat) запускаются через cmd.exe; командную строку для них мы
// собираем сами (алгоритм cross-spawn), чтобы метасимволы cmd (& | ^ % ! и т.д.)
// в аргументах стали литералами и ничего лишнего не исполнялось.
// Для шимов args возвращается ОДНОЙ СТРОКОЙ: node-pty при массиве сам экранирует
// кавычки как \" и cmd.exe такой путь не понимает.
const fs = require('fs');
const path = require('path');

function findOnPath(name) {
  const exts = path.extname(name)
    ? ['']
    : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  // относительные элементы PATH пропускаются: они зависят от текущего каталога моста
  const dirs = path.isAbsolute(name) ? [''] : (process.env.PATH || '').split(';').filter((d) => path.isAbsolute(d));
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.isAbsolute(name) ? name + e : path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* дальше */ }
    }
  }
  return null;
}

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

// Экранирование одного аргумента для cmd.exe (cross-spawn escapeArgument).
// 1) правила MSVCRT: обратные слэши перед " удваиваются, " -> \", хвостовые \ удваиваются,
//    аргумент оборачивается в двойные кавычки;
// 2) метасимволы cmd экранируются кареткой; для .cmd/.bat (аргументы разбираются
//    повторно при раскрытии %* внутри батника) каретки ставятся ДВАЖДЫ.
function escapeArg(arg, double) {
  let a = String(arg);
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(META_CHARS, '^$1');
  if (double) a = a.replace(META_CHARS, '^$1');
  return a;
}

function escapeCommand(cmd) {
  return String(cmd).replace(META_CHARS, '^$1');
}

function resolveSpawn(command, args) {
  const file = findOnPath(command);
  if (!file) throw new Error(`команда не найдена: ${command}`);
  if (/\.(cmd|bat)$/i.test(file)) {
    // cmd молча обрезает команду на переводе строки; NUL тоже недопустим
    if (args.some((a) => /[\r\n\0]/.test(String(a)))) {
      throw new Error('недопустимый символ (CR/LF/NUL) в аргументе для cmd-шима');
    }
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const line = [escapeCommand(path.normalize(file)), ...args.map((a) => escapeArg(a, true))].join(' ');
    return { file: comspec, args: `/d /v:off /s /c "${line}"` };
  }
  return { file, args };
}

module.exports = { resolveSpawn, findOnPath, escapeArg };
