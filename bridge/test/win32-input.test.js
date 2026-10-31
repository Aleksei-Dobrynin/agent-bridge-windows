'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W32 = require('../lib/win32-input');

// D-23.2 (B-2): что получил stdin claude-mobile -a в ConPTY после \x1b[?9001h от Claude при нажатии
// Ctrl+\ (задача 17, attach-stdin.hex): Ctrl вниз, «\» вниз (символ 28), «\» вверх, Ctrl вверх
const CAPTURED = Buffer.from('1b5b31373b32393b303b313b383b315f1b5b3232303b34333b32383b313b383b315f' +
  '1b5b3232303b34333b32383b303b383b315f1b5b31373b32393b303b303b303b315f', 'hex').toString('utf8');

test('D-23.1: Esc in win32-input-mode encoding (press + release)', () => {
  assert.strictEqual(W32.ESC, '\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_');
});

test('D-23.2: Ctrl+\\ is recognized raw and win32-input-mode encoded (captured chunk)', () => {
  assert.strictEqual(W32.isCtrlBackslash('\x1c'), true, 'raw 0x1c');
  assert.strictEqual(W32.isCtrlBackslash(CAPTURED), true, 'captured win32-input chunk');
  assert.strictEqual(W32.isCtrlBackslash('\x1b[220;43;28;1;8;1_'), true, 'press alone');
  assert.strictEqual(W32.isCtrlBackslash('ab\x1b[220;43;28;1;8;1_'), true, 'after other input');
});

test('D-23.2: other input is not Ctrl+\\', () => {
  for (const s of ['', 'a', '\x1c\x1c', 'a\x1c', '\x1b', W32.ESC, '\x1b[220;43;28;0;8;1_' /* только отпускание */,
    '\x1b[220;43;92;1;0;1_' /* «\» без Ctrl */, '\x1b[17;29;0;1;8;1_' /* Ctrl */, '\x1b[65;30;28;1;0;1', '[220;43;28;1;8;1_']) {
    assert.strictEqual(W32.isCtrlBackslash(s), false, JSON.stringify(s));
  }
});

test('MODE_OFF switches win32-input-mode off', () => {
  assert.strictEqual(W32.MODE_OFF, '\x1b[?9001l');
});

test('D-25.5: CONSOLE_RESET switches off win32-input, focus, mouse modes and the alternate screen', () => {
  assert.strictEqual(W32.CONSOLE_RESET,
    '\x1b[?9001l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l');
});
