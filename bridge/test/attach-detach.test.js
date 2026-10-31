'use strict';
// Задача 1 подплана 4: claude-mobile при отсоединении выключает win32-input-mode своей консоли
// (\x1b[?9001l). Иначе после \x1b[?9001h от агента (Claude Code) следующая программа в этой
// консоли получает клавиши как \x1b[Vk;Sc;Uc;Kd;Cs;Rc_ (живая проверка D-23).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const pty = require('../node_modules/node-pty');
const H = require('./helpers/bridge');

test.after(() => setTimeout(() => process.exit(0), 300).unref()); // node-pty держит цикл событий

const WRAPPER = path.join(__dirname, 'fixtures', 'attach-then-echo.js');
let b;
test.before(async () => {
  b = await H.startTestBridge({
    prefix: 'cb-det-',
    config: { defaultAgent: 'echo', agents: { echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [H.FAKE_AGENT] } } },
  });
});
test.after(() => b && b.stop());

const until = async (fn, ms, what) => assert.ok(await H.waitFor(fn, ms), 'не дождались: ' + what);

test('after Ctrl+\\ the next program in the same console gets plain keys (\\x1b[?9001l on detach)', { timeout: 90000 }, async () => {
  const env = { ...process.env, CLAUDE_BRIDGE_HOME: b.home };
  const term = pty.spawn(process.execPath, [WRAPPER, '--agent', 'echo', '--w32-input'],
    { name: 'xterm', cols: 200, rows: 50, cwd: b.cwd, env });
  let raw = '';
  term.onData((d) => { raw += d; });
  const out = () => H.stripAnsi(raw);
  const got = () => out().match(/\[got [0-9a-f]+\]/g) || [];
  try {
    await until(() => /ARGV:\["--w32-input"\]/.test(out()), 20000, 'агент запущен: ' + out());
    term.write('\x1c'); // Ctrl+\ — консоль уже в win32-input-mode (D-23.2)
    await until(() => /\[attach exit 0\]/.test(out()) && /\[raw true\]/.test(out()), 15000,
      'claude-mobile отсоединился, raw-echo запущен: ' + JSON.stringify(out().slice(-300)));
    term.write('Z');
    await until(() => got().length > 0, 10000, 'raw-echo получил ввод');
    await H.sleep(300); // отпускание клавиши в win32-input-mode приходит второй порцией
    assert.deepStrictEqual(got(), ['[got 5a]'], 'консоль осталась в win32-input-mode: ' + JSON.stringify(out().slice(-300)));
    // D-26 п. 5: сброс режимов (с ?1049l) вне альтернативного экрана не переносит курсор в начало —
    // сырой вывод (без снятия ANSI) после агента не содержит перехода в строку 1, и следующие
    // строки идут после уже выведенных
    const tail = raw.slice(raw.lastIndexOf('ARGV:'));
    assert.doesNotMatch(tail, /\x1b\[(?:1?(?:;1?)?)H/, 'курсор ушёл в начало экрана: ' + JSON.stringify(tail));
    const plain = H.stripAnsi(tail);
    const iDetach = plain.indexOf('[отсоединился');
    const iExit = plain.indexOf('[attach exit 0]');
    assert.ok(iDetach > 0 && iExit > iDetach && plain.indexOf('[raw true]') > iExit, JSON.stringify(plain));
  } finally {
    try { term.kill(); } catch { /* вышел */ }
  }
});
