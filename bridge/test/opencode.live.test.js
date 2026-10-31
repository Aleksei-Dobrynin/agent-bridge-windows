'use strict';
// Живой тест на настоящем фоновом сервисе opencode (CB_LIVE_OPENCODE=1). Модель не вызывается:
// запрос разрешения создаётся через POST /api/session/{id}/permission (OpenAPI v2.1.4,
// «Evaluate and, when approval is required, create a permission request»). Сервис не
// останавливается и не перезапускается; созданная сессия удаляется (DELETE /api/session/{id}).
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const oc = require('../agents/opencode');

const LIVE = process.env.CB_LIVE_OPENCODE === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(50); }
  throw new Error('условие не выполнено');
}

test('live opencode service: ensure, session, SSE, permission asked -> reply -> replied, stale, delete',
  { skip: !LIVE && 'CB_LIVE_OPENCODE!=1', timeout: 90000 }, async () => {
    const a = oc.create('opencode', {});
    assert.ok(a.command && a.available(), 'opencode.exe найден рядом с opencode.cmd');
    const client = a.client;
    const spec = await a.spawnSpec({ cwd: os.tmpdir(), title: 'claude-bridge live test', options: { askShell: true }, rawArgs: [] });
    const sid = spec.state.opencodeSessionId;
    let del = null;
    try {
      assert.match(sid, /^ses_/);
      assert.match(spec.args[spec.args.indexOf('--server') + 1], /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/);
      assert.ok(spec.env.OPENCODE_PASSWORD);
      assert.deepStrictEqual(await client.listPermissions(sid), []);

      const ev = [];
      const un = a.subscribe({ id: 'live', agentState: spec.state, runtime: {} }, (e) => ev.push(...e));
      await waitUntil(() => client.sseOpen, 10000); // поток открыт (SSE 200)

      const created = await client.request('POST', `/api/session/${sid}/permission`,
        { action: 'shell', resources: ['echo claude-bridge-live'], save: ['echo *'] });
      assert.strictEqual(created.status, 200, JSON.stringify(created.json));
      assert.strictEqual(created.json.data.effect, 'ask', JSON.stringify(created.json));
      const rid = created.json.data.id;
      assert.match(rid, /^per_/);

      await waitUntil(() => ev.some((e) => e.kind === 'request' && e.requestId === rid), 10000);
      const req = ev.find((e) => e.kind === 'request' && e.requestId === rid);
      assert.match(req.message, /shell: echo claude-bridge-live/);
      assert.deepStrictEqual(req.choices.map((c) => c.id), ['once', 'always', 'reject']);
      const listed = await client.listPermissions(sid);
      assert.deepStrictEqual(listed.map((p) => p.id), [rid]);
      assert.strictEqual(listed[0].sessionID, sid);

      assert.deepStrictEqual(await a.reply({ agentState: spec.state }, { requestId: rid }, 'reject'),
        { ok: true, events: [{ kind: 'requestClosed', requestId: rid }] });
      await waitUntil(() => ev.some((e) => e.kind === 'requestClosed' && e.requestId === rid), 10000);
      const again = await a.reply({ agentState: spec.state }, { requestId: rid }, 'once');
      assert.deepStrictEqual(again, { ok: false, stale: true, events: [{ kind: 'requestClosed', requestId: rid }] });
      assert.deepStrictEqual(await client.listPermissions(sid), []);
      un();
    } finally {
      // только уборка: assert в finally заменил бы исходную ошибку теста
      del = await client.request('DELETE', `/api/session/${sid}`).catch((e) => ({ status: e.message }));
      client.close();
    }
    assert.strictEqual(del.status, 204, 'тестовая сессия удалена');
  });
