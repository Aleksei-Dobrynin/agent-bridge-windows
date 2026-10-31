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
  assert.strictEqual(CB.filterPaste('a\u202eb\u200bc\ufeff'), 'abc');
  assert.strictEqual(CB.filterPaste('привет, мир'), 'привет, мир');
  assert.strictEqual(CB.filterPaste(null), '');
});

test('scrollSequence: SGR wheel or PageUp/PageDown, at most 10 steps', () => {
  assert.strictEqual(CB.scrollSequence('wheel', 2, 40, 12), '\x1b[<64;40;12M\x1b[<64;40;12M');
  assert.strictEqual(CB.scrollSequence('wheel', -1, 40, 12), '\x1b[<65;40;12M');
  assert.strictEqual(CB.scrollSequence('pageKeys', 3, 40, 12), '\x1b[5~\x1b[5~\x1b[5~');
  assert.strictEqual(CB.scrollSequence('pageKeys', -1, 40, 12), '\x1b[6~');
  assert.strictEqual(CB.scrollSequence('wheel', 50, 1, 1).split('M').length - 1, 10);
  assert.strictEqual(CB.scrollSequence('bogus', 1, 1, 1), '\x1b[5~', 'unknown mode -> page keys');
  assert.strictEqual(CB.scrollSequence('wheel', 0, 1, 1), '');
});
