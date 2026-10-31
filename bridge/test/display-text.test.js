'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cleanText, clipMiddle, displayText } = require('../lib/display-text');

test('cleanText: Cf removed, C0/C1 and U+2028/U+2029 become spaces, whitespace collapsed (D-19 п. 2)', () => {
  assert.strictEqual(cleanText('echo \u202Eabc\u200B\uFEFFdef\u2028x\x85y\u2066z\t\r\n w'), 'echo abcdef x yz w');
  assert.strictEqual(cleanText('  a\x00b\x1b[31mc\x7f  \u2029 d  '), 'a b [31mc d');
  assert.strictEqual(cleanText('soft\u00ADhy\u061Cph\u180Een'), 'softhyphen');
  assert.strictEqual(cleanText(42), '42');
  // заполнители хангыля, CGJ и селекторы вариантов рисуются пустыми — тоже вырезаются
  assert.strictEqual(cleanText('a\u3164b\uFFA0c\u115Fd\u1160e\u034Ff\uFE00g\uFE0Fh'), 'abcdefgh');
  assert.strictEqual(cleanText('rm\u3164 -rf\uFE0F ~'), 'rm -rf ~');
});

test('clipMiddle: <first 100>…<last 60> (N симв.) only when longer than 200 code points', () => {
  const short = 'x'.repeat(200);
  assert.strictEqual(clipMiddle(short), short);
  const long = 'a'.repeat(150) + 'b'.repeat(150);
  assert.strictEqual(clipMiddle(long), 'a'.repeat(100) + '…' + 'b'.repeat(60) + ' (300 симв.)');
  // по кодовым точкам: суррогатная пара не разрезается и считается одним символом
  const emoji = '😀'.repeat(201);
  assert.strictEqual(clipMiddle(emoji), '😀'.repeat(100) + '…' + '😀'.repeat(60) + ' (201 симв.)');
  assert.strictEqual(clipMiddle('abcdefghij', { max: 5, head: 2, tail: 1 }), 'ab…j (10 симв.)');
});

test('displayText = clipMiddle(cleanText(s)): a hidden tail stays visible', () => {
  const s = 'echo ok' + '\n'.repeat(280) + 'rm -rf ~';
  assert.strictEqual(displayText(s), 'echo ok rm -rf ~');
  const long = 'echo ' + 'a'.repeat(500) + ' ; rm -rf ~';
  const out = displayText(long);
  assert.ok(out.endsWith(long.slice(-60) + ` (${long.length} симв.)`), out);
  assert.ok(out.startsWith(long.slice(0, 100) + '…'), out);
});

test('D-23.6: labelText — prefix + sanitized detail, at most 40 UTF-16 units, the tail stays visible', () => {
  const { labelText } = require('../lib/display-text');
  assert.strictEqual(labelText('Всегда: ', 'mkdir *'), 'Всегда: mkdir *');
  assert.strictEqual(labelText('Всегда', ''), 'Всегда');
  assert.strictEqual(labelText('Всегда: ', '  ​\n '), 'Всегда:', 'empty detail -> trimmed prefix');
  assert.strictEqual(labelText('Всегда: ', 'a‮b\nc'), 'Всегда: ab c');
  const long = labelText('Всегда: ', 'x'.repeat(10) + 'y'.repeat(40) + 'END');
  assert.strictEqual(long.length, 40);
  assert.ok(long.startsWith('Всегда: x') && long.endsWith('END') && long.includes('…'), long);
  // суррогатные пары не разрезаются, длина — в единицах UTF-16 (как обрезает мост)
  const emoji = labelText('Всегда: ', '😀'.repeat(30));
  assert.ok(emoji.length <= 40, emoji);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji), emoji);
});
