'use strict';
// Сквозной тест opencode через мост на фейковом сервисе (D-12, D-14, D-4): сессия через API,
// TUI с --server/--session и паролем в окружении keeper'а (не в файлах), SSE -> notify,
// reply -> API, ресинхронизация после обрыва SSE и после перезапуска моста.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('./helpers/bridge');
const { startFakeOpencode } = require('./helpers/fake-opencode');

const { FAKE_AGENT, DEVICE, createAndAttach, sleep } = H;
const waitUntil = async (fn, ms = 10000) => assert.ok(await H.waitFor(fn, ms), 'условие не выполнено за ' + ms + ' мс');

let fake;
let svcDir;
let b;
let c;
let sid;
test.before(async () => {
  fake = await startFakeOpencode({ password: 'ocpw-' + crypto.randomBytes(8).toString('hex') });
  svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ocs-'));
  const file = fake.writeServiceFile(svcDir);
  b = await H.startTestBridge({ prefix: 'cb-ocit-', devices: [DEVICE], config: {
    defaultAgent: 'opencode',
    agents: { opencode: { command: process.execPath, prefixArgs: [FAKE_AGENT], serviceFile: file } },
  } });
  c = await b.connect(DEVICE.token);
});
test.after(async () => {
  if (b) await b.stop();
  if (fake) await fake.close();
  if (svcDir) fs.rmSync(svcDir, { recursive: true, force: true });
});

/** Файл целиком; занятый (EBUSY/EPERM) — несколько повторов, затем ошибка теста (I-2: непрочитанный
 *  файл — не «чистый»). Исчезнувший между readdir и чтением (ENOENT: .tmp после rename) — null. */
async function readForScan(p) {
  for (let i = 0; ; i++) {
    try { return fs.readFileSync(p); } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (i >= 9) throw new Error(`не удалось прочитать ${p} для проверки: ${e.code || e.message}`);
      await sleep(100);
    }
  }
}

/** Все файлы каталога данных моста (meta, логи keeper'ов, конфиг) — пароль сервиса не должен там оказаться. */
async function filesWith(dir, needle) {
  const hits = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) hits.push(...await filesWith(p, needle));
    else {
      const buf = await readForScan(p);
      if (buf && buf.includes(needle)) hits.push(p);
    }
  }
  return hits;
}

/** I-2: пароль сервиса — ни в файлах каталога данных, ни в выводе моста (stdout/stderr). */
async function assertPasswordNowhere() {
  assert.deepStrictEqual(await filesWith(b.home, fake.password), []);
  assert.ok(!b.logs().includes(fake.password), 'password in bridge stdout/stderr');
}

test('create: API session with ask-shell, TUI args and password env (D-12, D-14)', { timeout: 60000 }, async () => {
  const r = await createAndAttach(c, { agent: 'opencode', cwd: b.cwd, options: { askShell: true } });
  assert.strictEqual(r.type, 'created');
  sid = r.id;
  const body = fake.state.sessions[0].body;
  assert.strictEqual(body.location.directory, b.cwd);
  assert.deepStrictEqual(body.permissions, [{ action: 'shell', resource: '*', effect: 'ask' }]);
  const argv = JSON.parse((await c.waitOutput(sid, /ARGV:(\[[^\]]*\])/))[1]);
  assert.deepStrictEqual(argv, ['--server', fake.url, '--session', 'ses_fake1']);
  await c.waitOutput(sid, new RegExp('OCPW:' + fake.password));
  // пароль сервиса — только в окружении keeper'а/агента: не в meta-файле и не в логах
  const meta = JSON.parse(fs.readFileSync(path.join(b.home, 'sessions', sid + '.json'), 'utf8'));
  assert.deepStrictEqual(meta.agentState, { opencodeSessionId: 'ses_fake1' });
  assert.strictEqual(meta.env, undefined);
  await assertPasswordNowhere();
  const listed = (await c.wait((m) => m.type === 'sessions' && m.sessions.some((s) => s.id === sid))).sessions
    .find((s) => s.id === sid);
  assert.deepStrictEqual([listed.agent, listed.agentName, listed.scroll], ['opencode', 'opencode', 'wheel']);
});

test('permission.asked -> notify; foreign session ignored; reply -> API; stale', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  await sleep(200);
  const at = c.mark();
  fake.ask('ses_other', { id: 'per_x' });
  fake.ask('ses_fake1', { id: 'per_1', action: 'shell', resources: ['echo hi'], save: ['echo *'] });
  const n = await c.wait((m) => m.type === 'notify' && m.event === 'request' && m.requestId === 'per_1', 5000, at);
  assert.strictEqual(n.id, sid);
  assert.match(n.message, /shell: echo hi/);
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'always', 'reject']);
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'waiting', 5000, at);
  assert.ok(!c.msgs.slice(at).some((m) => m.requestId === 'per_x'));

  c.send({ type: 'reply', id: sid, requestId: 'per_1', decision: 'once' });
  const ok = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_1', 5000, at);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(fake.state.replies, [{ sessionID: 'ses_fake1', requestID: 'per_1', decision: 'once' }]);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === 'per_1', 5000, at);
  const at2 = c.mark();
  c.send({ type: 'reply', id: sid, requestId: 'per_1', decision: 'once' });
  const stale = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_1', 5000, at2);
  assert.deepStrictEqual([stale.ok, stale.error], [false, 'stale']);
  assert.strictEqual(fake.state.replies.length, 1, 'stale reply never reaches the service');
});

test('reply already answered in the TUI -> 404 from the service -> stale, request closed', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  const at = c.mark();
  fake.ask('ses_fake1', { id: 'per_tui', action: 'shell', resources: ['ls'] });
  await c.wait((m) => m.type === 'notify' && m.requestId === 'per_tui', 5000, at);
  // ответ в самом TUI: сервис уже убрал запрос, а permission.replied ещё не дошёл
  fake.state.perms.set('ses_fake1', (fake.state.perms.get('ses_fake1') || []).filter((p) => p.id !== 'per_tui'));
  c.send({ type: 'reply', id: sid, requestId: 'per_tui', decision: 'once' });
  const r = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_tui', 5000, at);
  assert.deepStrictEqual([r.ok, r.error], [false, 'stale']);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === 'per_tui', 5000, at);
});

test('missed request is restored after SSE drop (resync)', { timeout: 30000 }, async () => {
  const at = c.mark();
  fake.addSilently('ses_fake1', { id: 'per_2', action: 'edit', resources: ['a.txt'], save: [] });
  fake.dropSse();
  const n = await c.wait((m) => m.type === 'notify' && m.requestId === 'per_2', 15000, at);
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'reject']);
});

test('execution events -> working / idle + done', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  const at = c.mark();
  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_fake1' } });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'working', 5000, at);
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_fake1' } });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'idle', 5000, at);
  await c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'done', 5000, at);
});

test('M-4: a second reply while the first is in flight -> immediate stale, one call to the service', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  const at = c.mark();
  fake.ask('ses_fake1', { id: 'per_m4', action: 'shell', resources: ['x'] });
  await c.wait((m) => m.type === 'notify' && m.requestId === 'per_m4', 5000, at);
  fake.state.replyDelayMs = 1500;
  try {
    c.send({ type: 'reply', id: sid, requestId: 'per_m4', decision: 'once' });
    await sleep(200);
    c.send({ type: 'reply', id: sid, requestId: 'per_m4', decision: 'reject' });
    const first = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_m4', 5000, at);
    assert.deepStrictEqual([first.ok, first.error], [false, 'stale'], 'the second reply is answered first');
    const results = () => c.msgs.slice(at).filter((m) => m.type === 'replyResult' && m.requestId === 'per_m4');
    await waitUntil(() => results().length === 2, 5000);
    assert.strictEqual(results()[1].ok, true);
  } finally { fake.state.replyDelayMs = 0; }
  assert.deepStrictEqual(fake.state.replies.filter((r) => r.requestID === 'per_m4'),
    [{ sessionID: 'ses_fake1', requestID: 'per_m4', decision: 'once' }]);
});

test('D-23.3: subagent (child session) request reaches the client; reply goes to the child session', { timeout: 30000 }, async () => {
  await waitUntil(() => fake.state.sse.size >= 1);
  const at = c.mark();
  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_fake1' } });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'working', 5000, at);
  fake.addChild('ses_sub1', 'ses_fake1');
  fake.emit({ type: 'session.execution.started', data: { sessionID: 'ses_sub1' } });
  fake.ask('ses_sub1', { id: 'per_sub1', action: 'shell', resources: ['mkdir oc-sub'], save: ['mkdir *'] });
  const n = await c.wait((m) => m.type === 'notify' && m.requestId === 'per_sub1', 5000, at);
  assert.strictEqual(n.id, sid);
  assert.ok(!('agentSessionId' in n));
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'waiting', 5000, at);
  c.send({ type: 'reply', id: sid, requestId: 'per_sub1', decision: 'once' });
  const ok = await c.wait((m) => m.type === 'replyResult' && m.requestId === 'per_sub1', 5000, at);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(fake.state.replies.slice(-1), [{ sessionID: 'ses_sub1', requestID: 'per_sub1', decision: 'once' }]);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === 'per_sub1', 5000, at);
  // окончание субагента не завершает ход родителя
  const at2 = c.mark();
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_sub1' } });
  fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_fake1' } });
  await c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'done', 5000, at2);
  assert.strictEqual(c.msgs.slice(at2).filter((m) => m.type === 'notify' && m.event === 'done').length, 1);
});

test('M-3: service failure on create is shown to the client (no password / address)', { timeout: 30000 }, async () => {
  fake.state.createStatus = 500;
  try {
    const r = await createAndAttach(c, { agent: 'opencode', cwd: b.cwd });
    assert.strictEqual(r.type, 'error');
    assert.match(r.message, /Не удалось создать сессию: opencode: не удалось создать сессию \(HTTP 500\)/);
    assert.ok(!r.message.includes(fake.password) && !r.message.includes(fake.url), r.message);
  } finally { fake.state.createStatus = 200; }
});

test('bridge restart: the restored session subscribes again; pending request reaches the client (D-20)', { timeout: 90000 }, async () => {
  c.close();
  await b.restart();
  c = await b.connect(DEVICE.token);
  // per_2 ещё ждёт ответа в сервисе: восстановленная сессия узнаёт о нём из ресинхронизации SSE,
  // клиент получает notify с кнопками — рассылкой или повтором при подключении (D-20)
  const replayed = await c.wait((m) => m.type === 'notify' && m.event === 'request' && m.requestId === 'per_2', 30000);
  assert.strictEqual(replayed.id, sid);
  assert.deepStrictEqual(replayed.choices.map((x) => x.id), ['once', 'reject']);
  await waitUntil(() => fake.state.sse.size >= 1);
  const at = c.mark();
  fake.ask('ses_fake1', { id: 'per_3', action: 'shell', resources: ['dir'] });
  const n = await c.wait((m) => m.type === 'notify' && m.requestId === 'per_3', 5000, at);
  assert.strictEqual(n.id, sid);
  for (const [rid, decision] of [['per_2', 'reject'], ['per_3', 'once']]) {
    c.send({ type: 'reply', id: sid, requestId: rid, decision });
    const ok = await c.wait((m) => m.type === 'replyResult' && m.requestId === rid, 5000, at);
    assert.strictEqual(ok.ok, true, rid);
  }
  assert.deepStrictEqual(fake.state.replies.slice(-2), [
    { sessionID: 'ses_fake1', requestID: 'per_2', decision: 'reject' },
    { sessionID: 'ses_fake1', requestID: 'per_3', decision: 'once' },
  ]);
  await assertPasswordNowhere();
});

test('kill: SSE subscription of the session is dropped', { timeout: 30000 }, async () => {
  const at = c.mark();
  c.send({ type: 'kill', id: sid });
  await c.wait((m) => m.type === 'exit' && m.id === sid, 10000, at);
  await waitUntil(() => fake.state.sse.size === 0, 10000);
});
