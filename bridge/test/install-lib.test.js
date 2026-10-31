'use strict';
// Задача 3 подплана 4: чистые функции PowerShell-установщика (tools/test-install-lib.ps1) и
// кодировка .ps1 — UTF-8 с BOM (Windows PowerShell 5.1 читает файл без BOM как ANSI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function ps1Files() {
  const out = [];
  for (const d of ['', path.join('bridge', 'tools'), 'tools']) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.toLowerCase().endsWith('.ps1')) out.push(path.join(dir, f));
  }
  return out;
}

test('every .ps1 is UTF-8 with BOM', () => {
  const files = ps1Files();
  assert.ok(files.some((f) => f.endsWith('install-lib.ps1')), 'install-lib.ps1 found');
  for (const f of files) assert.deepStrictEqual([...fs.readFileSync(f).subarray(0, 3)], [0xef, 0xbb, 0xbf], f);
});

test('install-lib.ps1 pure functions (test-install-lib.ps1)', { timeout: 120000 }, () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'bridge', 'tools', 'test-install-lib.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 110000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /passes: \d+, fails: 0/);
});
