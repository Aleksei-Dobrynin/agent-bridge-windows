'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { loadOrCreateCert, pinnedTlsOptions } = require('../lib/cert');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('generate, reload, serve, pin', { timeout: 60000 }, async (t) => {
  const dir = tmpDir(t);
  const a = loadOrCreateCert(dir);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  const b = loadOrCreateCert(dir);
  assert.strictEqual(b.fingerprint, a.fingerprint, 'second call reuses files');
  const der = new crypto.X509Certificate(a.certPem).raw;
  assert.strictEqual(crypto.createHash('sha256').update(der).digest('hex'), a.fingerprint);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['bridge.cer', 'bridge.pass', 'bridge.pfx'],
    'no temp files left behind');

  const srv = https.createServer(a.tls, (req, res) => res.end('ok'));
  t.after(() => srv.close());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  // agent:false — иначе keep-alive переиспользует сокет и пиннинг не проверяется заново
  const get = (opts) => new Promise((resolve) => {
    https.get({ host: '127.0.0.1', port, path: '/', agent: false, ...opts }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s));
    }).on('error', (e) => resolve('ERR ' + e.message));
  });
  assert.strictEqual(await get(pinnedTlsOptions(a.certPem, a.fingerprint)), 'ok');
  assert.match(await get(pinnedTlsOptions(a.certPem, '0'.repeat(64))), /^ERR/);
});

test('corrupt pfx is regenerated once with a loud re-pair warning', { timeout: 60000 }, (t) => {
  const dir = tmpDir(t);
  const a = loadOrCreateCert(dir);
  fs.writeFileSync(path.join(dir, 'bridge.pfx'), 'garbage');
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let b;
  try { b = loadOrCreateCert(dir); } finally { console.error = orig; }
  assert.notStrictEqual(b.fingerprint, a.fingerprint);
  assert.ok(errors.length > 0, 'console.error called');
  assert.match(errors.join('\n'), /pair/i);
  assert.ok(b.tls.pfx.length > 100);
});

test('bridge.cer that does not match the certificate inside the PFX -> treated as corrupted', { timeout: 120000 }, (t) => {
  const dir = tmpDir(t);
  const other = tmpDir(t);
  const a = loadOrCreateCert(dir);
  const o = loadOrCreateCert(other);
  // подменённый .cer: отпечаток для телефона/хука не соответствовал бы ключу, которым мост реально отвечает
  fs.copyFileSync(path.join(other, 'bridge.cer'), path.join(dir, 'bridge.cer'));
  const orig = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  let b;
  try { b = loadOrCreateCert(dir); } finally { console.error = orig; }
  assert.match(errors.join('\n'), /pair/i, 'loud re-pair warning');
  assert.notStrictEqual(b.fingerprint, a.fingerprint);
  assert.notStrictEqual(b.fingerprint, o.fingerprint);
  // новый .cer совпадает с сертификатом, которым мост реально отвечает
  const tls = require('tls');
  const s = new tls.TLSSocket(null, { secureContext: tls.createSecureContext(b.tls) });
  const served = crypto.createHash('sha256').update(s.getCertificate().raw).digest('hex');
  s.destroy();
  assert.strictEqual(served, b.fingerprint);
});
