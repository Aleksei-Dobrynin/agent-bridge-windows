'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpencodeClient, sseParser } = require('../agents/opencode-client');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error('условие не выполнено');
}
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sse-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
// упавший тест не должен оставлять открытые сокеты (иначе процесс теста не завершится)
const fakes = [];
const clients = [];
async function mkFake(opts) { const f = await startFakeOpencode(opts); fakes.push(f); return f; }
function mkClient(opts) { const c = new OpencodeClient(opts); clients.push(c); return c; }
test.afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const f of fakes.splice(0)) await f.close();
});

test('sseParser: split chunks, CRLF, comments, heartbeat, bad json', () => {
  const got = [];
  const feed = sseParser((e) => got.push(e.type));
  for (const ch of ['da', 'ta: {"type":"a","data":{}}\n', '\n', ': heartbeat\n\n', 'data: {"type":"b"}\r\n\r\n',
    'data: not json\n\n', ': ping\n\n', 'data: {"ty', 'pe":"c"}\n', '\n']) feed(ch);
  assert.deepStrictEqual(got, ['a', 'b', 'c']);
});

test('sseParser: UTF-8 bytes split inside a multibyte character', () => {
  const got = [];
  const feed = sseParser((e) => got.push(e.data.text));
  const bytes = Buffer.from('data: {"type":"x","data":{"text":"Привет, мир — ✓"}}\n\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('р', 'utf8')) + 1; // посреди двухбайтового символа
  feed(bytes.subarray(0, cut));
  feed(bytes.subarray(cut, cut + 1));
  feed(bytes.subarray(cut + 1));
  assert.deepStrictEqual(got, ['Привет, мир — ✓']);
});

test('sseParser: an oversized event is dropped, the stream resynchronizes on the next event', () => {
  const got = [];
  const feed = sseParser((e) => got.push(e.type), { maxEventBytes: 64 });
  feed('data: {"type":"big","pad":"' + 'x'.repeat(50));
  feed('x'.repeat(50) + '"}\n');
  feed('data: {"type":"still-big"}\n\n');
  feed('data: {"type":"ok"}\n\n');
  assert.deepStrictEqual(got, ['ok']);
});

test('only own session events; resync on connect and after reconnect; unsubscribe closes', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 50 });
  fake.addSilently('ses_a', { id: 'per_0' });
  const got = [];
  const un = c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'));
  assert.deepStrictEqual(got[0].data.permissions.map((p) => p.id), ['per_0']);

  fake.emit({ type: 'permission.asked', data: { id: 'per_x', sessionID: 'ses_b' } });
  fake.ask('ses_a', { id: 'per_1' });
  await waitUntil(() => got.some((e) => e.type === 'permission.asked'));
  assert.ok(!got.some((e) => e.data && e.data.id === 'per_x'), 'foreign session filtered');
  assert.ok(!got.some((e) => e.type === 'server.connected'), 'events without sessionID are not delivered');

  fake.addSilently('ses_a', { id: 'per_2' });
  got.length = 0;
  fake.dropSse();
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'), 5000);
  assert.deepStrictEqual(got.find((e) => e.type === 'bridge.resync').data.permissions.map((p) => p.id).sort(),
    ['per_0', 'per_1', 'per_2']);

  un();
  await waitUntil(() => fake.state.sse.size === 0);
  c.close();
  await fake.close();
});

test('second subscriber on an open stream gets its own resync', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()) });
  const a = [];
  const b = [];
  c.subscribe('ses_a', (e) => a.push(e));
  await waitUntil(() => a.some((e) => e.type === 'bridge.resync'));
  fake.addSilently('ses_b', { id: 'per_b' });
  c.subscribe('ses_b', (e) => b.push(e));
  await waitUntil(() => b.some((e) => e.type === 'bridge.resync'));
  assert.deepStrictEqual(b[0].data.permissions.map((p) => p.id), ['per_b']);
  assert.strictEqual(fake.state.sse.size, 1, 'one shared SSE connection');
  c.close();
  await fake.close();
});

test('stream: data line and UTF-8 character split across TCP chunks', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()) });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'));
  const bytes = Buffer.from(JSON.stringify({ type: 'permission.asked',
    data: { id: 'per_u', sessionID: 'ses_a', action: 'shell', resources: ['echo Привет ✓'] } }), 'utf8');
  const line = Buffer.concat([Buffer.from('data: '), bytes, Buffer.from('\n\n')]);
  const cut = line.indexOf(Buffer.from('✓', 'utf8')) + 1; // внутри трёхбайтового символа
  fake.writeRaw(line.subarray(0, 4)); // внутри «data:»
  await sleep(40);
  fake.writeRaw(line.subarray(4, cut));
  await sleep(40);
  fake.writeRaw(line.subarray(cut));
  await waitUntil(() => got.some((e) => e.type === 'permission.asked'));
  assert.deepStrictEqual(got.find((e) => e.type === 'permission.asked').data.resources, ['echo Привет ✓']);
  c.close();
  await fake.close();
});

test('a throwing or rejecting handler does not break the stream', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()) });
  const got = [];
  const origError = console.error;
  console.error = () => {};
  try {
    c.subscribe('ses_a', (e) => {
      got.push(e.type + ':' + (e.data.id || ''));
      if (e.data.id === 'per_throw') throw new Error('boom');
      if (e.data.id === 'per_reject') return Promise.reject(new Error('async boom'));
      return undefined;
    });
    await waitUntil(() => got.length === 1);
    fake.ask('ses_a', { id: 'per_throw' });
    fake.ask('ses_a', { id: 'per_reject' });
    fake.ask('ses_a', { id: 'per_ok' });
    await waitUntil(() => got.includes('permission.asked:per_ok'));
    await sleep(50);
    assert.strictEqual(fake.state.sseConnects, 1, 'no reconnect caused by handler errors');
  } finally {
    console.error = origError;
  }
  c.close();
  await fake.close();
});

test('reconnect backoff grows while the service refuses, resets after success', async () => {
  const fake = await mkFake();
  fake.state.sseStatus = 503;
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 40, maxBackoffMs: 200 });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => fake.state.sseConnects >= 6, 5000);
  const t = fake.state.sseConnectTimes;
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.ok(gaps[0] >= 30, `first gap ${gaps[0]}`);
  assert.ok(gaps[2] >= gaps[0] * 2.5, `gaps grow: ${gaps}`);
  assert.ok(gaps[4] < 400, `gaps capped: ${gaps}`);
  assert.strictEqual(got.length, 0, 'no resync without an open stream');
  fake.state.sseStatus = 200;
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'), 3000);
  assert.strictEqual(c.backoff, 40);
  c.close();
  await fake.close();
});

test('idle watchdog: a silent stream is reopened, heartbeats keep it alive', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 30, idleMs: 250 });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => fake.state.sseConnects >= 2, 3000);
  const hb = setInterval(() => fake.writeRaw(': heartbeat\n\n'), 60);
  try {
    await waitUntil(() => got.filter((e) => e.type === 'bridge.resync').length >= 2, 3000);
    const before = fake.state.sseConnects;
    await sleep(700);
    assert.strictEqual(fake.state.sseConnects, before, 'heartbeats prevent reconnects');
  } finally {
    clearInterval(hb);
  }
  c.close();
  await fake.close();
});

test('service file changes between reconnects are picked up (service restarted)', async () => {
  const fake1 = await mkFake({ password: 'one' });
  const fake2 = await mkFake({ password: 'two' });
  const dir = tmp();
  const c = mkClient({ file: fake1.writeServiceFile(dir), backoffMs: 30 });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => got.length === 1);
  fake2.writeServiceFile(dir);
  fake2.addSilently('ses_a', { id: 'per_new' });
  await fake1.close();
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync' && e.data.permissions.length === 1), 3000);
  assert.strictEqual(fake2.state.sse.size, 1);
  c.close();
  await fake2.close();
});

test('M-7: 200 without a single byte does not reset the reconnect backoff', async () => {
  const fake = await mkFake();
  fake.state.sseEmpty = true;
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 40, maxBackoffMs: 400 });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => fake.state.sseConnects >= 5, 5000);
  const t = fake.state.sseConnectTimes;
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.ok(gaps[0] >= 30, `first gap ${gaps[0]}`);
  assert.ok(gaps[3] >= gaps[0] * 4, `gaps grow although every response was 200: ${gaps}`);
  fake.state.sseEmpty = false;
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'), 3000);
  await waitUntil(() => c.backoff === 40, 3000);
  c.close();
  await fake.close();
});

test('M-5: resync carries running from /api/session/active and startedAt', async () => {
  const fake = await mkFake();
  fake.state.active.add('ses_a');
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 30 });
  const a = [];
  const b = [];
  c.subscribe('ses_a', (e) => a.push(e));
  c.subscribe('ses_b', (e) => b.push(e));
  await waitUntil(() => a.some((e) => e.type === 'bridge.resync') && b.some((e) => e.type === 'bridge.resync'));
  assert.strictEqual(a.find((e) => e.type === 'bridge.resync').data.running, true);
  assert.strictEqual(b.find((e) => e.type === 'bridge.resync').data.running, false);
  assert.strictEqual(typeof a.find((e) => e.type === 'bridge.resync').data.startedAt, 'number');
  c.close();
  await fake.close();
});

// D-23.3 (B-3): субагенты opencode (`task`) работают в дочерних сессиях (session.created с parentID)
// и спрашивают разрешения со своим sessionID
test('D-23.3: child sessions (nested too): permission.* go to the root subscriber, other child events do not', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 50 });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'));
  fake.addChild('ses_c1', 'ses_a');
  fake.addChild('ses_c2', 'ses_c1'); // субагент субагента
  fake.addChild('ses_x1', 'ses_other'); // чужая
  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_c1' } });
  fake.ask('ses_x1', { id: 'per_x' });
  fake.ask('ses_c2', { id: 'per_c2' });
  fake.emit({ type: 'permission.replied', data: { sessionID: 'ses_c1', requestID: 'per_c1', reply: 'once' } });
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_c2' } });
  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_a' } });
  await waitUntil(() => got.some((e) => e.type === 'session.execution.started'));
  const seen = got.filter((e) => e.type !== 'bridge.resync').map((e) => [e.type, e.data.sessionID]);
  assert.deepStrictEqual(seen, [
    ['permission.asked', 'ses_c2'],
    ['permission.replied', 'ses_c1'],
    ['session.execution.started', 'ses_a'],
  ]);
});

test('D-23.3: resync covers children — listed by parentID (nested) and known from session.created', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 50 });
  // дочерние сессии существовали до подписки (рестарт моста): находятся списком GET /api/session?parentID=
  fake.addChild('ses_c1', 'ses_a', { announce: false });
  fake.addChild('ses_c2', 'ses_c1', { announce: false });
  fake.addSilently('ses_a', { id: 'per_a' });
  fake.addSilently('ses_c2', { id: 'per_c2' });
  const got = [];
  c.subscribe('ses_a', (e) => got.push(e));
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'));
  const r1 = got.find((e) => e.type === 'bridge.resync').data;
  assert.deepStrictEqual(r1.permissions.map((p) => [p.id, p.sessionID]).sort(), [['per_a', 'ses_a'], ['per_c2', 'ses_c2']]);
  assert.ok(fake.state.listQueries.some((q) => /parentID=ses_a/.test(q)), 'children listed by parentID');
  // найденные списком дочерние сессии — известны: их события идут подписчику
  fake.ask('ses_c1', { id: 'per_c1' });
  await waitUntil(() => got.some((e) => e.type === 'permission.asked' && e.data.id === 'per_c1'));

  // сервис без списка по parentID: ресинхронизация — только известных дочерних сессий
  fake.state.listStatus = 400;
  fake.addChild('ses_c3', 'ses_a'); // известна по session.created
  fake.addChild('ses_c4', 'ses_a', { announce: false }); // не известна
  fake.addSilently('ses_c3', { id: 'per_c3' });
  fake.addSilently('ses_c4', { id: 'per_c4' });
  await sleep(100);
  got.length = 0;
  fake.dropSse();
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'), 5000);
  const ids = got.find((e) => e.type === 'bridge.resync').data.permissions.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['per_a', 'per_c1', 'per_c2', 'per_c3']);

  // удалённая дочерняя сессия (404) не срывает ресинхронизацию
  fake.state.deleted.add('ses_c3');
  got.length = 0;
  fake.dropSse();
  await waitUntil(() => got.some((e) => e.type === 'bridge.resync'), 5000);
  assert.deepStrictEqual(got.find((e) => e.type === 'bridge.resync').data.permissions.map((p) => p.id).sort(),
    ['per_a', 'per_c1', 'per_c2']);
});

test('D-23.3: unsubscribing a root forgets its children', async () => {
  const fake = await mkFake();
  const c = mkClient({ file: fake.writeServiceFile(tmp()), backoffMs: 50 });
  const a = [];
  const unA = c.subscribe('ses_a', (e) => a.push(e));
  c.subscribe('ses_b', () => {});
  await waitUntil(() => a.some((e) => e.type === 'bridge.resync'));
  fake.addChild('ses_c1', 'ses_a');
  fake.addChild('ses_c2', 'ses_b');
  await waitUntil(() => c.children.size === 2);
  unA();
  assert.deepStrictEqual([...c.children.keys()], ['ses_c2']);
});
