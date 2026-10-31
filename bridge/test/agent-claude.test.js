'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('../agents/claude');

const mk = (cfg = {}, opts = {}) => claude.create('claude', { command: process.execPath, prefixArgs: ['fake.js'], ...cfg }, opts);
const sess = () => ({ id: 's1-abcdef', cwd: 'C:\\', title: 't', agentState: {}, runtime: {} });
const kinds = (evs) => evs.map((e) => e.kind + (e.status ? ':' + e.status : ''));
const SUGG = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
const PR = (extra = {}) => ({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command: 'ls' }, permission_suggestions: SUGG, ...extra });
const okIo = (writes) => ({ write: (d) => { writes.push(d); return true; } });
const ALL3 = [{ id: 'once', label: 'Да' }, { id: 'always', label: 'Всегда' }, { id: 'reject', label: 'Нет' }];
const NO_ALWAYS = [{ id: 'once', label: 'Да' }, { id: 'reject', label: 'Нет' }];

test('declaration: options, wheel scroll, hook events, exe via shim', () => {
  const a = mk();
  assert.deepStrictEqual(a.options.map((o) => o.id), ['resume', 'skipPermissions']);
  assert.strictEqual(a.scroll, 'wheel');
  assert.strictEqual(a.events, 'hook');
  assert.strictEqual(a.available(), true);
  assert.strictEqual(claude.create('claude', {}, { findExe: () => 'C:\\x\\claude.exe' }).command, 'C:\\x\\claude.exe');
  assert.strictEqual(claude.create('claude', {}, { findExe: () => null }).available(), false);
});

test('I-5: claude.exe from PATH when there is no npm shim; shim wins when present', () => {
  const nat = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-native-'));
  const npm = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-npm-'));
  fs.writeFileSync(path.join(nat, 'claude.exe'), 'MZ');
  const rel = ['node_modules', '@anthropic-ai', 'claude-code', 'bin'];
  fs.writeFileSync(path.join(npm, 'claude.cmd'), '@echo off');
  fs.mkdirSync(path.join(npm, ...rel), { recursive: true });
  fs.writeFileSync(path.join(npm, ...rel, 'claude.exe'), 'MZ');
  const saved = process.env.PATH;
  try {
    process.env.PATH = nat;
    assert.strictEqual(claude.findClaudeExe(), path.join(nat, 'claude.exe'));
    assert.strictEqual(claude.create('claude', {}, {}).command, path.join(nat, 'claude.exe'));
    process.env.PATH = [nat, npm].join(';');
    assert.strictEqual(claude.findClaudeExe(), path.join(npm, ...rel, 'claude.exe'));
    process.env.PATH = path.join(nat, 'nothing-here');
    assert.strictEqual(claude.findClaudeExe(), null);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(nat, { recursive: true, force: true });
    fs.rmSync(npm, { recursive: true, force: true });
  }
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

test('PermissionRequest opens a request; "always" only with permission_suggestions', () => {
  const a = mk();
  const s = sess();
  const ev = a.onHook(s, PR({ tool_input: { command: 'echo hi' } }));
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.match(ev[0].requestId, /^req_[0-9a-f]{16}$/);
  assert.match(ev[0].message, /Bash: echo hi/);
  assert.deepStrictEqual(ev[0].choices, ALL3);
  for (const sug of [undefined, [], 'x', {}]) {
    const b = mk();
    const e = b.onHook(sess(), PR({ permission_suggestions: sug }));
    assert.deepStrictEqual(e[0].choices, NO_ALWAYS, JSON.stringify(sug));
  }
});

test('I-4: buttons only for allowlisted tools; others -> info notify, nothing opened', () => {
  for (const tool of ['Bash', 'PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
    'Read', 'Glob', 'Grep', 'Task', 'mcp__serena__find_symbol']) {
    assert.deepStrictEqual(kinds(mk().onHook(sess(), PR({ tool_name: tool }))), ['request', 'status:waiting'], tool);
  }
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'mcp_', 'bash', undefined]) {
    const a = mk();
    const s = sess();
    const ev = a.onHook(s, PR({ tool_name: tool }));
    assert.strictEqual(ev.length, 1, String(tool));
    assert.strictEqual(ev[0].kind, 'notify');
    assert.strictEqual(ev[0].choices, undefined);
    assert.deepStrictEqual(a.onInput(s, '1'), [], 'no request was opened for ' + tool);
  }
});

test('I-2: describeTool strips invisible/bidi chars, collapses whitespace, keeps the tail of long values', () => {
  const hidden = mk().onHook(sess(), PR({ tool_input: { command: 'echo ok' + '\n'.repeat(280) + 'rm -rf ~' } }));
  assert.match(hidden[0].message, /Bash: echo ok rm -rf ~/);
  const bidi = mk().onHook(sess(), PR({ tool_input: { command: 'echo \u202Eabc\u200B\uFEFFdef\u2028x\x85y\u2066z\t\r\n w' } }));
  assert.match(bidi[0].message, /Bash: echo abcdef x yz w$/);
  const long = 'echo ' + 'a'.repeat(500) + ' ; rm -rf ~';
  const ev = mk().onHook(sess(), PR({ tool_input: { command: long } }));
  const msg = ev[0].message;
  const full = 'Bash: ' + long;
  assert.ok(msg.includes(full.slice(0, 100) + '…' + full.slice(-60) + ` (${full.length} симв.)`), msg);
  assert.ok(msg.includes('rm -rf ~'));
});

test('I-1/M-4: terminal replies, focus, wheel and motion are passive (alone and mixed)', () => {
  const PASSIVE = {
    focusIn: '\x1b[I', focusOut: '\x1b[O',
    cpr: '\x1b[12;40R', da1: '\x1b[?1;2c', da2: '\x1b[>0;276;0c', da2empty: '\x1b[>c',
    decrpmPriv: '\x1b[?2026;2$y', decrpmAnsi: '\x1b[12;1$y',
    oscBel: '\x1b]11;rgb:0000/0000/0000\x07', oscSt: '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
    dcs: '\x1bP>|xterm.js(5.5.0)\x1b\\', kitty: '\x1b[?0u', kittyEmpty: '\x1b[?u',
    sgrWheelUp: '\x1b[<64;10;5M', sgrWheelDown: '\x1b[<65;10;5M', sgrShiftWheel: '\x1b[<68;1;1M',
    sgrCtrlWheel: '\x1b[<80;1;1M', sgrMotion: '\x1b[<35;10;5M', sgrDrag: '\x1b[<32;3;3M',
    x10Wheel: '\x1b[M' + String.fromCharCode(32 + 64, 33, 33), x10Motion: '\x1b[M' + String.fromCharCode(32 + 35, 40, 40),
    urxvtWheel: '\x1b[96;10;5M', urxvtMotion: '\x1b[67;10;5M',
  };
  const a = mk();
  const s = sess();
  a.onHook(s, PR());
  for (const [name, seq] of Object.entries(PASSIVE)) assert.deepStrictEqual(a.onInput(s, seq), [], name);
  assert.deepStrictEqual(a.onInput(s, Object.values(PASSIVE).join('')), [], 'mixed passive chunk');
  // нажатие кнопки мыши — ответ
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b[<0;10;5M')), ['requestClosed', 'status:working'], 'sgr press');
  a.onHook(s, PR());
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b[M' + String.fromCharCode(32, 40, 40))), ['requestClosed', 'status:working'], 'x10 press');
  // пассивные последовательности вместе с настоящей клавишей — ответ
  a.onHook(s, PR());
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b[I\x1b[12;40R1')), ['requestClosed', 'status:working'], 'mixed + key');
  a.onHook(s, PR());
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b[?1;2c\x1b')), ['requestClosed', 'status:working'], 'mixed + Esc is not a bare Esc');
  a.onHook(s, PR());
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b[A')), ['requestClosed', 'status:working'], 'arrow key');
  a.onHook(s, PR());
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b]11;unterminated')), ['requestClosed', 'status:working'], 'broken OSC');
});

test('I-3: parallel PermissionRequests are queued FIFO; closing promotes the next one', async () => {
  const a = mk();
  const s = sess();
  const writes = [];
  const first = a.onHook(s, PR({ tool_input: { command: 'one' } }));
  assert.deepStrictEqual(kinds(first), ['request', 'status:waiting']);
  assert.deepStrictEqual(a.onHook(s, PR({ tool_input: { command: 'two' } })), [], 'second is queued, not shown');
  assert.deepStrictEqual(a.onHook(s, PR({ tool_input: { command: 'three' } })), []);
  // PreToolUse не закрывает открытый запрос (без tool_use_id не сопоставить)
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } }), []);
  const r = await a.reply(s, { requestId: first[0].requestId }, 'once', okIo(writes));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(kinds(r.events), ['requestClosed', 'request', 'status:waiting']);
  assert.strictEqual(r.events[0].requestId, first[0].requestId);
  assert.match(r.events[1].message, /Bash: two/);
  assert.notStrictEqual(r.events[1].requestId, first[0].requestId);
  assert.deepStrictEqual(writes, ['1']);
  // ввод в PTY закрывает второй и открывает третий
  const ev = a.onInput(s, '1');
  assert.deepStrictEqual(kinds(ev), ['requestClosed', 'request', 'status:waiting']);
  assert.match(ev[1].message, /Bash: three/);
  // PostToolUse закрывает последний; очередь пуста — статус working
  assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {} })),
    ['requestClosed', 'status:working']);
  assert.deepStrictEqual(a.onInput(s, '1'), []);
});

test('I-3: PostToolUse of an already answered call does not close the next request', async () => {
  const a = mk();
  const s = sess();
  const ti1 = { command: 'one', description: 'd1' };
  const first = a.onHook(s, PR({ tool_input: ti1 }));
  a.onHook(s, PR({ tool_input: { command: 'two' } }));
  const r = await a.reply(s, { requestId: first[0].requestId }, 'once', okIo([]));
  const second = r.events[1].requestId;
  // вызов №1 выполнился — его PostToolUse не относится к открытому диалогу №2
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { description: 'd1', command: 'one' }, tool_use_id: 't1' }), []);
  // повторный PostToolUse с тем же вводом уже не «съедается»
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: ti1 }),
    [{ kind: 'requestClosed', requestId: second }, { kind: 'status', status: 'working' }]);
});

test('I-3: reject, UserPromptSubmit and Stop drop the queue (turn is over)', async () => {
  const s1 = sess();
  const a = mk();
  const first = a.onHook(s1, PR({ tool_input: { command: 'one' } }));
  a.onHook(s1, PR({ tool_input: { command: 'two' } }));
  const r = await a.reply(s1, { requestId: first[0].requestId }, 'reject', okIo([]));
  assert.deepStrictEqual(kinds(r.events), ['requestClosed', 'status:idle']);
  assert.deepStrictEqual(a.onInput(s1, '1'), []);

  a.onHook(s1, PR({ tool_input: { command: 'one' } }));
  a.onHook(s1, PR({ tool_input: { command: 'two' } }));
  assert.deepStrictEqual(kinds(a.onInput(s1, '\x1b')), ['requestClosed', 'status:idle']);
  assert.deepStrictEqual(a.onInput(s1, '1'), []);

  for (const name of ['UserPromptSubmit', 'Stop']) {
    a.onHook(s1, PR({ tool_input: { command: 'one' } }));
    a.onHook(s1, PR({ tool_input: { command: 'two' } }));
    const ev = a.onHook(s1, { hook_event_name: name });
    assert.strictEqual(ev[0].kind, 'requestClosed', name);
    assert.ok(!ev.some((e) => e.kind === 'request'), name);
    assert.deepStrictEqual(a.onInput(s1, '1'), [], name);
  }
});

test('lifecycle hooks; agent_id events are ignored for status', () => {
  const a = mk();
  const s = sess();
  assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: 'PreToolUse' })), ['status:working'], 'nothing open');
  for (const name of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']) {
    a.onHook(s, PR({ tool_input: {} }));
    assert.deepStrictEqual(a.onHook(s, { hook_event_name: name, agent_id: 'sub1' }), [], name + ' with agent_id');
    assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: name })), ['requestClosed', 'status:working'], name);
  }
  a.onHook(s, PR({ tool_input: {} }));
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'PreToolUse' }), [], 'PreToolUse keeps the request');
  assert.deepStrictEqual(kinds(a.onHook(s, { hook_event_name: 'PermissionDenied' })), ['requestClosed']);
  assert.deepStrictEqual(a.onHook(s, { hook_event_name: 'Stop', agent_id: 'sub1' }), []);
  const stop = a.onHook(s, { hook_event_name: 'Stop' });
  assert.deepStrictEqual(kinds(stop), ['status:idle', 'notify']);
  assert.strictEqual(stop[1].done, true);
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
  assert.deepStrictEqual(a.onHook(s, { ...base, hook_event_name: 'Notification',
    notification_type: 'permission_prompt', message: 'Claude needs your permission' }), []);
  assert.deepStrictEqual(kinds(a.onInput(s, '\x1b')), ['requestClosed', 'status:idle']);
});

test('M-3: Notification permission_prompt — fallback source, late duplicate, info after PermissionRequest era', () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const NP = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' };

  // запасной путь: PermissionRequest не видели — уведомление открывает запрос (без «Всегда»)
  const a = mk({}, clock);
  const s = sess();
  const ev = a.onHook(s, NP);
  assert.deepStrictEqual(kinds(ev), ['request', 'status:waiting']);
  assert.deepStrictEqual(ev[0].choices, NO_ALWAYS);
  assert.deepStrictEqual(a.onHook(s, NP), [], 'duplicate while open');
  assert.deepStrictEqual(kinds(a.onInput(s, '1')), ['requestClosed', 'status:working']);
  now += 7000;
  assert.deepStrictEqual(a.onHook(s, NP), [], 'within 8 s after active input');
  now += 2000;
  assert.deepStrictEqual(kinds(a.onHook(s, NP)), ['request', 'status:waiting'], 'later — a new dialog');

  // активный ввод учитывается и без открытого запроса
  const b = mk({}, clock);
  const sb = sess();
  b.onInput(sb, 'y');
  now += 1000;
  assert.deepStrictEqual(b.onHook(sb, NP), [], 'input just before');

  // после PermissionRequest: при открытом — тишина; без открытого и без свежего ввода — info
  const c = mk({}, clock);
  const sc = sess();
  c.onHook(sc, PR());
  assert.deepStrictEqual(c.onHook(sc, NP), []);
  c.onInput(sc, '1');
  now += 5000;
  assert.deepStrictEqual(c.onHook(sc, NP), [], 'late notification of the answered dialog');
  now += 4000;
  assert.deepStrictEqual(c.onHook(sc, NP), [{ kind: 'notify', message: 'Claude needs your permission' }]);
  // ответ через reply — тоже активный ввод
  const r = c.onHook(sc, PR());
  return c.reply(sc, { requestId: r[0].requestId }, 'once', okIo([])).then(() => {
    now += 1000;
    assert.deepStrictEqual(c.onHook(sc, NP), [], 'right after reply');
  });
});

test('other Notification -> info notify', () => {
  const a = mk();
  assert.deepStrictEqual(a.onHook(sess(), { hook_event_name: 'Notification', message: 'Claude is waiting for your input' }),
    [{ kind: 'notify', message: 'Claude is waiting for your input' }]);
});

test('reply: decision -> key; stale; M-1 invalid decision; M-2 failed write keeps the request open', async () => {
  const a = mk();
  const s = sess();
  const writes = [];
  const io = okIo(writes);
  for (const [decision, key, status] of [['once', '1', 'working'], ['always', '2', 'working'], ['reject', '\x1b', 'idle']]) {
    const ev = a.onHook(s, PR());
    const r = await a.reply(s, { requestId: ev[0].requestId }, decision, io);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(kinds(r.events), ['requestClosed', 'status:' + status]);
    assert.strictEqual(writes.pop(), key);
  }
  // M-1: неверное решение при открытом запросе — отказ без закрытия
  const ev = a.onHook(s, PR({ permission_suggestions: [] }));
  for (const bad of ['always', 'maybe', undefined, 'constructor']) {
    assert.deepStrictEqual(await a.reply(s, { requestId: ev[0].requestId }, bad, io), { ok: false, events: [] }, String(bad));
  }
  assert.deepStrictEqual(writes, []);
  // M-2: клавиша не дошла до PTY — failed, запрос открыт
  const failIo = { write: (d) => { writes.push(d); return false; } };
  assert.deepStrictEqual(await a.reply(s, { requestId: ev[0].requestId }, 'once', failIo), { ok: false, error: 'failed', events: [] });
  assert.strictEqual((await a.reply(s, { requestId: ev[0].requestId }, 'once', io)).ok, true);
  assert.deepStrictEqual(writes, ['1', '1']);
  writes.length = 0;
  // устаревший запрос
  const old = a.onHook(s, PR());
  a.onInput(s, 'x');
  const r = await a.reply(s, { requestId: old[0].requestId }, 'once', io);
  assert.deepStrictEqual(r, { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: old[0].requestId }] });
  assert.deepStrictEqual(writes, []);
});

test('M-5: missing runtime is created lazily; bad input never throws', async () => {
  const a = mk();
  const s = { id: 'x', cwd: 'C:\\', title: 't', agentState: {} };
  assert.deepStrictEqual(kinds(a.onHook(s, PR())), ['request', 'status:waiting']);
  assert.ok(s.runtime && s.runtime.claude);
  const s2 = { id: 'y' };
  assert.deepStrictEqual(a.onInput(s2, '1'), []);
  for (const p of [null, 5, 'x', [], { hook_event_name: 5 }, { hook_event_name: 'PermissionRequest', tool_input: 'str' }]) {
    assert.doesNotThrow(() => a.onHook(sess(), p), JSON.stringify(p));
  }
  for (const d of [null, 5, {}, '']) assert.deepStrictEqual(a.onInput(sess(), d), []);
  assert.deepStrictEqual(await a.reply(sess(), null, 'once', okIo([])), { ok: false, stale: true, events: [] });
});

test('M-6: sawPermissionRequest is persisted in agentState and survives a bridge restart (fresh runtime)', () => {
  const NP = { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' };
  const a = mk();
  const s = sess();
  a.onHook(s, PR());
  assert.strictEqual(s.agentState.sawPermissionRequest, true, 'flag in persisted adapter state');
  a.onInput(s, '1');
  // рестарт моста: agentState из meta, runtime пустой — уведомление не открывает запрос с кнопками
  const restored = { ...sess(), agentState: JSON.parse(JSON.stringify(s.agentState)) };
  assert.deepStrictEqual(mk().onHook(restored, NP), [{ kind: 'notify', message: 'Claude needs your permission' }]);
  // без флага — запасной путь (запрос)
  assert.deepStrictEqual(kinds(mk().onHook(sess(), NP)), ['request', 'status:waiting']);
  // agentState отсутствует / не объект — не бросает
  assert.doesNotThrow(() => mk().onHook({ id: 'z' }, PR()));
});
