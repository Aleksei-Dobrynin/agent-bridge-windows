'use strict';
// Реальный .exe за npm-шимом (claude.cmd, opencode.cmd). Адаптеры запускают .exe
// напрямую: шим через cmd.exe добавляет лишний процесс и ломает кавычки в node-pty
// (живые пробы Claude Code 2.1.284 и opencode v2.1.4, поправка подплана 1 к задаче 7).
// Шим ищется по PATH в порядке каталогов (findOnPath) — берётся тот же, что запустила бы консоль.
const fs = require('fs');
const path = require('path');
const { findOnPath } = require('./which');

/** <каталог shim.cmd>\<relParts…>, если такой файл есть; иначе null. */
function npmShimExe(shim, relParts, find = findOnPath) {
  const cmd = find(shim + '.cmd');
  if (!cmd) return null;
  const exe = path.join(path.dirname(cmd), ...relParts);
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

module.exports = { npmShimExe };
