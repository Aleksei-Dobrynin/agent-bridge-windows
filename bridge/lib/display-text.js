'use strict';
// Текст из недоверенного источника (команда агента, описание запроса) для показа человеку
// в уведомлении (D-19 п. 2): невидимые/bidi символы (Cf, CGJ, заполнители хангыля, селекторы
// вариантов) вырезаются, управляющие C0/C1 и разделители строк/абзацев становятся пробелами,
// пробелы схлопываются; длинное значение —
// «начало…конец (N симв.)», чтобы опасный хвост команды был виден. Иначе prompt injection
// прячет хвост за переводами строк — а именно его человек одобряет с телефона.

const CLIP = Object.freeze({ max: 200, head: 100, tail: 60 });

function cleanText(s) {
  return String(s)
    // невидимые: Cf (bidi, zero-width, BOM, мягкий перенос), CGJ, заполнители хангыля, селекторы вариантов
    .replace(/[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F]/gu, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Длиннее max кодовых точек -> head + '…' + tail + ' (N симв.)'. */
function clipMiddle(s, { max = CLIP.max, head = CLIP.head, tail = CLIP.tail } = {}) {
  const t = String(s);
  const cps = Array.from(t);
  if (cps.length <= max) return t;
  return cps.slice(0, head).join('') + '…' + cps.slice(-tail).join('') + ` (${cps.length} симв.)`;
}

const displayText = (s, clip) => clipMiddle(cleanText(s), clip);

module.exports = { cleanText, clipMiddle, displayText };
