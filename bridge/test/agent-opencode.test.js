'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const oc = require('../agents/opencode');
const { OpencodeClient } = require('../agents/opencode-client');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error('условие не выполнено');
}
const dirs = [];
const fakes = [];
const clients = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-oca-')); dirs.push(d); return d; };
test.afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const f of fakes.splice(0)) await f.close();
});
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const fake = await startFakeOpencode();
  fakes.push(fake);
  const client = new OpencodeClient({ file: fake.writeServiceFile(tmp()), backoffMs: 50 });
  clients.push(client);
  const a = oc.create('opencode', { command: process.execPath, prefixArgs: ['fake-tui.js'] }, { opencodeClient: client });
  return { fake, client, a };
}

/** Клиент-заглушка: тест сам подаёт события в обработчик подписки. */
function stubClient() {
  const stub = { handler: null, replies: [], replyResult: 'ok' };
  stub.subscribe = (sid, h) => { stub.handler = h; return () => { stub.handler = null; }; };
  stub.replyPermission = async (sid, rid, decision) => {
    stub.replies.push([sid, rid, decision]);
    if (stub.replyResult instanceof Error) throw stub.replyResult;
    return stub.replyResult;
  };
  return stub;
}

test('declaration: askShell option, wheel scroll, sse events', async () => {
  const { a } = await setup();
  assert.deepStrictEqual(a.options, [{ id: 'askShell', label: 'Спрашивать разрешение на команды', type: 'bool' }]);
  assert.strictEqual(a.scroll, 'wheel');
  assert.strictEqual(a.events, 'sse');
  assert.strictEqual(a.available(), true);
  assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: [] }), false);
  assert.deepStrictEqual(a.onHook({}, {}), []);
  assert.deepStrictEqual(a.onInput({}, 'x'), []);
});

test('spawnSpec: API session (D-14 permissions only with askShell), TUI args, password env', async () => {
  const { fake, a } = await setup();
  const spec = await a.spawnSpec({ cwd: 'C:\\w', title: 'T', options: { askShell: true }, rawArgs: [] });
  assert.deepStrictEqual(fake.state.sessions[0].body,
    { title: 'T', location: { directory: 'C:\\w' }, permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  assert.deepStrictEqual(spec, {
    command: process.execPath,
    args: ['fake-tui.js', '--server', fake.url, '--session', 'ses_fake1'],
    env: { OPENCODE_PASSWORD: fake.password },
    state: { opencodeSessionId: 'ses_fake1' },
  });
  await a.spawnSpec({ cwd: 'C:\\w', title: 'T2', options: { askShell: false }, rawArgs: [] });
  assert.strictEqual('permissions' in fake.state.sessions[1].body, false);
});

test('events: asked -> request, replied -> closed, execution -> status, resync opens and closes', async () => {
  const { fake, a } = await setup();
  const session = { id: 's1-aaaaaa', agentState: { opencodeSessionId: 'ses_fake1' }, runtime: {} };
  const ev = [];
  const un = a.subscribe(session, (e) => ev.push(...e));
  await waitUntil(() => fake.state.sse.size === 1);
  await sleep(100);

  fake.ask('ses_fake1', { id: 'per_1', action: 'shell', resources: ['echo hi'], save: ['echo *'] });
  await waitUntil(() => ev.some((e) => e.kind === 'request'));
  const req = ev.find((e) => e.kind === 'request');
  assert.strictEqual(req.requestId, 'per_1');
  assert.match(req.message, /shell: echo hi/);
  assert.deepStrictEqual(req.choices.map((c) => c.id), ['once', 'always', 'reject']);
  assert.ok(ev.some((e) => e.kind === 'status' && e.status === 'waiting'));

  const r = await a.reply(session, { requestId: 'per_1' }, 'once');
  assert.deepStrictEqual(r, { ok: true, events: [{ kind: 'requestClosed', requestId: 'per_1' }] });
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_fake1', requestID: 'per_1', decision: 'once' }]);
  await waitUntil(() => ev.some((e) => e.kind === 'requestClosed' && e.requestId === 'per_1'));
  const again = await a.reply(session, { requestId: 'per_1' }, 'once');
  assert.deepStrictEqual(again, { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: 'per_1' }] });

  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_fake1' } });
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_fake1' } });
  await waitUntil(() => ev.some((e) => e.kind === 'notify' && e.done));
  assert.ok(ev.some((e) => e.kind === 'status' && e.status === 'idle'));

  fake.addSilently('ses_fake1', { id: 'per_2', action: 'edit', resources: ['a.txt'], save: [] });
  fake.dropSse();
  await waitUntil(() => ev.some((e) => e.kind === 'request' && e.requestId === 'per_2'), 5000);
  assert.deepStrictEqual(ev.find((e) => e.kind === 'request' && e.requestId === 'per_2').choices.map((c) => c.id),
    ['once', 'reject'], 'empty save[] -> no "always"');

  fake.state.perms.set('ses_fake1', []);
  fake.dropSse();
  await waitUntil(() => ev.some((e) => e.kind === 'requestClosed' && e.requestId === 'per_2'), 5000);

  un();
});

test('reply: bad decision / missing session -> ok:false; transport error -> failed, request stays open', async () => {
  const stub = stubClient();
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub });
  const session = { id: 's1', agentState: { opencodeSessionId: 'ses_x' } };
  assert.deepStrictEqual(await a.reply(session, { requestId: 'per_1' }, 'maybe'), { ok: false, events: [] });
  assert.deepStrictEqual(await a.reply({ id: 's2' }, { requestId: 'per_1' }, 'once'), { ok: false, events: [] });
  assert.deepStrictEqual(await a.reply(session, {}, 'once'), { ok: false, events: [] });
  stub.replyResult = new Error('ECONNREFUSED');
  assert.deepStrictEqual(await a.reply(session, { requestId: 'per_1' }, 'reject'), { ok: false, error: 'failed', events: [] });
  assert.deepStrictEqual(stub.replies, [['ses_x', 'per_1', 'reject']]);
});

test('resync does not reopen replied requests nor close requests asked after the list was requested', () => {
  const stub = stubClient();
  let clock = 0;
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub, now: () => clock });
  const ev = [];
  a.subscribe({ id: 's1', agentState: { opencodeSessionId: 'ses_x' } }, (e) => ev.push(...e));
  const h = stub.handler;
  clock = 10;
  h({ type: 'permission.asked', data: { id: 'per_old', sessionID: 'ses_x', action: 'shell', resources: ['a'] } });
  clock = 20;
  h({ type: 'permission.replied', data: { id: 'evt', sessionID: 'ses_x', requestID: 'per_old', reply: 'once' } });
  clock = 30;
  h({ type: 'permission.asked', data: { id: 'per_new', sessionID: 'ses_x', action: 'shell', resources: ['b'] } });
  ev.length = 0;
  // список запрошен в момент 5 (до всех событий) и пришёл позже: в нём ещё per_old и нет per_new
  h({ type: 'bridge.resync', data: { sessionID: 'ses_x', startedAt: 5, permissions: [{ id: 'per_old', action: 'shell' }] } });
  assert.deepStrictEqual(ev, [], 'stale list neither reopens per_old nor closes per_new');
  // свежий список (запрошен после per_new) без per_new — закрывает
  h({ type: 'bridge.resync', data: { sessionID: 'ses_x', startedAt: 40, permissions: [] } });
  assert.deepStrictEqual(ev.filter((e) => e.kind === 'requestClosed').map((e) => e.requestId), ['per_new']);
});

test('request text: invisible/bidi characters removed, whitespace collapsed, long values keep the tail', () => {
  const stub = stubClient();
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub });
  const ev = [];
  a.subscribe({ id: 's1', agentState: { opencodeSessionId: 'ses_x' } }, (e) => ev.push(...e));
  const long = 'echo ok' + ' '.repeat(5) + '\n\n'.repeat(50) + 'x'.repeat(600) + ' && rm -rf C:\\danger';
  stub.handler({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_x', action: 'shell',
    resources: ['ls\u202e\u200bfdp.exe', long] } });
  const msg = ev.find((e) => e.kind === 'request').message;
  assert.ok(!/[\u202e\u200b\n]/.test(msg), msg);
  assert.match(msg, /lsfdp\.exe/);
  assert.match(msg, /rm -rf C:\\danger/, 'tail of a long command is visible');
  assert.ok(!/ {2}/.test(msg), 'whitespace collapsed');
  assert.ok(msg.length <= 500, String(msg.length));
});

test('request text: optional permission message is shown, sanitized and clipped', () => {
  const stub = stubClient();
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub });
  const ev = [];
  a.subscribe({ id: 's1', agentState: { opencodeSessionId: 'ses_x' } }, (e) => ev.push(...e));
  stub.handler({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_x', action: 'shell',
    resources: ['echo hi'], message: 'Run\u202E the\n\ntests\u200B' } });
  stub.handler({ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_x', action: 'edit',
    resources: ['a.txt'], message: 42 } });
  stub.handler({ type: 'permission.asked', data: { id: 'per_3', sessionID: 'ses_x', action: 'shell',
    resources: ['x'.repeat(600)], message: 'm'.repeat(150) + 'END' + '\n'.repeat(5) } });
  const msgs = ev.filter((e) => e.kind === 'request').map((e) => e.message);
  assert.strictEqual(msgs[0], 'opencode просит разрешение — shell: echo hi — Run the tests');
  assert.strictEqual(msgs[1], 'opencode просит разрешение — edit: a.txt', 'non-string message ignored');
  assert.match(msgs[2], /END( \(\d+ симв\.\))?$/, 'tail of a long message is visible');
  assert.ok(msgs[2].length <= 500, String(msgs[2].length));
});

test('service start failure (missing exe) does not crash the bridge', async () => {
  const a = oc.create('opencode', { command: path.join(tmp(), 'no-opencode.exe'), serviceFile: path.join(tmp(), 'none.json') });
  assert.strictEqual(a.available(), false);
  const origError = console.error;
  console.error = () => {};
  try {
    a.client.start();
    await sleep(300);
  } finally {
    console.error = origError;
  }
  await assert.rejects(a.client.ensure({ attempts: 1, delayMs: 10 }), /не отвечает/);
});

test('M-3: service start goes through resolveSpawn (.cmd shim and bare name), cwd = home directory', async () => {
  const dir = tmp();
  const shim = path.join(dir, 'oc-fake.cmd');
  const marker = path.join(dir, 'marker.txt');
  fs.writeFileSync(shim, '@echo off\r\necho %*> "%~dp0marker.txt"\r\ncd>> "%~dp0marker.txt"\r\n');
  const run = async (command) => {
    try { fs.unlinkSync(marker); } catch { /* нет */ }
    const a = oc.create('opencode', { command, prefixArgs: ['--pre'], serviceFile: path.join(dir, 'none.json') });
    a.client.start();
    const end = Date.now() + 10000;
    while (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).length < 2) {
      if (Date.now() > end) throw new Error('shim did not run: ' + command);
      await sleep(50);
    }
    return fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean);
  };
  let lines = await run(shim);
  assert.deepStrictEqual(lines, ['"--pre" "service" "start"', os.homedir()]);
  const oldPath = process.env.PATH;
  process.env.PATH = dir + ';' + oldPath;
  try {
    lines = await run('oc-fake');
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepStrictEqual(lines, ['"--pre" "service" "start"', os.homedir()]);
});

test('M-5: resync sets the status when no known requests remain', () => {
  const stub = stubClient();
  let clock = 0;
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub, now: () => clock });
  const ev = [];
  a.subscribe({ id: 's1', agentState: { opencodeSessionId: 'ses_x' } }, (e) => ev.push(...e));
  const h = stub.handler;
  const statuses = () => ev.filter((e) => e.kind === 'status').map((e) => e.status);
  const resync = (startedAt, permissions, running) =>
    h({ type: 'bridge.resync', data: { sessionID: 'ses_x', startedAt, permissions, running } });

  // после рестарта моста: запросов нет, сессия не выполняется -> idle; выполняется -> working
  clock = 1;
  resync(1, [], false);
  assert.deepStrictEqual(statuses(), ['idle']);
  ev.length = 0;
  resync(2, [], true);
  assert.deepStrictEqual(statuses(), ['working']);

  // ресинхронизация закрыла последний запрос: статус по running, без него — как permission.replied
  ev.length = 0;
  clock = 10;
  h({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_x', action: 'shell', resources: ['a'] } });
  ev.length = 0;
  resync(20, [], undefined);
  assert.deepStrictEqual(ev, [{ kind: 'requestClosed', requestId: 'per_1' }, { kind: 'status', status: 'working' }]);

  // открытый запрос остаётся -> статус не трогаем (waiting)
  clock = 30;
  h({ type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_x', action: 'shell', resources: ['b'] } });
  ev.length = 0;
  resync(40, [{ id: 'per_2', action: 'shell' }], false);
  assert.deepStrictEqual(ev, []);
  h({ type: 'permission.replied', data: { sessionID: 'ses_x', requestID: 'per_2' } });

  // событие выполнения пришло позже запроса списков: устаревший running его не откатывает
  clock = 50;
  h({ type: 'session.execution.started', data: { sessionID: 'ses_x' } });
  ev.length = 0;
  resync(45, [], false);
  assert.deepStrictEqual(statuses(), [], 'stale running=false does not override a newer execution event');
  // ничего не известно (running недоступен, ничего не закрыто) — статус не трогаем
  resync(60, [], undefined);
  assert.deepStrictEqual(statuses(), []);
});

test('M-3: spawnSpec failures carry a user-visible message without paths or passwords', async () => {
  const userErr = async (a) => {
    try { await a.spawnSpec({ cwd: 'C:\w', title: 'T', options: {}, rawArgs: [] }); } catch (e) { return e; }
    throw new Error('spawnSpec did not fail');
  };
  const noLeak = (e, ...secrets) => {
    assert.ok(typeof e.userMessage === 'string' && e.userMessage, 'userMessage present');
    for (const x of secrets) assert.ok(!e.userMessage.includes(x), `"${x}" leaked: ${e.userMessage}`);
  };
  // сервис не отвечает (нет service.json)
  const dir = tmp();
  const missing = path.join(dir, 'nope', 'service.json');
  const c1 = new OpencodeClient({ file: missing, ensureDeadlineMs: 150 });
  const e1 = await userErr(oc.create('opencode', { command: process.execPath }, { opencodeClient: c1 }));
  assert.match(e1.userMessage, /не отвечает/);
  noLeak(e1, dir);
  // service.json не на loopback
  const f2 = path.join(tmp(), 'service.json');
  fs.writeFileSync(f2, JSON.stringify({ url: 'http://10.1.2.3:4096', password: 'secret-pw-123' }));
  const e2 = await userErr(oc.create('opencode', { command: process.execPath }, { opencodeClient: new OpencodeClient({ file: f2 }) }));
  assert.match(e2.userMessage, /loopback/);
  noLeak(e2, 'secret-pw-123', f2, '10.1.2.3');
  // HTTP-статус при создании сессии
  const { fake, a } = await setup();
  fake.state.createStatus = 500;
  const e3 = await userErr(a);
  assert.match(e3.userMessage, /HTTP 500/);
  noLeak(e3, fake.password, fake.url);
  // прочие (сетевые) ошибки — общий текст без адреса
  const stub = { ensure: async () => ({ url: 'http://127.0.0.1:1', password: 'pw-x' }),
    createSession: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); } };
  const e4 = await userErr(oc.create('opencode', { command: process.execPath }, { opencodeClient: stub }));
  assert.match(e4.userMessage, /opencode/);
  noLeak(e4, '127.0.0.1', 'pw-x');
});

// D-23.3 (B-3): разрешения субагентов (дочерние сессии opencode)
test('D-23.3: child request -> request with the child session id; reply goes to the child path', async () => {
  const { fake, a } = await setup();
  const session = { id: 's1-aaaaaa', agentState: { opencodeSessionId: 'ses_fake1' }, runtime: {} };
  const ev = [];
  const un = a.subscribe(session, (e) => ev.push(...e));
  await waitUntil(() => fake.state.sse.size === 1);
  await sleep(100);
  fake.addChild('ses_sub', 'ses_fake1');
  fake.ask('ses_sub', { id: 'per_s', action: 'shell', resources: ['mkdir oc-sub'], save: ['mkdir *'] });
  await waitUntil(() => ev.some((e) => e.kind === 'request'));
  const req = ev.find((e) => e.kind === 'request');
  assert.strictEqual(req.requestId, 'per_s');
  assert.strictEqual(req.agentSessionId, 'ses_sub');
  assert.match(req.message, /субагент.*shell: mkdir oc-sub/);
  assert.ok(ev.some((e) => e.kind === 'status' && e.status === 'waiting'));
  const r = await a.reply(session, { requestId: 'per_s', agentSessionId: 'ses_sub' }, 'once');
  assert.deepStrictEqual(r, { ok: true, events: [{ kind: 'requestClosed', requestId: 'per_s' }] });
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_sub', requestID: 'per_s', decision: 'once' }]);
  un();
});

test('D-23.3: child execution events do not change the root status; resync keeps child session ids', () => {
  const stub = stubClient();
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub, now: () => 1 });
  const ev = [];
  a.subscribe({ id: 's1', agentState: { opencodeSessionId: 'ses_x' } }, (e) => ev.push(...e));
  const h = stub.handler;
  for (const type of ['session.execution.started', 'session.execution.succeeded', 'session.execution.failed',
    'session.execution.interrupted']) h({ type, data: { sessionID: 'ses_child' } });
  assert.deepStrictEqual(ev, []);
  h({ type: 'bridge.resync', data: { sessionID: 'ses_x', startedAt: 5,
    permissions: [{ id: 'per_c', sessionID: 'ses_child', action: 'shell' }, { id: 'per_r', action: 'shell' }] } });
  const reqs = ev.filter((e) => e.kind === 'request');
  assert.deepStrictEqual(reqs.map((e) => [e.requestId, e.agentSessionId]), [['per_c', 'ses_child'], ['per_r', 'ses_x']]);
  assert.match(reqs[0].message, /субагент/);
  assert.doesNotMatch(reqs[1].message, /субагент/);
});

test('D-23.3: reply uses the stored child session id; a malformed one is refused', async () => {
  const stub = stubClient();
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub });
  const session = { id: 's1', agentState: { opencodeSessionId: 'ses_x' } };
  assert.strictEqual((await a.reply(session, { requestId: 'per_1', agentSessionId: 'ses_child' }, 'once')).ok, true);
  assert.strictEqual((await a.reply(session, { requestId: 'per_2' }, 'once')).ok, true);
  assert.deepStrictEqual(await a.reply(session, { requestId: 'per_3', agentSessionId: '../x' }, 'once'), { ok: false, events: [] });
  assert.deepStrictEqual(stub.replies, [['ses_child', 'per_1', 'once'], ['ses_x', 'per_2', 'once']]);
});

test('D-23.6: "always" label from save[] (sanitized, length-limited)', () => {
  const stub = stubClient();
  const a = oc.create('opencode', { command: process.execPath }, { opencodeClient: stub, now: () => 1 });
  const ev = [];
  a.subscribe({ id: 's1', agentState: { opencodeSessionId: 'ses_x' } }, (e) => ev.push(...e));
  const always = (save, id) => {
    stub.handler({ type: 'permission.asked', data: { id, sessionID: 'ses_x', action: 'shell', resources: ['x'], save } });
    const req = ev.find((e) => e.kind === 'request' && e.requestId === id);
    const c = req.choices.find((x) => x.id === 'always');
    return c && c.label;
  };
  // факт задачи 17 (v2.1.4): resources ["mkdir oc-e2e-1"], save ["mkdir *"]
  assert.strictEqual(always(['mkdir *'], 'per_1'), 'Всегда: mkdir *');
  assert.strictEqual(always(['git add *', 'git commit *'], 'per_2'), 'Всегда: git add *, git commit *');
  assert.strictEqual(always([5, ''], 'per_3'), undefined, 'nothing to save -> no "always"');
  const long = always(['echo ' + 'a'.repeat(80) + '‮\n*'], 'per_4');
  assert.ok(long.length <= 40 && long.startsWith('Всегда: echo a') && long.endsWith('a *') && !/[‮\n]/.test(long), long);
});
