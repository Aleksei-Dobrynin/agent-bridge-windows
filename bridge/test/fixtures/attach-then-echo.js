'use strict';
// claude-mobile в общей консоли (stdio inherit), после его выхода — raw-echo в ТОЙ ЖЕ консоли:
// так видно, в каком режиме ввода claude-mobile оставил консоль (задача 1 подплана 4).
const path = require('path');
const { spawnSync } = require('child_process');

const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'attach.js'), ...process.argv.slice(2)],
  { stdio: 'inherit' });
process.stdout.write('[attach exit ' + r.status + ']\r\n');
require('./raw-echo.js');
