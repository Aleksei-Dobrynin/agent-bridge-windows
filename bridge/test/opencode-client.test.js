'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OpencodeClient, serviceFilePath, readServiceFile } = require('../agents/opencode-client');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-oc-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('service.json location: XDG_STATE_HOME, else USERPROFILE\\.local\\state', () => {
  assert.strictEqual(serviceFilePath({ XDG_STATE_HOME: 'D:\\st', USERPROFILE: 'C:\\U' }), path.join('D:\\st', 'opencode', 'service.json'));
  assert.strictEqual(serviceFilePath({ USERPROFILE: 'C:\\U' }), path.join('C:\\U', '.local', 'state', 'opencode', 'service.json'));
});

test('readServiceFile: only loopback urls with a password', () => {
  const dir = tmp();
  const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:4096/', password: 'p', pid: 1, version: 'v' }));
  assert.deepStrictEqual(readServiceFile(f), { url: 'http://127.0.0.1:4096', password: 'p', pid: 1, version: 'v' });
  fs.writeFileSync(f, JSON.stringify({ url: 'http://10.0.0.5:4096', password: 'p' }));
  assert.strictEqual(readServiceFile(f), null);
  fs.writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:4096' }));
  assert.strictEqual(readServiceFile(f), null);
  fs.writeFileSync(f, 'garbage');
  assert.strictEqual(readServiceFile(f), null);
  assert.strictEqual(readServiceFile(path.join(dir, 'missing.json')), null);
});

test('alive: Basic auth checked via /api/info', async () => {
  const fake = await startFakeOpencode();
  const dir = tmp();
  const ok = new OpencodeClient({ file: fake.writeServiceFile(dir) });
  assert.strictEqual(await ok.alive(), true);
  const bad = new OpencodeClient({ file: fake.writeServiceFile(tmp(), { password: 'wrong' }) });
  assert.strictEqual(await bad.alive(), false);
  assert.strictEqual(await new OpencodeClient({ file: path.join(dir, 'none.json') }).alive(), false);
  await fake.close();
});

test('ensure: starts the service when service.json is missing and waits for it', async () => {
  const fake = await startFakeOpencode();
  const dir = tmp();
  let started = 0;
  const c = new OpencodeClient({
    file: path.join(dir, 'opencode', 'service.json'),
    start: () => { started++; setTimeout(() => fake.writeServiceFile(dir), 120); },
  });
  const info = await c.ensure({ deadlineMs: 3000, delayMs: 50 });
  assert.strictEqual(info.url, fake.url);
  assert.strictEqual(started, 1);
  const never = new OpencodeClient({ file: path.join(tmp(), 'none.json'), start: () => {} });
  await assert.rejects(never.ensure({ deadlineMs: 50, delayMs: 10 }), /не отвечает/);
  await fake.close();
});

test('createSession, listPermissions, replyPermission (204 / 404 / 400)', async () => {
  const fake = await startFakeOpencode();
  const c = new OpencodeClient({ file: fake.writeServiceFile(tmp()) });
  const id = await c.createSession({ title: 'T', directory: 'C:\\w', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  assert.strictEqual(id, 'ses_fake1');
  assert.deepStrictEqual(fake.state.sessions[0].body,
    { title: 'T', location: { directory: 'C:\\w' }, permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
  await c.createSession({ title: 'U', directory: 'C:\\w' });
  assert.strictEqual('permissions' in fake.state.sessions[1].body, false);
  fake.addSilently('ses_fake1', { id: 'per_1' });
  assert.deepStrictEqual((await c.listPermissions('ses_fake1')).map((p) => p.id), ['per_1']);
  await assert.rejects(c.replyPermission('ses_fake1', 'per_1', 'maybe'), /HTTP 400/);
  assert.strictEqual(await c.replyPermission('ses_fake1', 'per_1', 'once'), 'ok');
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_fake1', requestID: 'per_1', decision: 'once' }]);
  assert.strictEqual(await c.replyPermission('ses_fake1', 'per_1', 'once'), 'stale');
  await fake.close();
});

test('requests without a service file reject; dead service rejects', async () => {
  const c = new OpencodeClient({ file: path.join(tmp(), 'none.json') });
  await assert.rejects(c.createSession({ title: 'T', directory: 'C:\\w' }), /service\.json/);
  const fake = await startFakeOpencode();
  const file = fake.writeServiceFile(tmp());
  await fake.close();
  await assert.rejects(new OpencodeClient({ file, timeoutMs: 1000 }).listPermissions('ses_x'));
});

// ---- ревью M-1…M-6

/** Мини-сервер: ответы по `METHOD path` -> [status, body]; Basic не проверяется. */
function miniServer(routes) {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const r = routes[`${req.method} ${req.url}`];
    if (!r) { res.writeHead(404); res.end(); return; }
    res.writeHead(r[0], { 'Content-Type': 'application/json' });
    res.end(r[1] === undefined ? '' : JSON.stringify(r[1]));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    file() {
      const f = path.join(tmp(), 'service.json');
      fs.writeFileSync(f, JSON.stringify({ url: this.url, password: 'p' }));
      return f;
    },
    close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); }),
  })));
}

test('M-1: service.json pointing outside loopback -> ensure refuses, service is not started', async () => {
  const f = path.join(tmp(), 'service.json');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://10.0.0.5:4096', password: 'p' }));
  let started = 0;
  const c = new OpencodeClient({ file: f, start: () => { started++; } });
  await assert.rejects(c.ensure({ deadlineMs: 300, delayMs: 20 }), /не на loopback — мост не отправит пароль/);
  assert.strictEqual(started, 0);
  // сервис после старта записал не-loopback адрес — тоже отказ, не ожидание до дедлайна
  const g = path.join(tmp(), 'opencode', 'service.json');
  const late = new OpencodeClient({ file: g, start: () => {
    fs.mkdirSync(path.dirname(g), { recursive: true });
    fs.writeFileSync(g, JSON.stringify({ url: 'https://example.com', password: 'p' }));
  } });
  const t0 = Date.now();
  await assert.rejects(late.ensure({ deadlineMs: 5000, delayMs: 20 }), /не на loopback/);
  assert.ok(Date.now() - t0 < 2000, 'refused without waiting for the deadline');
});

test('M-2: service url is normalized to its origin (no path, query, hash, userinfo)', () => {
  const f = path.join(tmp(), 's.json');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://user:secret@127.0.0.1:4096/base/x?q=1#h', password: 'p' }));
  assert.strictEqual(readServiceFile(f).url, 'http://127.0.0.1:4096');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://localhost:4096', password: 'p' }));
  assert.strictEqual(readServiceFile(f).url, 'http://localhost:4096');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://[::1]:4096/', password: 'p' }));
  assert.strictEqual(readServiceFile(f).url, 'http://[::1]:4096');
});

test('M-4: concurrent ensure() calls share one attempt; overall deadline', async () => {
  const fake = await startFakeOpencode();
  const dir = tmp();
  let started = 0;
  const c = new OpencodeClient({
    file: path.join(dir, 'opencode', 'service.json'),
    start: () => { started++; setTimeout(() => fake.writeServiceFile(dir), 150); },
  });
  const [a, b] = await Promise.all([c.ensure({ deadlineMs: 5000, delayMs: 30 }), c.ensure({ deadlineMs: 5000, delayMs: 30 })]);
  assert.strictEqual(started, 1, 'service started once');
  assert.strictEqual(a.url, fake.url);
  assert.strictEqual(b.url, fake.url);
  await fake.close();

  const never = new OpencodeClient({ file: path.join(tmp(), 'none.json'), start: () => {} });
  const t0 = Date.now();
  await assert.rejects(never.ensure({ deadlineMs: 400, delayMs: 50 }), /не отвечает/);
  assert.ok(Date.now() - t0 < 1500, 'deadline respected: ' + (Date.now() - t0));
  // после неудачи — новая попытка, а не закешированный отказ
  let again = 0;
  const retry = new OpencodeClient({ file: path.join(tmp(), 'none.json'), start: () => { again++; } });
  await assert.rejects(retry.ensure({ deadlineMs: 100, delayMs: 20 }));
  await assert.rejects(retry.ensure({ deadlineMs: 100, delayMs: 20 }));
  assert.strictEqual(again, 2);
  assert.strictEqual(new OpencodeClient({ file: path.join(tmp(), 'none.json') }).ensureDeadlineMs, 25000);
});

test('M-6: listPermissions rejects an unexpected body; reply 404 is stale only for PermissionNotFoundError', async () => {
  const srv = await miniServer({
    'GET /api/session/ses_a/permission': [200, { data: [{ id: 'per_1' }, null, { id: 2 }] }],
    'GET /api/session/ses_bare/permission': [200, [{ id: 'per_2' }]],
    'GET /api/session/ses_obj/permission': [200, { data: { id: 'per_1' } }],
    'GET /api/session/ses_html/permission': [200, undefined],
    'POST /api/session/ses_a/permission/per_tag/reply': [404, { _tag: 'PermissionNotFoundError', requestID: 'per_tag', message: 'x' }],
    'POST /api/session/ses_a/permission/per_name/reply': [404, { name: 'PermissionNotFoundError' }],
    'POST /api/session/ses_a/permission/per_ses/reply': [404, { _tag: 'SessionNotFoundError', sessionID: 'ses_a', message: 'x' }],
    'POST /api/session/ses_a/permission/per_none/reply': [404, undefined],
  });
  const c = new OpencodeClient({ file: srv.file() });
  assert.deepStrictEqual((await c.listPermissions('ses_a')).map((p) => p.id), ['per_1']);
  assert.deepStrictEqual((await c.listPermissions('ses_bare')).map((p) => p.id), ['per_2']);
  await assert.rejects(c.listPermissions('ses_obj'), /неожиданный ответ/);
  await assert.rejects(c.listPermissions('ses_html'), /неожиданный ответ/);
  assert.strictEqual(await c.replyPermission('ses_a', 'per_tag', 'once'), 'stale');
  assert.strictEqual(await c.replyPermission('ses_a', 'per_name', 'once'), 'stale');
  await assert.rejects(c.replyPermission('ses_a', 'per_ses', 'once'), /HTTP 404/);
  await assert.rejects(c.replyPermission('ses_a', 'per_none', 'once'), /HTTP 404/);
  await srv.close();
});

test('M-5: activeSessions -> set of running session ids; bad body rejects', async () => {
  const srv = await miniServer({ 'GET /api/session/active': [200, { data: { ses_a: { type: 'running' } } }] });
  const c = new OpencodeClient({ file: srv.file() });
  assert.deepStrictEqual([...await c.activeSessions()], ['ses_a']);
  await srv.close();
  const bad = await miniServer({ 'GET /api/session/active': [200, { data: [] }] });
  await assert.rejects(new OpencodeClient({ file: bad.file() }).activeSessions(), /неожиданный ответ/);
  await bad.close();
});
