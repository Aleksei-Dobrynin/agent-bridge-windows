'use strict';
// I-2: ссылка входа браузера владельца — сборка с проверкой и запуск браузера без шелла-сюрпризов.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const O = require('../lib/open-url');

const TOKEN = 'ab'.repeat(32);

test('buildLoginUrl: only a 64-hex token and a valid port', () => {
  assert.strictEqual(O.buildLoginUrl({ port: 8790, token: TOKEN }), `https://127.0.0.1:8790/?ott=${TOKEN}`);
  assert.strictEqual(O.buildLoginUrl({ port: 8790, token: TOKEN + '&calc' }), null);
  assert.strictEqual(O.buildLoginUrl({ port: 8790, token: 'AB'.repeat(32) }), null);
  assert.strictEqual(O.buildLoginUrl({ port: '8790', token: TOKEN }), null);
  assert.strictEqual(O.buildLoginUrl({ port: 70000, token: TOKEN }), null);
  assert.strictEqual(O.buildLoginUrl(null), null);
});

test('openInBrowser: cmd start with verbatim args, detached, hidden; spawn errors are handled', () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => { child.unrefed = true; };
  const errors = [];
  const url = O.buildLoginUrl({ port: 8790, token: TOKEN });
  O.openInBrowser(url, { spawn: (...a) => { calls.push(a); return child; }, onError: (e) => errors.push(e.message) });
  assert.strictEqual(calls.length, 1);
  const [cmd, args, opts] = calls[0];
  assert.strictEqual(cmd, 'cmd.exe');
  assert.deepStrictEqual(args, ['/d', '/s', '/c', `"start "" "${url}""`]);
  assert.strictEqual(opts.windowsVerbatimArguments, true);
  assert.strictEqual(opts.detached, true);
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(opts.stdio, 'ignore');
  assert.ok(child.unrefed);
  child.emit('error', new Error('ENOENT')); // без обработчика это бросило бы исключение
  assert.deepStrictEqual(errors, ['ENOENT']);
});

test('openInBrowser refuses anything that is not a login URL', () => {
  assert.throws(() => O.openInBrowser('https://127.0.0.1:8790/?ott=x" & calc & "', { spawn: () => assert.fail('spawned') }));
});
