'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const K = require('../lib/keeper-channel');

const KEEPER = path.join(__dirname, '..', 'keeper.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(50);
  }
  return false;
}

// root/sessions/<id>.json, логи — root/logs (как в мосте: <sessions>/../logs)
function setup(t, id, metaOverrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-keeper-'));
  const sessions = path.join(root, 'sessions');
  fs.mkdirSync(sessions);
  const secret = crypto.randomBytes(32).toString('hex');
  const meta = {
    id, cmd: process.execPath,
    args: ['-e', "console.log('SECRET:'+process.env.CLAUDE_BRIDGE_KEEPER_SECRET);" +
      "process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
    cwd: root, cols: 80, rows: 24, scrollbackBytes: 65536, pipe: K.pipeName(), secret,
    ...metaOverrides,
  };
  const metaPath = path.join(sessions, id + '.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const state = { pid: null };
  t.after(() => {
    if (state.pid) spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, meta, metaPath, secret, state };
}

function startKeeper(env, secretEnv, opts = {}) {
  const e = { ...process.env };
  delete e.CLAUDE_BRIDGE_KEEPER_SECRET;
  if (secretEnv !== undefined) e.CLAUDE_BRIDGE_KEEPER_SECRET = secretEnv;
  const k = spawn(process.execPath, [KEEPER, env.metaPath],
    { detached: !!opts.detached, windowsHide: true, stdio: 'ignore', env: e });
  env.state.pid = k.pid;
  const exited = new Promise((r) => k.on('exit', (code) => r(code)));
  if (opts.detached) k.unref();
  return { k, exited };
}

test('detached keeper: authenticated attach, output, input, no secret leak, kill', { timeout: 30000 }, async (t) => {
  const env = setup(t, 's1-test');
  startKeeper(env, env.secret, { detached: true });

  let ch = null;
  assert.ok(await waitFor(async () => {
    ch = await K.connectAuthenticated(env.meta.pipe, env.secret).catch(() => null);
    return ch;
  }), 'connected to keeper');
  const msgs = [];
  ch.onMessage((m) => msgs.push(m));
  assert.ok(await waitFor(() => msgs.length > 0), 'hello received');
  assert.strictEqual(msgs[0].t, 'hello');
  const screen = () => msgs.map((m) => (m.t === 'out' ? m.d : m.t === 'hello' ? m.buffer : '')).join('');
  assert.ok(await waitFor(() => screen().includes('SECRET:')), 'agent started');
  assert.match(screen(), /SECRET:undefined/, 'agent must not see the channel secret');
  assert.ok(!screen().includes(env.secret));
  ch.send({ t: 'in', d: 'ping\r' });
  assert.ok(await waitFor(() => screen().includes('ECHO:ping')), 'echo received');
  ch.send({ t: 'kill' });
  assert.ok(await waitFor(() => msgs.some((m) => m.t === 'exit')), 'exit received');
  assert.ok(await waitFor(() => !fs.existsSync(env.metaPath)), 'meta removed');
});

for (const [name, secretEnv, metaSecret] of [
  ['bad secret format', 'zz', 'zz'],
  ['missing secret', undefined, undefined],
]) {
  test(`keeper with ${name} exits with code 2 and serves nothing`, { timeout: 20000 }, async (t) => {
    const env = setup(t, 's2-test', { secret: metaSecret });
    if (metaSecret === undefined) {
      const m = JSON.parse(fs.readFileSync(env.metaPath, 'utf8'));
      delete m.secret;
      fs.writeFileSync(env.metaPath, JSON.stringify(m));
    }
    const { exited } = startKeeper(env, secretEnv);
    assert.strictEqual(await exited, 2);
    await assert.rejects(K.connectAuthenticated(env.meta.pipe, env.secret, 500));
    assert.strictEqual(fs.existsSync(env.metaPath), false, 'meta removed');
  });
}

test('startup failure (pipe already in use) is logged, meta removed, exit 1', { timeout: 20000 }, async (t) => {
  const env = setup(t, 's3-test');
  const squatter = net.createServer(() => {});
  await new Promise((r) => squatter.listen(env.meta.pipe, r));
  t.after(() => squatter.close());
  const { exited } = startKeeper(env, env.secret);
  assert.strictEqual(await exited, 1);
  const log = path.join(env.root, 'logs', 'keeper-s3-test.log');
  assert.ok(fs.existsSync(log), 'log written');
  assert.match(fs.readFileSync(log, 'utf8'), /EADDRINUSE/);
  assert.strictEqual(fs.existsSync(env.metaPath), false, 'meta removed');
});

test('startup failure (command not found) is logged, exit 1', { timeout: 20000 }, async (t) => {
  const env = setup(t, 's4-test', { cmd: 'definitely-not-a-command-cb' });
  const { exited } = startKeeper(env, env.secret);
  assert.strictEqual(await exited, 1);
  const log = path.join(env.root, 'logs', 'keeper-s4-test.log');
  assert.match(fs.readFileSync(log, 'utf8'), /не найдена/);
  assert.strictEqual(fs.existsSync(env.metaPath), false, 'meta removed');
});
