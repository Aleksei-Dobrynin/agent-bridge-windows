'use strict';
const test = require('node:test');
const assert = require('node:assert');
const claude = require('../agents/claude');

const mk = (cfg = {}) => claude.create('claude', { command: process.execPath, prefixArgs: ['fake.js'], ...cfg }, {});
const sess = () => ({ id: 's1-abcdef', cwd: 'C:\\', title: 't', agentState: {}, runtime: {} });
const kinds = (evs) => evs.map((e) => e.kind + (e.status ? ':' + e.status : ''));

test('declaration: options, wheel scroll, hook events, exe via shim', () => {
  const a = mk();
  assert.deepStrictEqual(a.options.map((o) => o.id), ['resume', 'skipPermissions']);
  assert.strictEqual(a.scroll, 'wheel');
  assert.strictEqual(a.events, 'hook');
  assert.strictEqual(a.available(), true);
  assert.strictEqual(claude.create('claude', {}, { findExe: () => 'C:\\x\\claude.exe' }).command, 'C:\\x\\claude.exe');
  assert.strictEqual(claude.create('claude', {}, { findExe: () => null }).available(), false);
});

test('spawnSpec: options -> flags, owner raw args appended', async () => {
  const a = mk();
  const spec = await a.spawnSpec({ cwd: 'C:\\', title: 't', options: { resume: true, skipPermissions: true }, rawArgs: ['--model', 'haiku'] });
  assert.deepStrictEqual(spec, {
    command: process.execPath,
    args: ['fake.js', '--resume', '--dangerously-skip-permissions', '--model', 'haiku'],
    env: {}, state: {},
  });
  assert.deepStrictEqual((await a.spawnSpec({ cwd: 'C:\\', title: 't', options: {}, rawArgs: [] })).args, ['fake.js']);
});

test('isResumeLike: option or raw flag', () => {
  const a = mk();
  assert.strictEqual(a.isResumeLike({ options: { resume: true }, rawArgs: [] }), true);
  for (const f of ['--resume', '-r', '--continue', '-c']) assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: [f] }), true, f);
  assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: ['--model'] }), false);
});

test('PermissionRequest opens a request with choices; duplicate Notification ignored', () => {
  const a = mk();
  const s = sess();
  const ev = a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.match(ev[0].requestId, /^req_[0-9a-f]{16}$/);
  assert.match(ev[0].message, /Bash: echo hi/);
  assert.deepStrictEqual(ev[0].choices, [{ id: 'once', label: 'Да' }, { id: 'always', label: 'Всегда' }, { id: 'reject', label: 'Нет' }]);
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' }), []);
});

test('real 2.1.284 sequence (task 2 probe): PreToolUse, PermissionRequest, late Notification', () => {
  const a = mk();
  const s = sess();
  const base = { session_id: 'x', cwd: 'C:\\p', permission_mode: 'default', prompt_id: 'p' };
  assert.deepStrictEqual(kinds(a.onHook(s, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'touch' })), ['status:working']);
  assert.deepStrictEqual(kinds(a.onHook(s, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'touch cb-probe.txt' }, tool_use_id: 'toolu_1' })), ['status:working']);
  const ev = a.onHook(s, { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    tool_input: { command: 'touch cb-probe.txt', description: 'Create file cb-probe.txt' },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.match(ev[0].message, /Bash: touch cb-probe\.txt/);
  // ~6 с спустя — Notification без имени инструмента: не дублирует запрос
  assert.deepStrictEqual(a.onHook(s, { ...base, hook_event_name: 'Notification',
    notification_type: 'permission_prompt', message: 'Claude needs your permission' }), []);
  // после Esc хуков нет — закрывает только ввод
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b')), ['requestClosed', 'status:idle']);
});

test('Notification permission_prompt is the fallback source; ignored right after a close', () => {
  const a = mk();
  const s = sess();
  const ev = a.onHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.match(ev[0].message, /permission to use Bash/);
  const closed = a.onInput(s, '1');
  assert.deepStrictEqual(kinds(closed), ['requestClosed', 'status:working']);
  // запоздавшее уведомление о уже закрытом диалоге не открывает новый запрос
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }), []);
});

test('other Notification -> info notify', () => {
  const a = mk();
  assert.deepStrictEqual(a.onHook(sess(), { hook_event_name: 'Notification', message: 'Claude is waiting for your input' }),
    [{ kind: 'notify', message: 'Claude is waiting for your input' }]);
});

test('onInput: focus and wheel reports do not close; keys do', () => {
  const a = mk();
  const s = sess();
  assert.deepStrictEqual(a.onInput(s, '1'), [], 'nothing open');
  a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepStrictEqual(a.onInput(s, '\x1b[I'), []);
  assert.deepStrictEqual(a.onInput(s, '\x1b[O\x1b[<64;10;5M\x1b[<65;10;5M'), []);
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b')), ['requestClosed', 'status:idle']);
  a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepStrictEqual(kinds(a.onInput(s, 'hello')), ['requestClosed', 'status:working']);
});

test('lifecycle hooks close the request; agent_id events are ignored', () => {
  const a = mk();
  const s = sess();
  for (const name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    assert.deepStrictEqual(a.onHook(s, { hook_event_name: name, agent_id: 'sub1' }), [], name + ' with agent_id');
    assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: name })), ['requestClosed', 'status:working'], name);
  }
  a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: 'PermissionDenied' })), ['requestClosed']);
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Stop', agent_id: 'sub1' }), []);
  const stop = a.onHook(s, { hook_event_name: 'Stop' });
  assert.deepStrictEqual(kinds(stop), ['status:idle', 'notify']);
  assert.strictEqual(stop[1].done, true);
});

test('reply: decision -> key, stale request refused without writing', async () => {
  const a = mk();
  const s = sess();
  const writes = [];
  const io = { write: (d) => writes.push(d) };
  for (const [decision, key, status] of [['once', '1', 'working'], ['always', '2', 'working'], ['reject', '\x1b', 'idle']]) {
    const ev = a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    const r = await a.reply(s, { requestId: ev[0].requestId }, decision, io);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(kinds(r.events), ['requestClosed', 'status:' + status]);
    assert.strictEqual(writes.pop(), key);
  }
  const old = a.onHook(s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  a.onInput(s, 'x');
  const r = await a.reply(s, { requestId: old[0].requestId }, 'once', io);
  assert.deepStrictEqual(r, { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: old[0].requestId }] });
  assert.deepStrictEqual(writes, []);
});
