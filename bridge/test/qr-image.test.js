'use strict';
// D-29: QR сопряжения переносится на ноутбук файлом PNG — проверяем обратимость.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeQrPng, readQrPng } = require('../lib/qr-image');

const TICKET = JSON.stringify({ cb: 1, host: '127.0.0.2', port: 8790, code: '0123456789', fp: 'ab'.repeat(32) });

test('QR PNG roundtrip', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qr-'));
  const file = path.join(dir, 'qr.png');
  try {
    await writeQrPng(TICKET, file);
    assert.ok(fs.statSync(file).size > 100, 'PNG создан');
    assert.strictEqual(readQrPng(file), TICKET);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('нет файла — понятная ошибка', () => {
  assert.throws(() => readQrPng(path.join(os.tmpdir(), 'cb-no-such-qr.png')), /ENOENT/);
});

test('не PNG — отказ', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-qr-'));
  const file = path.join(dir, 'bad.png');
  try {
    fs.writeFileSync(file, 'not a png');
    assert.throws(() => readQrPng(file), /QR не распознан|не PNG|unexpected end/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
