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

test('buildCreate: only agent id and ids of enabled options (P-3)', () => {
  assert.deepStrictEqual(CB.buildCreate('claude', ['resume', '', 5], 'C:\w'),
    { type: 'create', agent: 'claude', options: { resume: true }, cwd: 'C:\w' });
  assert.deepStrictEqual(CB.buildCreate('opencode', [], 'C:\w'),
    { type: 'create', agent: 'opencode', options: {}, cwd: 'C:\w' });
  // поправка 8 / D-22.4: агент не выбран -> null (агент по умолчанию на мосту)
  assert.deepStrictEqual(CB.buildCreate('', null, 'C:\w'),
    { type: 'create', agent: null, options: {}, cwd: 'C:\w' });
});

test('confirmPrompt: message, warning and 4-digit check code (D-13, D-22.3)', () => {
  assert.deepStrictEqual(CB.confirmPrompt({ confirmId: 'cf_1', message: 'Выпустить код?', checkCode: '0427' }),
    { text: 'Выпустить код?\n\nЕсли вы этого не запускали — отклоните.', code: '0427' });
  const p = CB.confirmPrompt({ confirmId: 'cf_2' });
  assert.match(p.text, /^Разрешить операцию на ПК\?/);
  assert.strictEqual(p.code, '');
  assert.strictEqual(CB.confirmPrompt({ checkCode: '12a4' }).code, '', 'only 4 digits');
  assert.strictEqual(CB.confirmPrompt({ checkCode: 1234 }).code, '', 'only a string');
});

test('confirmStatusText: confirmResult incl. cooldown, confirmPending with code', () => {
  assert.strictEqual(CB.confirmStatusText({ type: 'confirmResult', allow: false, reason: 'cooldown', retryAfterSec: 42 }),
    '⏳ Повторить можно через 42 с — после отказа на телефоне действует пауза');
  assert.strictEqual(CB.confirmStatusText({ type: 'confirmResult', allow: false, reason: 'cooldown', retryAfterSec: 125 }),
    '⏳ Повторить можно через 3 мин — после отказа на телефоне действует пауза');
  assert.match(CB.confirmStatusText({ type: 'confirmResult', allow: false, reason: 'denied' }), /Отклонено на телефоне/);
  assert.match(CB.confirmStatusText({ type: 'confirmResult', allow: false, reason: 'timeout' }), /не ответил/);
  assert.match(CB.confirmStatusText({ type: 'confirmResult', allow: true, reason: 'allowed' }), /Подтверждено/);
  assert.strictEqual(CB.confirmStatusText({ type: 'confirmPending', message: 'Подтвердите на телефоне…', checkCode: '0427' }),
    '📱 Подтвердите на телефоне… Код: 0427');
  assert.match(CB.confirmStatusText({ type: 'confirmRequired', action: 'pairinfo' }), /claude-mobile/);
  assert.strictEqual(CB.confirmStatusText({ type: 'output' }), null);
});

test('replayGate: active while any scrollback replay is in progress, end is idempotent (D-19.1)', () => {
  const g = CB.replayGate();
  assert.strictEqual(g.active(), false);
  const end1 = g.begin();
  const end2 = g.begin();
  assert.strictEqual(g.active(), true);
  end1();
  end1(); // повторный вызов не снимает чужое проигрывание
  assert.strictEqual(g.active(), true);
  end2();
  assert.strictEqual(g.active(), false);
});
