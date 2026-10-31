'use strict';
// Интеграция: события адаптера в мосте (D-4) — /hook через адаптер claude, notify{requestId, choices},
// reply -> клавиша в PTY и replyResult, защита от устаревших ответов, закрытие запросов вводом и kill.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/bridge');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { FAKE_AGENT, DEVICE, createAndAttach, sleep } = H;
const metaOf = (id) => JSON.parse(fs.readFileSync(path.join(b.home, 'sessions', id + '.json'), 'utf8'));
let b;
let c;
let sid;
let hookToken;
const PR = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo hi' },
  permission_suggestions: [{ type: 'addRules' }] };
const ESC_ECHO = new RegExp('ECHO:' + JSON.stringify(JSON.stringify('\x1b')).slice(1, -1));

test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-req-', devices: [DEVICE], config: {
    defaultAgent: 'claude', agents: { claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] } },
  } });
  c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'claude', cwd: b.cwd });
  assert.strictEqual(r.type, 'created');
  sid = r.id;
  hookToken = (await c.waitOutput(sid, /HOOKTOKEN:([0-9a-f]{64})/))[1];
});
test.after(() => b.stop());

async function openRequest(payload = PR) {
  const at = c.mark();
  assert.strictEqual(await b.postHook(sid, hookToken, payload), 200);
  // поправка 8: событие применено ДО ответа хуку — notify уже в пути к клиенту
  return c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'request', 5000, at);
}

const listed = async (since) => (await c.wait((m) => m.type === 'sessions', 5000, since)).sessions.find((s) => s.id === sid);

test('hook with a wrong token is refused', async () => {
  assert.strictEqual(await b.postHook(sid, 'a'.repeat(64), PR), 403);
});

test('request -> notify{requestId, choices}; reply once -> key 1; repeat is stale', { timeout: 30000 }, async () => {
  const at0 = c.mark();
  const n = await openRequest();
  assert.match(n.requestId, /^req_[0-9a-f]{16}$/);
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'always', 'reject']);
  assert.match(n.message, /Bash: echo hi/);
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'waiting', 5000, at0);
  const before = await listed(at0);
  assert.strictEqual(before.lastNotify.event, 'request');
  // M-6: признак PermissionRequest сохранён в meta (переживает рестарт моста)
  assert.strictEqual(metaOf(sid).agentState.sawPermissionRequest, true);

  let at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'once' });
  const ok = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.id, sid);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 5000, at);
  await c.waitOutput(sid, /ECHO:"1"/);
  // запрос закрыт — в списке сессий он больше не висит
  assert.strictEqual((await listed(at)).lastNotify, null);

  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'always' });
  const stale = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.deepStrictEqual([stale.ok, stale.error], [false, 'stale']);
  await sleep(800);
  assert.doesNotMatch(c.output(sid), /ECHO:"2"/);
});

test('reply validation: unknown request, foreign session, decision not offered', { timeout: 30000 }, async () => {
  let at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: 'req_0000000000000000', decision: 'once' });
  let r = await c.wait((m) => m.type === 'replyResult', 5000, at);
  assert.deepStrictEqual([r.ok, r.error], [false, 'stale']);
  const n = await openRequest({ ...PR, permission_suggestions: [] });
  assert.deepStrictEqual(n.choices.map((x) => x.id), ['once', 'reject']);
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'always' });
  r = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  // M-5: решение не из choices — ошибка клиента (failed), а не «запрос устарел»
  assert.deepStrictEqual([r.ok, r.error], [false, 'failed'], '«Всегда» не предлагалось');
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'maybe' });
  r = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.deepStrictEqual([r.ok, r.error], [false, 'failed'], 'unknown decision');
  c.send({ type: 'reply', id: 's999-ffffff', requestId: n.requestId, decision: 'once' });
  c.send({ type: 'reply', id: sid, requestId: { x: 1 }, decision: 'once' });
  await sleep(500);
  assert.ok(!c.msgs.slice(at).some((m) => m.type === 'requestClosed'), 'request still open');
  // закрыть ответом «Да», чтобы не мешать следующим тестам
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'once' });
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 5000, at);
});

test('pending requests are replayed to a newly connected client (D-20)', { timeout: 30000 }, async () => {
  const n = await openRequest();
  const late = await b.connect(DEVICE.token);
  const first = await late.wait((m) => m.type === 'sessions');
  const replay = await late.wait((m) => m.type === 'notify' && m.event === 'request' && m.requestId === n.requestId);
  assert.ok(late.msgs.indexOf(first) < late.msgs.indexOf(replay), 'replay comes after the initial sessions');
  assert.deepStrictEqual(
    [replay.id, replay.choices, replay.message, replay.title, replay.at],
    [sid, n.choices, n.message, n.title, n.at]);
  assert.strictEqual(late.msgs.filter((m) => m.type === 'notify' && m.requestId === n.requestId).length, 1);
  const at = late.mark();
  const cAt = c.mark();
  late.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'once' });
  const ok = await late.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.strictEqual(ok.ok, true);
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 5000, cAt);
  // закрытый запрос следующему клиенту уже не повторяется
  const later = await b.connect(DEVICE.token);
  await later.wait((m) => m.type === 'sessions');
  await sleep(500);
  assert.ok(!later.msgs.some((m) => m.type === 'notify' && m.requestId === n.requestId));
  late.close();
  later.close();
});

test('PTY input from any client closes the request; focus reports and scroll do not', { timeout: 30000 }, async () => {
  const owner = await b.connect(b.owner);
  const n = await openRequest();
  let at = c.mark();
  owner.send({ type: 'input', id: sid, data: '\x1b[I' });
  owner.send({ type: 'scroll', id: sid, data: 'x' });
  await sleep(700);
  assert.ok(!c.msgs.slice(at).some((m) => m.type === 'requestClosed'), 'focus report and scroll keep the request open');
  owner.send({ type: 'input', id: sid, data: 'x' });
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 5000, at);
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n.requestId, decision: 'once' });
  const r = await c.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.strictEqual(r.ok, false);

  const n2 = await openRequest();
  at = c.mark();
  c.send({ type: 'reply', id: sid, requestId: n2.requestId, decision: 'reject' });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'idle', 5000, at);
  await c.waitOutput(sid, ESC_ECHO);
});

test('agent_id events do not change status; Stop -> idle + done', { timeout: 30000 }, async () => {
  let at = c.mark();
  await b.postHook(sid, hookToken, { hook_event_name: 'UserPromptSubmit', prompt: 'p' });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'working', 5000, at);
  at = c.mark();
  await b.postHook(sid, hookToken, { hook_event_name: 'Stop', agent_id: 'sub1' });
  await sleep(700);
  assert.ok(!c.msgs.slice(at).some((m) => m.type === 'status' && m.id === sid), 'subagent Stop ignored');
  await b.postHook(sid, hookToken, { hook_event_name: 'Stop' });
  await c.wait((m) => m.type === 'status' && m.id === sid && m.status === 'idle', 5000, at);
  const done = await c.wait((m) => m.type === 'notify' && m.id === sid && m.event === 'done', 5000, at);
  assert.match(done.message, /завершил/);
});

test('invalid hook payloads are refused without killing the bridge', async () => {
  for (const body of ['null', '[1]', '"x"']) {
    const r = await H.request(b.port, b.pin, { path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + hookToken, 'X-Bridge-Session': sid } }, body);
    assert.strictEqual(r.statusCode, 400, body);
  }
  assert.strictEqual(await b.postHook(sid, hookToken, { hook_event_name: 'Notification', message: 42 }), 200);
});

test('kill closes pending requests', { timeout: 30000 }, async () => {
  const n = await openRequest();
  const at = c.mark();
  c.send({ type: 'kill', id: sid });
  await c.wait((m) => m.type === 'requestClosed' && m.requestId === n.requestId, 10000, at);
  await c.wait((m) => m.type === 'exit' && m.id === sid, 10000, at);
});

test('M-9: input that did not reach the keeper does not close the request', { timeout: 90000 }, async () => {
  const r = await createAndAttach(c, { agent: 'claude', cwd: b.cwd });
  assert.strictEqual(r.type, 'created');
  const id = r.id;
  const tok = (await c.waitOutput(id, /HOOKTOKEN:([0-9a-f]{64})/))[1];
  c.close();
  // мост перезапускается, а pipe в meta — чужой: keeper жив (pid в meta), канал не поднимается,
  // мост ~30 с повторяет подключение — сессия жива, канала нет
  await b.restart(() => {
    const file = path.join(b.home, 'sessions', id + '.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.pipe = '\\\\.\\pipe\\claude-bridge-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(file, JSON.stringify(meta));
  });
  const d = await b.connect(DEVICE.token);
  await d.wait((m) => m.type === 'sessions' && m.sessions.some((x) => x.id === id && x.alive), 20000);
  let at = d.mark();
  assert.strictEqual(await b.postHook(id, tok, PR), 200);
  const n = await d.wait((m) => m.type === 'notify' && m.id === id && m.event === 'request', 5000, at);
  at = d.mark();
  d.send({ type: 'input', id, data: 'x' });
  await sleep(700);
  assert.ok(!d.msgs.slice(at).some((m) => m.type === 'requestClosed'), 'undelivered input keeps the request open');
  d.send({ type: 'reply', id, requestId: n.requestId, decision: 'once' });
  const res = await d.wait((m) => m.type === 'replyResult' && m.requestId === n.requestId, 5000, at);
  assert.deepStrictEqual([res.ok, res.error], [false, 'failed'], 'D-19 п. 6: key not delivered');
  assert.ok(!d.msgs.slice(at).some((m) => m.type === 'requestClosed'));
});
