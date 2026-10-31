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
  const info = await c.ensure({ attempts: 20, delayMs: 50 });
  assert.strictEqual(info.url, fake.url);
  assert.strictEqual(started, 1);
  const never = new OpencodeClient({ file: path.join(tmp(), 'none.json'), start: () => {} });
  await assert.rejects(never.ensure({ attempts: 2, delayMs: 10 }), /не отвечает/);
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
