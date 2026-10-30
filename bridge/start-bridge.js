#!/usr/bin/env node
'use strict';
// Точка входа для Планировщика задач (P-4): поднимает мост отсоединённым скрытым
// процессом и сразу выходит. Повторный запуск при уже работающем мосте — no-op
// (порт занят -> server.js завершится с ошибкой в логе).
// Вывод моста — в %LOCALAPPDATA%\ClaudeBridge\logs\bridge.log (lib/log.js).
const path = require('path');
const { spawn } = require('child_process');

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
  cwd: __dirname,
});
child.unref();
process.exit(0);
