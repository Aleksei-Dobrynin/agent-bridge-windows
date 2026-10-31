'use strict';
// win32-input-mode (\x1b[?9001h): клавиша — \x1b[Vk;Sc;Uc;Kd;Cs;Rc_ (виртуальный код, скан-код,
// символ, 1 — нажата / 0 — отпущена, модификаторы, повтор). Claude Code включает режим; после
// первой такой последовательности во вводе ConPTY теряет одиночный Esc (D-23.1, B-1), а консоль
// claude-mobile присылает клавиши в этой кодировке (D-23.2, B-2).

/** Esc: нажатие + отпускание. ConPTY принимает эту кодировку и без включённого режима. */
const ESC = '\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_';

/** Нажатие клавиши с символом 28 (FS) — Ctrl+\ в win32-input-mode. */
const CTRL_BACKSLASH_PRESS = /\x1b\[\d+;\d+;28;1;\d+;\d+_/;

/** Порция ввода консоли — Ctrl+\: сырой 0x1c целиком или нажатие в win32-input-mode
 *  (вместе с отпусканием и модификаторами, пришедшими той же порцией). */
function isCtrlBackslash(s) {
  return s === '\x1c' || CTRL_BACKSLASH_PRESS.test(s);
}

module.exports = { ESC, isCtrlBackslash };
