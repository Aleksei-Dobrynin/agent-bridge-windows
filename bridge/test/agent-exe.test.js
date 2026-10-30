'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { npmShimExe } = require('../lib/agent-exe');
const { findOnPath } = require('../lib/which');

const REL = ['node_modules', '@x', 'tool', 'bin', 'tool.exe'];

test('exe next to the shim is found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-'));
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off');
  fs.mkdirSync(path.join(dir, ...REL.slice(0, -1)), { recursive: true });
  fs.writeFileSync(path.join(dir, ...REL), 'MZ');
  const find = (n) => (n === 'tool.cmd' ? path.join(dir, 'tool.cmd') : null);
  assert.strictEqual(npmShimExe('tool', REL, find), path.join(dir, ...REL));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('null when shim or exe is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-'));
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off');
  assert.strictEqual(npmShimExe('tool', REL, () => null), null);
  assert.strictEqual(npmShimExe('tool', REL, () => path.join(dir, 'tool.cmd')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('first shim on PATH wins (PATH order, like findOnPath)', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-exe-b-'));
  for (const d of [a, b]) {
    fs.writeFileSync(path.join(d, 'tool.cmd'), '@echo off');
    fs.mkdirSync(path.join(d, ...REL.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(d, ...REL), 'MZ');
  }
  const saved = process.env.PATH;
  try {
    process.env.PATH = [b, a, saved].join(';');
    assert.strictEqual(npmShimExe('tool', REL), path.join(b, ...REL));
  } finally {
    process.env.PATH = saved;
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('real claude.exe on this machine', { skip: !findOnPath('claude.cmd') && 'claude не установлен' }, () => {
  const exe = npmShimExe('claude', ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
  assert.match(exe, /claude\.exe$/i);
});

test('real opencode.exe on this machine', { skip: !findOnPath('opencode.cmd') && 'opencode не установлен' }, () => {
  const exe = npmShimExe('opencode', ['node_modules', '@opencode', 'cli', 'bin', 'opencode.exe']);
  assert.match(exe, /opencode\.exe$/i);
});
