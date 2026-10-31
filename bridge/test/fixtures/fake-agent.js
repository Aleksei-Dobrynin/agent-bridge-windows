'use strict';
// Фейковый TUI-агент для интеграционных тестов (вместо claude.exe / opencode.exe):
// печатает свои аргументы и нужные тестам переменные окружения, эхо ввода посимвольно.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
// как Claude Code: включить win32-input-mode консоли (D-23.2)
if (process.argv.includes('--w32-input')) process.stdout.write('\x1b[?9001h');
process.stdout.write('ARGV:' + JSON.stringify(process.argv.slice(2)) + '\r\n');
process.stdout.write('HOOKTOKEN:' + (process.env.CLAUDE_BRIDGE_HOOK_TOKEN || '') + '\r\n');
process.stdout.write('OCPW:' + (process.env.OPENCODE_PASSWORD || '-') + '\r\n');
process.stdin.on('data', (d) => process.stdout.write('ECHO:' + JSON.stringify(String(d)) + '\r\n'));
setInterval(() => {}, 1000);
