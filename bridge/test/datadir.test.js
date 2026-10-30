'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataDir, ensureDataDirs } = require('../lib/datadir');

const prevHome = process.env.CLAUDE_BRIDGE_HOME;
test.afterEach(() => {
  if (prevHome === undefined) delete process.env.CLAUDE_BRIDGE_HOME;
  else process.env.CLAUDE_BRIDGE_HOME = prevHome;
});

test('CLAUDE_BRIDGE_HOME overrides data dir', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-dd-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.CLAUDE_BRIDGE_HOME = tmp;
  assert.strictEqual(dataDir(), tmp);
  const d = ensureDataDirs();
  for (const sub of ['sessions', 'logs', 'certs']) assert.ok(fs.statSync(path.join(tmp, sub)).isDirectory());
  assert.strictEqual(d.pairings, path.join(tmp, 'pairings.json'));
  assert.strictEqual(d.ownerToken, path.join(tmp, 'owner.token'));
});

test('CLAUDE_BRIDGE_HOME is resolved to an absolute path', () => {
  process.env.CLAUDE_BRIDGE_HOME = 'relative-cb-home';
  assert.strictEqual(dataDir(), path.resolve('relative-cb-home'));
  assert.ok(path.isAbsolute(dataDir()));
});

test('default data dir is under LOCALAPPDATA', () => {
  delete process.env.CLAUDE_BRIDGE_HOME;
  assert.strictEqual(dataDir().toLowerCase(), path.join(process.env.LOCALAPPDATA, 'ClaudeBridge').toLowerCase());
});
