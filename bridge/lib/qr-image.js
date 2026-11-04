'use strict';
// D-29: QR сопряжения ПК-клиента. Запись — qrcode (PNG), чтение — pngjs (пиксели) + jsqr (матрица).
const fs = require('fs');
const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

/** Записать текст в PNG с QR. Возвращает путь. */
async function writeQrPng(text, file) {
  if (typeof text !== 'string' || !text) throw new Error('нет данных для QR');
  await QRCode.toFile(file, text, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
  return file;
}

/** Прочитать строку из PNG с QR. Бросает, если QR не найден. */
function readQrPng(file) {
  const buf = fs.readFileSync(file);
  let png;
  try {
    png = PNG.sync.read(buf);
  } catch (err) {
    throw new Error(`не PNG или повреждённый файл: ${err.message}`);
  }
  const found = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!found || typeof found.data !== 'string' || !found.data) throw new Error('QR не распознан');
  return found.data;
}

module.exports = { writeQrPng, readQrPng };
