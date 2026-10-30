'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('../node_modules/node-pty');
test.after(() => setTimeout(() => process.exit(0), 300).unref()); // node-pty держит цикл событий
const { resolveSpawn } = require('../lib/which');

// Реальный запуск через node-pty (системный ConPTY); возвращает вывод без ANSI.
function runPty(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const term = pty.spawn(file, args, { name: 'xterm', cols: 500, rows: 30, cwd: cwd || process.cwd(), env: process.env });
    let out = '';
    const timer = setTimeout(() => { try { term.kill(); } catch {} reject(new Error('timeout, output: ' + out)); }, 20000);
    term.onData((d) => { out += d; });
    term.onExit(() => {
      clearTimeout(timer);
      resolve(out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, ''));
    });
  });
}

test('absolute exe is used as-is', () => {
  const r = resolveSpawn(process.execPath, ['-v']);
  assert.strictEqual(r.file, process.execPath);
  assert.deepStrictEqual(r.args, ['-v']);
});

test('bare name is found on PATH with PATHEXT', () => {
  const r = resolveSpawn('node', ['-v']);
  assert.match(r.file, /node\.exe$/i);
});

test('.cmd shims go through cmd.exe with ONE string of args', () => {
  const r = resolveSpawn('npm', ['-v']);
  assert.match(r.file, /cmd\.exe$/i);
  assert.strictEqual(typeof r.args, 'string');
  assert.match(r.args, /^\/d \/v:off \/s \/c "/);
  assert.match(r.args, /npm\.cmd/i);
});

test('missing command throws', () => {
  assert.throws(() => resolveSpawn('definitely-not-a-command-cb', []), /не найдена/);
});

test('real node-pty spawn of npm.cmd shim: npm -v prints a version', { timeout: 30000 }, async () => {
  const r = resolveSpawn('npm', ['-v']);
  const out = await runPty(r.file, r.args);
  assert.match(out, /\b\d+\.\d+\.\d+\b/);
});

test('real node-pty spawn of .cmd shim: args arrive literally, nothing extra runs', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb which ')); // с пробелом в пути
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'echoargs.cmd');
  fs.writeFileSync(shim,
    `@echo off\r\n"${process.execPath}" -e "console.log('J='+JSON.stringify(process.argv.slice(1)))" %*\r\n`);
  const marker = 'PWNED_MARKER';
  const argv = ['a b', 'x&y', '100%', 'q"uote', '^caret', '&echo>' + marker, '|dir', 'a(b)', 'c' + String.fromCharCode(92), '!x!'];
  const r = resolveSpawn(shim, argv);
  const out = await runPty(r.file, r.args, dir);
  const m = out.match(/J=(\[.*?\])\r?\n/);
  assert.ok(m, 'got output: ' + out);
  assert.deepStrictEqual(JSON.parse(m[1]), argv);
  assert.strictEqual(fs.existsSync(path.join(dir, marker)), false, 'injection did not run');
});

test('real node-pty spawn of .exe with args array still works', { timeout: 30000 }, async () => {
  const r = resolveSpawn(process.execPath, ['-p', '1+41']);
  const out = await runPty(r.file, r.args);
  assert.match(out, /42/);
});
