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
  assert.deepStrictEqual(CB.buildCreate('claude', ['resume', '', 5], 'C:\\w'),
    { type: 'create', agent: 'claude', options: { resume: true }, cwd: 'C:\\w' });
  assert.deepStrictEqual(CB.buildCreate('opencode', [], 'C:\\w'),
    { type: 'create', agent: 'opencode', options: {}, cwd: 'C:\\w' });
  // поправка 8 / D-22.4: агент не выбран -> null (агент по умолчанию на мосту)
  assert.deepStrictEqual(CB.buildCreate('', null, 'C:\\w'),
    { type: 'create', agent: null, options: {}, cwd: 'C:\\w' });
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

const REQ = (o = {}) => ({ type: 'notify', id: 's_a', event: 'request', requestId: 'req_1', message: 'Bash: ls',
  title: 'w · Claude Code', at: 100, choices: [{ id: 'once', label: 'Да' }, { id: 'always', label: 'Всегда: ls *' },
    { id: 'reject', label: 'Нет' }], ...o });

test('requestStore: buttons only for request with choices; idempotent by requestId (D-4, D-20)', () => {
  const r = CB.requestStore();
  assert.strictEqual(r.add(REQ({ choices: [] })), null, 'no choices -> no buttons');
  assert.strictEqual(r.add(REQ({ choices: undefined })), null);
  assert.strictEqual(r.add(REQ({ event: 'info' })), null, 'info notify -> no buttons');
  assert.strictEqual(r.add(REQ({ requestId: '' })), null);
  assert.strictEqual(r.top(), null);
  assert.strictEqual(r.add(REQ()), 'new');
  assert.strictEqual(r.add(REQ()), 'dup', 'same requestId again (replay) -> no duplicate');
  assert.strictEqual(r.count(), 1);
  const t = r.top();
  assert.deepStrictEqual(t.choices.map((c) => c.label), ['Да', 'Всегда: ls *', 'Нет'], 'labels as provided');
  assert.strictEqual(t.message, 'Bash: ls');
  // переподключение: мост повторяет открытые запросы — они «знакомые», не новые
  r.reconnect();
  assert.strictEqual(r.top(), null, 'stale entries dropped until the bridge replays them');
  assert.strictEqual(r.add(REQ()), 'replayed');
  assert.strictEqual(r.add(REQ({ requestId: 'req_2', at: 200 })), 'new');
  assert.strictEqual(r.count(), 2);
});

test('requestStore: top prefers the current session, then the latest; close and retain', () => {
  const r = CB.requestStore();
  r.add(REQ({ id: 's_a', requestId: 'req_a', at: 100 }));
  r.add(REQ({ id: 's_b', requestId: 'req_b', at: 300 }));
  r.add(REQ({ id: 's_a', requestId: 'req_a2', at: 200 }));
  assert.strictEqual(r.top().requestId, 'req_b');
  assert.strictEqual(r.top('s_a').requestId, 'req_a2');
  assert.strictEqual(r.top('s_x').requestId, 'req_b');
  assert.strictEqual(r.close('s_a', 'req_a2'), true);
  assert.strictEqual(r.close('s_a', 'req_a2'), false);
  assert.strictEqual(r.top('s_a').requestId, 'req_a');
  r.retain(['s_a']);
  assert.strictEqual(r.top().requestId, 'req_a');
  assert.strictEqual(r.count(), 1);
});

test('buildReply: semantic reply for a request (D-4)', () => {
  assert.deepStrictEqual(CB.buildReply({ id: 's_a', requestId: 'req_1' }, 'always'),
    { type: 'reply', id: 's_a', requestId: 'req_1', decision: 'always' });
});

test('armGuard: a newly shown item accepts input only after the delay and only for itself (I-1, I-2)', () => {
  const g = CB.armGuard(500);
  assert.strictEqual(g.ready(0), false, 'nothing armed');
  assert.strictEqual(g.arm('req_1', 1000), true, 'new key -> armed anew');
  assert.strictEqual(g.ready(1499), false);
  assert.strictEqual(g.accept('req_1', 1499), false, 'too early (double tap)');
  assert.strictEqual(g.ready(1500), true);
  assert.strictEqual(g.accept('req_1', 1500), true);
  assert.strictEqual(g.accept('req_0', 1600), false, 'click for another item');
  assert.strictEqual(g.arm('req_1', 1700), false, 'same key -> keeps arming time');
  assert.strictEqual(g.accept('req_1', 1700), true);
  // следующий запрос под пальцем — снова пауза
  assert.strictEqual(g.arm('req_2', 1800), true);
  assert.strictEqual(g.accept('req_2', 1900), false);
  assert.strictEqual(g.accept('req_1', 2400), false);
  assert.strictEqual(g.accept('req_2', 2300), true);
  // force: тот же ключ, но показан заново (диалог открыт снова)
  assert.strictEqual(g.arm('req_2', 3000, true), true);
  assert.strictEqual(g.accept('req_2', 3100), false);
  // null — ничего не показано
  g.arm(null, 4000);
  assert.strictEqual(g.accept(null, 9000), false);
  assert.strictEqual(g.ready(9000), false);
  assert.strictEqual(g.key(), null);
  assert.strictEqual(g.remaining(1000), 0);
  g.arm('k', 5000);
  assert.strictEqual(g.remaining(5100), 400);
  assert.strictEqual(g.remaining(6000), 0);
});
