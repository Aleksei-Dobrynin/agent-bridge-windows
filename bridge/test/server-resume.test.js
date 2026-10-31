'use strict';
// Интеграция: конфликт resume решает мост (D-7, D-15 п. 2) — createConflict и повтор с force:true.
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/bridge');

const { FAKE_AGENT, DEVICE, createAndAttach } = H;
let b;
test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-resume-', devices: [DEVICE], config: {
    defaultAgent: 'claude', agents: {
      claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] },
      echo: { type: 'generic', command: process.execPath, args: [FAKE_AGENT] },
    },
  } });
});
test.after(() => b.stop());

test('resume next to a live session of the same agent -> createConflict, force creates', { timeout: 90000 }, async () => {
  const c = await b.connect(DEVICE.token);
  const first = await createAndAttach(c, { agent: 'claude', cwd: b.cwd });
  assert.strictEqual(first.type, 'created');
  const plain = await createAndAttach(c, { agent: 'claude', cwd: b.cwd.toUpperCase() });
  assert.strictEqual(plain.type, 'created', 'without resume no conflict');
  const other = await createAndAttach(c, { agent: 'echo', cwd: b.cwd });
  assert.strictEqual(other.type, 'created');
  const conflict = await createAndAttach(c, { agent: 'claude', cwd: b.cwd.toUpperCase(), options: { resume: true } });
  assert.strictEqual(conflict.type, 'createConflict');
  assert.strictEqual(conflict.reason, 'resumeLive');
  assert.strictEqual(conflict.cwd, b.cwd);
  assert.deepStrictEqual(conflict.live.map((x) => x.id).sort(), [first.id, plain.id].sort(), 'only the same agent');
  assert.ok(conflict.live.every((x) => typeof x.title === 'string'));
  const forced = await createAndAttach(c, { agent: 'claude', cwd: b.cwd, options: { resume: true }, force: true });
  assert.strictEqual(forced.type, 'created');
  const m = await c.waitOutput(forced.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), ['--resume']);
  const truthy = await createAndAttach(c, { agent: 'claude', cwd: b.cwd, options: { resume: true }, force: 'yes' });
  assert.strictEqual(truthy.type, 'createConflict', 'force must be exactly true');

  const o = await b.connect(b.owner);
  const raw = await createAndAttach(o, { agent: 'claude', cwd: b.cwd, args: ['-c'] });
  assert.strictEqual(raw.type, 'createConflict', 'owner raw --continue is resume-like too');
  const deviceRaw = await createAndAttach(c, { agent: 'claude', cwd: b.cwd, args: ['-c'] });
  assert.strictEqual(deviceRaw.type, 'created', 'device raw args are ignored (P-3), so no resume');
});
