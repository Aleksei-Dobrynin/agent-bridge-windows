'use strict';
// Task 12: хук Claude Code на Node — токен хука сессии и пиннинг сертификата моста (P-4, P-6, M-8).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync, spawn } = require('child_process');
const { loadOrCreateCert } = require('../lib/cert');

const HOOK = path.join(__dirname, '..', 'hooks', 'bridge-hook.js');

test('no bridge session -> exit 0, no output', () => {
  const env = { ...process.env };
  delete env.CLAUDE_BRIDGE_SESSION;
  const r = spawnSync(process.execPath, [HOOK], { input: '{}', env, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('bridge unreachable -> exit 0 quickly, no output', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '{"hook_event_name":"Stop"}', encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, CLAUDE_BRIDGE_SESSION: 's1-abcdef', CLAUDE_BRIDGE_HOOK_TOKEN: 'a'.repeat(64),
      CLAUDE_BRIDGE_PORT: '1', CLAUDE_BRIDGE_CERT_FP: '0'.repeat(64) },
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('posts event with token and pins the certificate', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hookcert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cert = loadOrCreateCert(dir);
  let got = null;
  let requests = 0;
  const srv = https.createServer(cert.tls, (req, res) => {
    requests++;
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { got = { auth: req.headers.authorization, sid: req.headers['x-bridge-session'], body: b }; res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const run = (fp) => new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], {
      windowsHide: true,
      env: { ...process.env, CLAUDE_BRIDGE_SESSION: 's1-abcdef', CLAUDE_BRIDGE_HOOK_TOKEN: 'a'.repeat(64),
        CLAUDE_BRIDGE_PORT: String(srv.address().port), CLAUDE_BRIDGE_CERT_FP: fp },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stdin.end('{"hook_event_name":"Stop"}');
    p.on('exit', (code) => resolve({ code, out }));
  });
  assert.deepStrictEqual(await run('0'.repeat(64)), { code: 0, out: '' });
  assert.strictEqual(got, null, 'wrong fingerprint -> nothing sent');
  assert.strictEqual(requests, 0, 'wrong fingerprint -> no request reached the server');
  assert.deepStrictEqual(await run(cert.fingerprint.toUpperCase()), { code: 0, out: '' });
  assert.deepStrictEqual(got, { auth: 'Bearer ' + 'a'.repeat(64), sid: 's1-abcdef', body: '{"hook_event_name":"Stop"}' });
});
