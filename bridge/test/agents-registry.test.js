'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadAgents, normalizeOptions } = require('../agents');
const generic = require('../agents/generic');

const quiet = { log: () => {} };

test('generic agents from config; unavailable and invalid are skipped', () => {
  const logged = [];
  const reg = loadAgents({ agents: {
    echo: { type: 'generic', name: 'Echo', command: process.execPath, args: ['-v'], scroll: 'wheel' },
    plain: { command: process.execPath },
    missing: { type: 'generic', command: 'definitely-not-a-command-cb' },
    'Bad Id': { command: process.execPath },
    weird: { type: 'nosuchtype', command: process.execPath },
    nocmd: { type: 'generic' },
  } }, { log: (m) => logged.push(m) });
  assert.deepStrictEqual(reg.list().map((a) => a.id), ['echo', 'plain']);
  assert.strictEqual(reg.get('echo').scroll, 'wheel');
  assert.strictEqual(reg.get('plain').scroll, 'pageKeys');
  assert.strictEqual(reg.get('plain').name, 'plain');
  assert.strictEqual(reg.get('missing'), null);
  assert.strictEqual(reg.get(42), null);
  assert.strictEqual(reg.defaultId, 'echo');
  assert.strictEqual(logged.length, 4, logged.join('\n'));
});

test('defaultAgent from config when available, otherwise first', () => {
  const reg = loadAgents({ defaultAgent: 'b', agents: { a: { command: process.execPath }, b: { command: process.execPath } } }, quiet);
  assert.strictEqual(reg.defaultId, 'b');
  const reg2 = loadAgents({ defaultAgent: 'zzz', agents: { a: { command: process.execPath } } }, quiet);
  assert.strictEqual(reg2.defaultId, 'a');
  const empty = loadAgents({ agents: { x: { command: 'definitely-not-a-command-cb' } } }, quiet);
  assert.strictEqual(empty.defaultId, null);
  assert.deepStrictEqual(empty.list(), []);
});

test('list() exposes only public fields', () => {
  const reg = loadAgents({ agents: { echo: { command: process.execPath, name: 'Echo' } } }, quiet);
  assert.deepStrictEqual(reg.list(), [{ id: 'echo', name: 'Echo', options: [], scroll: 'pageKeys' }]);
});

test('generic: config args then owner raw args; no events, no replies', async () => {
  const a = generic.create('echo', { command: process.execPath, args: ['a', 5, 'b'] });
  assert.deepStrictEqual(await a.spawnSpec({ cwd: 'C:\\', title: 't', options: {}, rawArgs: ['--x'] }),
    { command: process.execPath, args: ['a', 'b', '--x'], env: {}, state: {} });
  assert.strictEqual(a.events, 'none');
  assert.deepStrictEqual(a.onHook({}, {}), []);
  assert.deepStrictEqual(a.onInput({}, 'x'), []);
  assert.deepStrictEqual(await a.reply({}, { requestId: 'r' }, 'once', { write() { throw new Error('no'); } }),
    { ok: false, events: [] });
  assert.strictEqual(a.isResumeLike({ options: {}, rawArgs: ['--resume'] }), false);
  assert.strictEqual(typeof a.subscribe({}, () => {}), 'function');
  assert.throws(() => generic.create('x', {}), /command/);
});

test('normalizeOptions keeps only declared bool options, strictly true', () => {
  const fake = { options: [{ id: 'resume', type: 'bool' }, { id: 'skip', type: 'bool' }] };
  assert.deepStrictEqual(normalizeOptions(fake, { resume: true, skip: 'yes', other: true }), { resume: true, skip: false });
  assert.deepStrictEqual(normalizeOptions(fake, null), { resume: false, skip: false });
  assert.deepStrictEqual(normalizeOptions(fake, ['resume']), { resume: false, skip: false });
});
