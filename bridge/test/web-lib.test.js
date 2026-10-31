'use strict';
// Чистая логика веб-клиента (bridge/web/lib.js): в браузере — window.CB, здесь — require().
const test = require('node:test');
const assert = require('node:assert');
const CB = require('../web/lib.js');

test('filterPaste removes control and invisible chars, keeps text, tab and newline', () => {
  assert.strictEqual(CB.filterPaste('ls -la\r\n'), 'ls -la\n');
  assert.strictEqual(CB.filterPaste('a\x1b[31mb\x07c'), 'a[31mbc');
  assert.strictEqual(CB.filterPaste('x\u009b2Jy\x7f'), 'x2Jy');
  assert.strictEqual(CB.filterPaste('t\tn\n'), 't\tn\n');
  assert.strictEqual(CB.filterPaste('a‮b​c﻿'), 'abc');
  assert.strictEqual(CB.filterPaste('привет, мир'), 'привет, мир');
  assert.strictEqual(CB.filterPaste(null), '');
});
