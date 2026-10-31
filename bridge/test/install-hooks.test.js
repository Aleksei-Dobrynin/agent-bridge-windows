'use strict';
// Задача 2 подплана 4 (P-6): хук моста в пользовательском settings.json Claude Code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookSettings } = require('../tools/hook-settings');
const IH = require('../tools/install-hooks');

const CLI = path.join(__dirname, '..', 'tools', 'install-hooks.js');
const HOOK = 'C:\\repo\\bridge\\hooks\\bridge-hook.js';
const USER_STOP = { hooks: [{ type: 'command', command: 'echo user-hook' }] };
const clone = (o) => JSON.parse(JSON.stringify(o));

test('merge into empty settings adds the exec-form hook for every event', () => {
  const r = IH.mergeBridgeHooks({}, HOOK);
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(r.settings, hookSettings(HOOK));
  assert.strictEqual(IH.isInstalled(r.settings, HOOK), true);
});

test('merge keeps user keys and user hooks first; second merge changes nothing', () => {
  const user = { model: 'opus', hooks: { Stop: [clone(USER_STOP)] } };
  const r = IH.mergeBridgeHooks(clone(user), HOOK);
  assert.strictEqual(r.settings.model, 'opus');
  assert.deepStrictEqual(r.settings.hooks.Stop, [USER_STOP, ...hookSettings(HOOK).hooks.Stop]);
  const again = IH.mergeBridgeHooks(clone(r.settings), HOOK);
  assert.strictEqual(again.changed, false);
  assert.deepStrictEqual(again.settings, r.settings);
});

test('merge replaces bridge entries with an old path (repository moved)', () => {
  const old = hookSettings('D:\\old\\bridge\\hooks\\bridge-hook.js');
  old.hooks.Stop.unshift(clone(USER_STOP));
  const r = IH.mergeBridgeHooks(old, HOOK);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.replaced, 8);
  assert.strictEqual(JSON.stringify(r.settings).includes('old'), false);
  assert.deepStrictEqual(r.settings.hooks.Stop[0], USER_STOP);
  assert.strictEqual(IH.isInstalled(r.settings, HOOK), true);
});

test('path comparison ignores case and slash style', () => {
  const s = hookSettings('c:/REPO/bridge/hooks/bridge-hook.js');
  assert.strictEqual(IH.isInstalled(s, HOOK), true);
});

test('remove takes out only bridge entries; mixed group keeps the user hook', () => {
  const s = IH.mergeBridgeHooks({ model: 'x', hooks: { Stop: [clone(USER_STOP)] } }, HOOK).settings;
  s.hooks.Notification[0].hooks.unshift({ type: 'command', command: 'echo n' });
  const r = IH.removeBridgeHooks(s);
  assert.strictEqual(r.removed, 8);
  assert.deepStrictEqual(r.settings, {
    model: 'x',
    hooks: { Stop: [USER_STOP], Notification: [{ hooks: [{ type: 'command', command: 'echo n' }] }] },
  });
});

test('remove of the only hooks deletes the hooks key; untouched empty events stay', () => {
  assert.deepStrictEqual(IH.removeBridgeHooks(hookSettings(HOOK)).settings, {});
  const s = hookSettings(HOOK);
  s.hooks.SessionStart = [];
  assert.deepStrictEqual(IH.removeBridgeHooks(s).settings, { hooks: { SessionStart: [] } });
});

test('malformed settings are refused', () => {
  for (const bad of [[], 'x', { hooks: [] }, { hooks: { Stop: {} } }]) {
    assert.throws(() => IH.mergeBridgeHooks(bad, HOOK), Error, JSON.stringify(bad));
    assert.throws(() => IH.removeBridgeHooks(bad), Error, JSON.stringify(bad));
  }
});

// ---- CLI на временных файлах

function tmpSettings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ih-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'claude', 'settings.json') };
}
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: r.stdout + r.stderr };
}
const backups = (dir) => fs.readdirSync(path.join(dir, 'claude')).filter((f) => f.startsWith('settings.json.bak-'));

test('CLI install creates a missing file without a backup; status reflects it', (t) => {
  const { dir, file } = tmpSettings(t);
  assert.strictEqual(cli('status', '--settings', file).status, 2);
  const r = cli('install', '--settings', file);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /Хук моста добавлен/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), hookSettings(IH.HOOK));
  assert.deepStrictEqual(backups(dir), []);
  assert.strictEqual(cli('status', '--settings', file).status, 0);
});

test('CLI install backs up an existing file once; repeat is a no-op', (t) => {
  const { dir, file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  const original = '\uFEFF' + JSON.stringify({ model: 'opus', hooks: { Stop: [USER_STOP] } });
  fs.writeFileSync(file, original);
  assert.strictEqual(cli('install', '--settings', file).status, 0);
  const b = backups(dir);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'claude', b[0]), 'utf8'), original, 'backup is byte-identical');
  const after = fs.readFileSync(file, 'utf8');
  const r = cli('install', '--settings', file);
  assert.match(r.out, /уже установлен/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), after);
  assert.strictEqual(backups(dir).length, 1);
});

test('CLI --dry-run writes nothing', (t) => {
  const { dir, file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{}');
  const r = cli('install', '--settings', file, '--dry-run');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /\[dry-run\] Хук моста будет добавлен/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}');
  assert.deepStrictEqual(backups(dir), []);
});

test('CLI uninstall restores the user content', (t) => {
  const { file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  const user = { model: 'opus', hooks: { Stop: [USER_STOP] } };
  fs.writeFileSync(file, JSON.stringify(user));
  assert.strictEqual(cli('install', '--settings', file).status, 0);
  const r = cli('uninstall', '--settings', file);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /Хук моста удалён/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), user);
  assert.match(cli('uninstall', '--settings', file).out, /Хука моста нет/);
});

test('CLI refuses broken JSON and leaves the file as is', (t) => {
  const { dir, file } = tmpSettings(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{ "hooks": ');
  const r = cli('install', '--settings', file);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /файл не изменён/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ "hooks": ');
  assert.deepStrictEqual(backups(dir), []);
});
