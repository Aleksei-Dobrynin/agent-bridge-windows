'use strict';
// У моста на Windows нет консоли (запуск из Планировщика): console.* дублируется в файл.
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 5 * 1024 * 1024;

function createWriter(logDir, maxBytes = MAX_BYTES) {
  const file = path.join(logDir, 'bridge.log');
  return (level, args) => {
    // переводы строк в сообщении экранируются: нельзя подделать строку лога
    const msg = util.format(...args)
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,
        (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
        fs.renameSync(file, file + '.1');
      }
    } catch { /* ротация не удалась — всё равно пишем */ }
    try { fs.appendFileSync(file, line); } catch { /* лог не должен ронять мост */ }
  };
}

function installFileLog(logDir, maxBytes = MAX_BYTES) {
  const write = createWriter(logDir, maxBytes);
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { write('INFO', a); origLog(...a); };
  console.error = (...a) => { write('ERROR', a); origErr(...a); };
  process.on('uncaughtException', (e) => { write('FATAL', [e && e.stack || e]); process.exit(1); });
  return path.join(logDir, 'bridge.log');
}

module.exports = { installFileLog, createWriter };
