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

// подпись кнопки ответа: мост обрезает её до 40 единиц UTF-16 (session-events.cleanChoices)
const LABEL_MAX = 40;

/**
 * Подпись кнопки (D-23.6): prefix + очищенное detail, не длиннее max единиц UTF-16;
 * длинное detail — «начало…конец» (конец длиннее: хвост пути/команды важнее). Пустое detail —
 * только prefix (без хвостовых пробелов).
 */
function labelText(prefix, detail, max = LABEL_MAX) {
  const p = String(prefix);
  const d = cleanText(detail);
  if (!d) return cleanText(p);
  if ((p + d).length <= max) return p + d;
  const cps = Array.from(d);
  let room = max - p.length - 1; // 1 — «…»
  for (; room > 0; room--) {
    const tail = Math.ceil(room * 0.6);
    const out = p + cps.slice(0, room - tail).join('') + '…' + cps.slice(cps.length - tail).join('');
    if (out.length <= max) return out;
  }
  return (p + '…').slice(0, max);
}

module.exports = { cleanText, clipMiddle, displayText, labelText, LABEL_MAX };
