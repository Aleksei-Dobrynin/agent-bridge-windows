'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const K = require('../lib/keeper-channel');

const secret = crypto.randomBytes(32).toString('hex');

async function startServer(t, opts) {
  const pipe = K.pipeName();
  const got = [];
  const srv = net.createServer((sock) => {
    K.acceptAuthenticated(sock, secret, (s) => {
      K.send(s, { t: 'hello', buffer: 'SCREEN' });
      return (m) => got.push(m);
    }, opts);
  });
  await new Promise((r) => srv.listen(pipe, r));
  t.after(() => srv.close());
  return { pipe, got };
}

function rawClient(pipe) {
  const sock = net.connect(pipe);
  const st = { data: '', closed: false };
  sock.on('data', (d) => { st.data += d; });
  sock.on('error', () => {});
  sock.on('close', () => { st.closed = true; });
  return { sock, st };
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

async function legitStillWorks(pipe) {
  const ch = await K.connectAuthenticated(pipe, secret);
  const first = await new Promise((r) => ch.onMessage(r));
  assert.strictEqual(first.t, 'hello');
  ch.socket.destroy();
}

test('non-string nonce / mac does not crash the server', async (t) => {
  const { pipe, got } = await startServer(t);
  const { sock, st } = rawClient(pipe);
  await waitFor(() => st.data.includes('challenge'));
  sock.write('{"t":"auth","nonce":{"toString":1},"mac":{"toString":1}}' + String.fromCharCode(10));
  assert.ok(await waitFor(() => st.closed), 'bad client dropped');
  assert.deepStrictEqual(got, []);
  await legitStillWorks(pipe);
});

test('garbage JSON before auth: server survives, nothing leaked', async (t) => {
  const { pipe, got } = await startServer(t);
  const { sock, st } = rawClient(pipe);
  await waitFor(() => st.data.includes('challenge'));
  sock.write('this is not json' + String.fromCharCode(10) + '[1,2]' + String.fromCharCode(10));
  sock.destroy();
  assert.doesNotMatch(st.data, /SCREEN/);
  assert.deepStrictEqual(got, []);
  await legitStillWorks(pipe);
});

test('oversized pre-auth line: connection destroyed, server survives', async (t) => {
  const { pipe } = await startServer(t);
  const { sock, st } = rawClient(pipe);
  await waitFor(() => st.data.includes('challenge'));
  sock.write('x'.repeat(10 * 1024));
  assert.ok(await waitFor(() => st.closed), 'oversized pre-auth line dropped');
  await legitStillWorks(pipe);
});

test('replay of a recorded auth line on a new connection fails', async (t) => {
  const { pipe, got } = await startServer(t);
  // записываем легитимный auth (считаем HMAC так же, как клиент)
  const a = rawClient(pipe);
  await waitFor(() => a.st.data.includes('challenge'));
  const nonceS = JSON.parse(a.st.data.split(String.fromCharCode(10))[0]).nonce;
  const nonceC = crypto.randomBytes(32).toString('hex');
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update('client|' + nonceS).digest('hex');
  const authLine = JSON.stringify({ t: 'auth', mac, nonce: nonceC }) + String.fromCharCode(10);
  a.sock.write(authLine);
  assert.ok(await waitFor(() => a.st.data.includes('hello')), 'original handshake works');
  a.sock.destroy();
  // повтор на новом соединении (другой nonce сервера)
  const b = rawClient(pipe);
  await waitFor(() => b.st.data.includes('challenge'));
  b.sock.write(authLine);
  assert.ok(await waitFor(() => b.st.closed), 'replay dropped');
  assert.doesNotMatch(b.st.data, /SCREEN|hello/);
  assert.deepStrictEqual(got, []);
});

test('handshake timeout closes an idle socket', async (t) => {
  const { pipe } = await startServer(t, { handshakeTimeoutMs: 200 });
  const { st } = rawClient(pipe);
  assert.ok(await waitFor(() => st.closed, 2000), 'idle socket closed by timeout');
});

test('client: impostor with non-string nonce rejects instead of throwing', async (t) => {
  const pipe = K.pipeName();
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    s.write('{"t":"challenge","nonce":{"toString":1}}' + String.fromCharCode(10));
  });
  await new Promise((r) => srv.listen(pipe, r));
  t.after(() => srv.close());
  await assert.rejects(K.connectAuthenticated(pipe, secret));
});

test('malformed secret is rejected, not thrown from a handler', async (t) => {
  const { pipe } = await startServer(t);
  await assert.rejects(K.connectAuthenticated(pipe, 'zz'));
  await legitStillWorks(pipe);
});

test('fitHello drops oldest chunks to fit the limit', () => {
  const chunks = ['A'.repeat(1000), 'B'.repeat(1000), 'C'.repeat(1000)];
  const h = K.fitHello({ t: 'hello', cols: 80 }, chunks, 2200);
  assert.ok(JSON.stringify(h).length <= 2200);
  assert.ok(h.buffer.endsWith('C'.repeat(1000)));
  assert.ok(!h.buffer.includes('A'));
  const one = K.fitHello({ t: 'hello' }, ['x'.repeat(5000)], 1000);
  assert.ok(JSON.stringify(one).length <= 1000);
  assert.deepStrictEqual(K.fitHello({ t: 'hello' }, ['ok'], 1000), { t: 'hello', buffer: 'ok' });
});

// --- регрессии повторного ревью ---
const NL = String.fromCharCode(10);

// Сервер с верным HMAC, который отвечает auth-ok + hello ОДНИМ socket.write.
async function fakeServerOneWrite(t, helloBuffer) {
  const pipe = K.pipeName();
  const srv = net.createServer((sock) => {
    sock.on('error', () => {});
    const nonce = crypto.randomBytes(32).toString('hex');
    K.readLines(sock, (m) => {
      if (m.t !== 'auth') return;
      const mac = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update('server|' + m.nonce).digest('hex');
      sock.write(JSON.stringify({ t: 'auth-ok', mac }) + NL + JSON.stringify({ t: 'hello', buffer: helloBuffer }) + NL);
    });
    sock.write(JSON.stringify({ t: 'challenge', nonce }) + NL);
  });
  await new Promise((r) => srv.listen(pipe, r));
  t.after(() => srv.close());
  return pipe;
}

test('CR-1: auth-ok + 300 KB hello in one chunk is accepted', async (t) => {
  const big = 'S'.repeat(300 * 1024);
  const pipe = await fakeServerOneWrite(t, big);
  const ch = await K.connectAuthenticated(pipe, secret);
  const first = await new Promise((r) => ch.onMessage(r));
  assert.strictEqual(first.t, 'hello');
  assert.strictEqual(first.buffer, big);
  ch.socket.destroy();
});

test('CR-1: a complete 5 KB pre-auth line is still rejected', async (t) => {
  const { pipe } = await startServer(t);
  const { sock, st } = rawClient(pipe);
  await waitFor(() => st.data.includes('challenge'));
  sock.write(JSON.stringify({ t: 'auth', pad: 'x'.repeat(5 * 1024) }) + NL);
  assert.ok(await waitFor(() => st.closed), 'dropped');
  await legitStillWorks(pipe);
});

test('IM-1: multi-byte characters survive chunk boundaries', async (t) => {
  const text = 'ж─█'.repeat(60000);
  const pipe = await fakeServerOneWrite(t, text);
  const ch = await K.connectAuthenticated(pipe, secret);
  const first = await new Promise((r) => ch.onMessage(r));
  assert.strictEqual(first.buffer, text);
  assert.ok(!first.buffer.includes('�'));
  ch.socket.destroy();
});

test('20 idle unauthenticated connections do not block a legitimate client', async (t) => {
  const { pipe } = await startServer(t);
  const idle = [];
  for (let i = 0; i < 20; i++) idle.push(rawClient(pipe));
  t.after(() => idle.forEach((c) => c.sock.destroy()));
  await legitStillWorks(pipe);
});
