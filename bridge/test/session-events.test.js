'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SE = require('../lib/session-events');

const mk = () => ({ id: 's1-abcdef', title: 'proj · Claude Code', status: 'idle', pending: new Map(), lastNotify: null });

test('status: broadcast only on change', () => {
  const s = mk();
  let r = SE.applyEvents(s, [{ kind: 'status', status: 'working' }, { kind: 'status', status: 'working' }, { kind: 'status', status: 'bogus' }], 1000);
  assert.deepStrictEqual(r.messages, [{ type: 'status', id: s.id, status: 'working' }]);
  assert.strictEqual(r.sessionsChanged, true);
  r = SE.applyEvents(s, [{ kind: 'status', status: 'working' }], 1000);
  assert.deepStrictEqual(r, { messages: [], sessionsChanged: false });
});

test('request: stored as pending, notify carries requestId and filtered choices', () => {
  const s = mk();
  const r = SE.applyEvents(s, [{ kind: 'request', requestId: 'req_1', message: 'm', choices: [
    { id: 'once', label: 'Да' }, { id: 'evil', label: 'x' }, { id: 'reject', label: 'Нет' }, null] }], 5);
  assert.deepStrictEqual(r.messages, [{ type: 'notify', id: s.id, event: 'request', requestId: 'req_1',
    choices: [{ id: 'once', label: 'Да' }, { id: 'reject', label: 'Нет' }], message: 'm', title: s.title, at: 5 }]);
  assert.deepStrictEqual(s.pending.get('req_1'), { requestId: 'req_1', message: 'm',
    choices: [{ id: 'once', label: 'Да' }, { id: 'reject', label: 'Нет' }], at: 5 });
  assert.deepStrictEqual(s.lastNotify, { event: 'request', message: 'm', at: 5 });
});

test('request: invalid ids are ignored; pending map is created when missing', () => {
  const s = { id: 's2', title: 't', status: 'idle' };
  const r = SE.applyEvents(s, [{ kind: 'request', requestId: '', message: 'm' }, { kind: 'request', requestId: 'x'.repeat(129) },
    { kind: 'request', requestId: 42 }, null, 'junk', { kind: 'unknown' }], 1);
  assert.deepStrictEqual(r, { messages: [], sessionsChanged: false });
  assert.strictEqual(s.pending.size, 0);
  assert.deepStrictEqual(SE.applyEvents(s, 'not an array'), { messages: [], sessionsChanged: false });
});

test('requestClosed: only known requests are broadcast', () => {
  const s = mk();
  SE.applyEvents(s, [{ kind: 'request', requestId: 'req_1', message: 'm', choices: [] }], 1);
  assert.deepStrictEqual(SE.applyEvents(s, [{ kind: 'requestClosed', requestId: 'req_x' }]).messages, []);
  assert.deepStrictEqual(SE.applyEvents(s, [{ kind: 'requestClosed', requestId: 'req_1' }]).messages,
    [{ type: 'requestClosed', id: s.id, requestId: 'req_1' }]);
  assert.strictEqual(s.pending.size, 0);
});

test('notify: done vs info; long messages and labels are clipped', () => {
  const s = mk();
  const r = SE.applyEvents(s, [{ kind: 'notify', message: 'fin', done: true }, { kind: 'notify', message: 'hey' }], 7);
  assert.deepStrictEqual(r.messages.map((m) => [m.event, m.message]), [['done', 'fin'], ['info', 'hey']]);
  assert.deepStrictEqual(s.lastNotify, { event: 'info', message: 'hey', at: 7 });
  const big = SE.applyEvents(s, [{ kind: 'request', requestId: 'r', message: 'x'.repeat(2000),
    choices: [{ id: 'once', label: 'y'.repeat(100) }] }], 8).messages[0];
  assert.strictEqual(big.message.length, 500);
  assert.strictEqual(big.choices[0].label.length, 40);
});

test('closeAllRequests', () => {
  const s = mk();
  SE.applyEvents(s, [{ kind: 'request', requestId: 'a', message: '', choices: [] }, { kind: 'request', requestId: 'b', message: '', choices: [] }]);
  assert.deepStrictEqual(SE.closeAllRequests(s).map((m) => m.requestId), ['a', 'b']);
  assert.strictEqual(s.pending.size, 0);
  assert.deepStrictEqual(SE.closeAllRequests({ id: 'no-pending' }), []);
});
