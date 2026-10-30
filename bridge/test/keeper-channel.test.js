'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const K = require('../lib/keeper-channel');

function startServer(secret) {
  const pipe = K.pipeName();
  const got = [];
  const srv = net.createServer((sock) => {
    K.acceptAuthenticated(sock, secret, (s) => {
      K.send(s, { t: 'hello', buffer: 'SCREEN' });
      return (m) => got.push(m);
    });
  });
  return new Promise((r) => srv.listen(pipe, () => r({ srv, pipe, got })));
}

test('pipe name is random and in pipe namespace', () => {
  const a = K.pipeName();
  assert.match(a, /^\\\\\.\\pipe\\claude-bridge-[0-9a-f]{32}$/);
  assert.notStrictEqual(a, K.pipeName());
});

test('correct secret: hello delivered, messages flow', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const { srv, pipe, got } = await startServer(secret);
  const ch = await K.connectAuthenticated(pipe, secret);
  const first = await new Promise((r) => ch.onMessage(r));
  assert.deepStrictEqual(first, { t: 'hello', buffer: 'SCREEN' });
  ch.send({ t: 'in', d: 'x' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(got, [{ t: 'in', d: 'x' }]);
  ch.socket.destroy(); srv.close();
});

test('wrong secret: rejected, nothing leaked', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const { srv, pipe, got } = await startServer(secret);
  await assert.rejects(K.connectAuthenticated(pipe, crypto.randomBytes(32).toString('hex')));
  assert.deepStrictEqual(got, []);
  srv.close();
});

test('raw client gets only the challenge and is dropped on garbage', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const { srv, pipe, got } = await startServer(secret);
  const raw = net.connect(pipe);
  let data = '';
  raw.on('data', (d) => (data += d));
  raw.on('error', () => {});
  await new Promise((r) => setTimeout(r, 150));
  raw.write('{"t":"in","d":"evil"}\n');
  await new Promise((r) => raw.on('close', r));
  assert.match(data, /"t":"challenge"/);
  assert.doesNotMatch(data, /SCREEN/);
  assert.deepStrictEqual(got, []);
  srv.close();
});

test('impostor server without secret is detected by client', async () => {
  const pipe = K.pipeName();
  const srv = net.createServer((s) => {
    K.send(s, { t: 'challenge', nonce: crypto.randomBytes(32).toString('hex') });
    s.on('data', () => K.send(s, { t: 'auth-ok', mac: '0'.repeat(64) }));
    s.on('error', () => {});
  });
  await new Promise((r) => srv.listen(pipe, r));
  await assert.rejects(K.connectAuthenticated(pipe, crypto.randomBytes(32).toString('hex')));
  srv.close();
});
