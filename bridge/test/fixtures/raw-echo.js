'use strict';
// Дочерний процесс для тестов ConPTY (D-23.1): консоль в raw-режиме, каждая порция ввода
// печатается как [got <hex>] — видно, какие байты дошли до программы в PTY.
if (!process.stdin.isTTY) { process.stdout.write('[no tty]\r\n'); process.exit(1); }
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => process.stdout.write('[got ' + d.toString('hex') + ']\r\n'));
process.stdout.write('[raw ' + process.stdin.isRaw + ']\r\n');
setInterval(() => {}, 1000);
