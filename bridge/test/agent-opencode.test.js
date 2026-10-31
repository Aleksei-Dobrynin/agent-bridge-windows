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
