'use strict';
// Интеграция: реестр агентов в мосте — список агентов в sessions (D-5, D-10), create {agent, options},
// устройство не передаёт сырые args/command (P-3), владелец — может.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge');

const { FAKE_AGENT, DEVICE, createAndAttach } = H;
let b;
test.before(async () => {
  b = await H.startTestBridge({ prefix: 'cb-agents-', devices: [DEVICE], config: {
    defaultAgent: 'echo',
    claudeCommand: 'claude', // M-7: устаревший ключ — предупреждение при старте
    agents: {
      echo: { type: 'generic', name: 'Echo', command: process.execPath, args: [FAKE_AGENT] },
      claude: { command: process.execPath, prefixArgs: [FAKE_AGENT] },
      broken: { type: 'generic', command: 'definitely-not-a-command-cb' },
    },
  } });
});
test.after(() => b.stop());

const listedSession = async (c, id) => (await c.wait((x) => x.type === 'sessions' && x.sessions.some((s) => s.id === id)))
  .sessions.find((s) => s.id === id);

test('sessions message lists available agents with options and scroll (D-5, D-10)', async () => {
  const c = await b.connect(DEVICE.token);
  const s = await c.wait((m) => m.type === 'sessions');
  assert.deepStrictEqual(s.agents.map((a) => a.id), ['echo', 'claude']);
  assert.strictEqual(s.defaultAgent, 'echo');
  const claude = s.agents.find((a) => a.id === 'claude');
  assert.deepStrictEqual(claude.options.map((o) => o.id), ['resume', 'skipPermissions']);
  assert.strictEqual(claude.scroll, 'wheel');
  assert.strictEqual(s.agents.find((a) => a.id === 'echo').scroll, 'pageKeys');
  assert.strictEqual(s.agents.find((a) => a.id === 'echo').name, 'Echo');
});

test('device: options become flags; raw args and command ignored (P-3)', { timeout: 60000 }, async () => {
  const c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'claude', cwd: b.cwd,
    options: { resume: true, skipPermissions: true, bogus: true }, args: ['--evil'], command: 'cmd.exe' });
  assert.strictEqual(r.type, 'created');
  const m = await c.waitOutput(r.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), ['--resume', '--dangerously-skip-permissions']);
  const listed = await listedSession(c, r.id);
  assert.strictEqual(listed.agent, 'claude');
  assert.strictEqual(listed.agentName, 'Claude Code');
  assert.strictEqual(listed.scroll, 'wheel');
  // meta на диске: агент и его состояние для восстановления, окружения агента нет
  const meta = JSON.parse(fs.readFileSync(path.join(b.home, 'sessions', r.id + '.json'), 'utf8'));
  assert.strictEqual(meta.agent, 'claude');
  assert.strictEqual(meta.env, undefined);
});

test('device: options given as non-true values are ignored', { timeout: 60000 }, async () => {
  const c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'claude', cwd: b.cwd, options: { resume: 'true', skipPermissions: 1 } });
  assert.strictEqual(r.type, 'created');
  const m = await c.waitOutput(r.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), []);
});

test('owner: default agent, raw args appended', { timeout: 60000 }, async () => {
  const c = await b.connect(b.owner);
  const r = await createAndAttach(c, { cwd: b.cwd, args: ['--owner-arg'] });
  assert.strictEqual(r.type, 'created');
  const m = await c.waitOutput(r.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), ['--owner-arg']);
  const listed = await listedSession(c, r.id);
  assert.strictEqual(listed.agent, 'echo');
  assert.strictEqual(listed.scroll, 'pageKeys');
  assert.match(listed.title, /· Echo$/);
});

test('owner: own command runs as a mirror-only session', { timeout: 60000 }, async () => {
  const c = await b.connect(b.owner);
  const r = await createAndAttach(c, { cwd: b.cwd, command: process.execPath, args: [FAKE_AGENT, '--own'] });
  assert.strictEqual(r.type, 'created');
  const m = await c.waitOutput(r.id, /ARGV:(\[[^\]]*\])/);
  assert.deepStrictEqual(JSON.parse(m[1]), ['--own']);
  const listed = await listedSession(c, r.id);
  assert.strictEqual(listed.agentName, path.basename(process.execPath));
  assert.strictEqual(listed.scroll, 'pageKeys');
});

test('unknown agent and missing owner command are refused (D-5)', async () => {
  const c = await b.connect(DEVICE.token);
  const r = await createAndAttach(c, { agent: 'nope', cwd: b.cwd });
  assert.strictEqual(r.type, 'error');
  assert.match(r.message, /неизвестный агент/);
  const broken = await createAndAttach(c, { agent: 'broken', cwd: b.cwd });
  assert.strictEqual(broken.type, 'error', 'unavailable agent is not in the registry');
  const o = await b.connect(b.owner);
  const nocmd = await createAndAttach(o, { cwd: b.cwd, command: 'definitely-not-a-command-cb' });
  assert.strictEqual(nocmd.type, 'error');
  assert.match(nocmd.message, /команда не найдена/);
});

test('M-2: agent present but invalid is refused; absent -> default agent', { timeout: 60000 }, async () => {
  const c = await b.connect(DEVICE.token);
  const o = await b.connect(b.owner);
  // предел 10 create в минуту на клиента — делим попытки между устройством и владельцем
  for (const [cl, agent] of [[c, null], [c, 42], [c, { id: 'echo' }], [o, ['echo']], [o, ''], [o, 'x'.repeat(33)]]) {
    const r = await createAndAttach(cl, { agent, cwd: b.cwd });
    assert.strictEqual(r.type, 'error', JSON.stringify(agent));
    assert.match(r.message, /неизвестный агент/, JSON.stringify(agent));
  }
  const r = await createAndAttach(c, { cwd: b.cwd });
  assert.strictEqual(r.type, 'created');
  assert.strictEqual((await listedSession(c, r.id)).agent, 'echo');
});

test('M-7: warning about the ignored claudeCommand/claudeArgs at startup', () => {
  assert.match(b.logs(), /claudeCommand\/claudeArgs больше не используются/);
});

test('M-8: no available agents -> "нет доступных агентов"; diagnostics in the log', { timeout: 60000 }, async () => {
  const nb = await H.startTestBridge({ prefix: 'cb-noagents-', devices: [DEVICE], config: {
    defaultAgent: 'ghost', agents: { ghost: { type: 'generic', command: 'definitely-not-a-command-cb' } },
  } });
  try {
    const c = await nb.connect(DEVICE.token);
    const r = await createAndAttach(c, { cwd: nb.cwd });
    assert.strictEqual(r.type, 'error');
    assert.match(r.message, /нет доступных агентов/);
    assert.match(nb.logs(), /«ghost».*не найден: definitely-not-a-command-cb/);
    assert.match(nb.logs(), /по умолчанию «ghost» недоступен/);
    assert.doesNotMatch(nb.logs(), /claudeCommand/, 'no M-7 warning without the old keys');
  } finally { await nb.stop(); }
});
