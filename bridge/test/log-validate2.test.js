'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWriter } = require('../lib/log');
const V = require('../lib/validate');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-log-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('log: writes lines, forged newlines are neutralised', (t) => {
  const d = tmp(t);
  const write = createWriter(d);
  write('INFO', ['hello', 'a\nFAKE 2026 ERROR forged\r\nx']);
  const lines = fs.readFileSync(path.join(d, 'bridge.log'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], / INFO hello a\\nFAKE 2026 ERROR forged\\nx$/);
});

test('log: rotates when file exceeds the limit', (t) => {
  const d = tmp(t);
  const write = createWriter(d, 200);
  for (let i = 0; i < 20; i++) write('INFO', ['line ' + i + ' ' + 'x'.repeat(30)]);
  assert.ok(fs.existsSync(path.join(d, 'bridge.log.1')), 'rotated file exists');
  assert.ok(fs.statSync(path.join(d, 'bridge.log')).size < 400);
});

test('log: still appends when rotation fails', (t) => {
  const d = tmp(t);
  const file = path.join(d, 'bridge.log');
  fs.writeFileSync(file, 'x'.repeat(500));
  fs.mkdirSync(file + '.1'); // rename на каталог упадёт
  const write = createWriter(d, 100);
  write('INFO', ['still here']);
  assert.match(fs.readFileSync(file, 'utf8'), /still here/);
});

test('cleanTitle strips bidi / zero-width and cuts by code points', () => {
  assert.strictEqual(V.cleanTitle('a‮b​c⁦d﻿e‏f'), 'abcdef');
  const emoji = '😀'.repeat(200);
  const r = V.cleanTitle(emoji);
  assert.strictEqual(Array.from(r).length, 120);
  assert.ok(!/[\uD800-\uDBFF]$/.test(r), 'no lone surrogate');
});

test('pairBody.name is cleaned and limited to 64 code points', () => {
  const r = V.pairBody({ code: 'ab', name: '‮Phone\x07' + '😀'.repeat(100) });
  assert.strictEqual(r.code, 'AB');
  assert.ok(r.name.startsWith('Phone😀'));
  assert.ok(!r.name.includes('‮') && !r.name.includes('\x07'));
  assert.strictEqual(Array.from(r.name).length, 64);
  assert.strictEqual(V.pairBody({ code: 'ab', name: 5 }).name, '');
});
