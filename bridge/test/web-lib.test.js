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

test('armGuard for the confirm dialog: 700 ms after shown, re-armed on new confirmId or re-show (I-2)', () => {
  const g = CB.armGuard(700);
  g.arm('cf_1', 0, true); // показан
  assert.strictEqual(g.accept('cf_1', 699), false);
  assert.strictEqual(g.accept('cf_1', 700), true);
  assert.strictEqual(g.arm('cf_1', 800, false), false, 'same request while open -> stays armed');
  assert.strictEqual(g.accept('cf_1', 800), true);
  assert.strictEqual(g.arm('cf_2', 900, false), true, 'content changed');
  assert.strictEqual(g.accept('cf_2', 1599), false);
  assert.strictEqual(g.accept('cf_2', 1600), true);
  assert.strictEqual(g.arm('cf_2', 5000, true), true, 'shown again after close');
  assert.strictEqual(g.accept('cf_2', 5100), false);
});

test('filterPaste removes all format chars (Cf), line/paragraph separators -> newline (review M-1)', () => {
  const ch = (...cps) => String.fromCodePoint(...cps);
  // U+061C, U+2060..2064, U+00AD, U+180E, U+FFF9..FFFB, теги U+E0001, U+E0041, U+E007F
  for (const cp of [0x061c, 0x2060, 0x2064, 0x00ad, 0x180e, 0xfff9, 0xfffb, 0xe0001, 0xe0041, 0xe007f,
    0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
    assert.strictEqual(CB.filterPaste('a' + ch(cp) + 'b'), 'ab', 'U+' + cp.toString(16));
  }
  assert.strictEqual(CB.filterPaste('a' + ch(0x2028) + 'b' + ch(0x2029) + 'c'), 'a\nb\nc');
  // обычные не-ASCII символы остаются (эмодзи, кириллица, CJK)
  assert.strictEqual(CB.filterPaste('ок ' + ch(0x1f600) + ' ' + ch(0x4e2d)), 'ок ' + ch(0x1f600) + ' ' + ch(0x4e2d));
});

test('boundedSet keeps only the last N ids; requestStore seen list is bounded (review M-5)', () => {
  const s = CB.boundedSet(3);
  for (const k of ['a', 'b', 'c', 'd']) s.add(k);
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((k) => s.has(k)), [false, true, true, true]);
  s.add('b'); // повторное добавление освежает
  s.add('e');
  assert.deepStrictEqual(['b', 'c', 'd', 'e'].map((k) => s.has(k)), [true, false, true, true]);
  assert.strictEqual(s.size(), 3);
  const r = CB.requestStore({ seenLimit: 2 });
  for (const id of ['req_1', 'req_2', 'req_3']) r.add(REQ({ requestId: id }));
  r.reconnect();
  assert.strictEqual(r.add(REQ({ requestId: 'req_3' })), 'replayed');
  assert.strictEqual(r.add(REQ({ requestId: 'req_1' })), 'new', 'forgotten id');
  assert.strictEqual(CB.requestStore().add(REQ()), 'new', 'default limit');
});

test('confirmStatusText shows checkCode only when it is 4 digits (review M-6)', () => {
  assert.strictEqual(CB.confirmStatusText({ type: 'confirmPending', message: 'Ждём', checkCode: '12345' }), '📱 Ждём');
  assert.strictEqual(CB.confirmStatusText({ type: 'confirmPending', message: 'Ждём', checkCode: 'x\n1' }), '📱 Ждём');
  assert.strictEqual(CB.confirmStatusText({ type: 'confirmPending', message: 'Ждём', checkCode: '0001' }), '📱 Ждём Код: 0001');
});

test('errorText: bridge text or a fallback (review M-7)', () => {
  assert.strictEqual(CB.errorText({ type: 'error', message: 'нет LAN-адреса' }), '⚠ нет LAN-адреса');
  assert.strictEqual(CB.errorText({ type: 'error' }), '⚠ Ошибка моста');
  assert.strictEqual(CB.errorText({ type: 'error', message: '' }), '⚠ Ошибка моста');
  assert.strictEqual(CB.errorText({ type: 'error', message: { x: 1 } }), '⚠ Ошибка моста');
});

test('notifyTitle: agent name of the session, fallback "Agent Bridge" (review M-9)', () => {
  const list = [{ id: 's_a', agentName: 'opencode' }, { id: 's_b' }];
  assert.strictEqual(CB.notifyTitle(list, 's_a'), 'opencode');
  assert.strictEqual(CB.notifyTitle(list, 's_b'), 'Agent Bridge');
  assert.strictEqual(CB.notifyTitle(list, ''), 'Agent Bridge');
  assert.strictEqual(CB.notifyTitle(null, 's_a'), 'Agent Bridge');
});
