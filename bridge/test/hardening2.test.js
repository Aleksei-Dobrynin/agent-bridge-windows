'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const K = require('../lib/keeper-channel');
const { resolveSpawn } = require('../lib/which');
const { createWriter } = require('../lib/log');
const V = require('../lib/validate');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(50); }
  return false;
}

test('which: shim args with CR / LF / NUL are rejected', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\0b']) {
    assert.throws(() => resolveSpawn('npm', [bad]), /недопустим/);
  }
});

test('which: delayed expansion is switched off', () => {
  const r = resolveSpawn('npm', ['-v']);
  assert.match(r.args, /^\/d \/v:off \/s \/c "/);
});

test('log: ESC and other C0 controls are escaped', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-log2-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  createWriter(d)('INFO', ['a\x1b[31mred\x07\x00b\tc']);
  const s = fs.readFileSync(path.join(d, 'bridge.log'), 'utf8');
  assert.ok(!s.includes('\x1b') && !s.includes('\x07') && !s.includes('\x00'));
  assert.ok(s.includes('\\x1b[31mred\\x07\\x00b\tc'));
});

test('cleanTitle strips more invisible characters', () => {
  assert.strictEqual(V.cleanTitle('a b c؜d⁠e⁤f᠎g'), 'abcdefg');
});

function setup(t, id, over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-keeper2-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  const secret = crypto.randomBytes(32).toString('hex');
  const meta = { id, cmd: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root,
    cols: 80, rows: 24, pipe: K.pipeName(), secret, ...over };
  const metaPath = path.join(root, 'sessions', id + '.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const st = { pid: null };
  t.after(() => {
    if (st.pid) spawnSync('taskkill', ['/PID', String(st.pid), '/T', '/F'], { stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const k = spawn(process.execPath, [path.join(__dirname, '..', 'keeper.js'), metaPath],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, CLAUDE_BRIDGE_KEEPER_SECRET: secret } });
  st.pid = k.pid;
  const exited = new Promise((r) => k.on('exit', r));
  return { root, meta, metaPath, secret, exited };
}

test('keeper: invalid meta.pipe is refused (no TCP listen), logged, exit 1', { timeout: 20000 }, async (t) => {
  const e = setup(t, 's5-test', { pipe: undefined });
  assert.strictEqual(await e.exited, 1);
  const log = path.join(e.root, 'logs', 'keeper-s5-test.log');
  assert.match(fs.readFileSync(log, 'utf8'), /pipe/);
  assert.strictEqual(fs.existsSync(e.metaPath), false);
});

test('keeper: at most 16 authenticated clients', { timeout: 30000 }, async (t) => {
  const e = setup(t, 's6-test');
  const chans = [];
  t.after(() => chans.forEach((c) => c.socket.destroy()));
  for (let i = 0; i < 16; i++) {
    let ch = null;
    assert.ok(await waitFor(async () => { ch = await K.connectAuthenticated(e.meta.pipe, e.secret).catch(() => null); return ch; }));
    let got = false;
    ch.onMessage(() => { got = true; });
    assert.ok(await waitFor(() => got), 'hello #' + i);
    chans.push(ch);
  }
  // 17-й проходит рукопожатие, но затем уничтожается
  let extra = null;
  extra = await K.connectAuthenticated(e.meta.pipe, e.secret).catch(() => null);
  if (extra) {
    let closed = false;
    extra.socket.on('close', () => { closed = true; });
    assert.ok(await waitFor(() => closed), '17th client destroyed');
  }
  // первый клиент жив
  chans[0].send({ t: 'in', d: 'x' });
  assert.strictEqual(chans[0].socket.destroyed, false);
});
