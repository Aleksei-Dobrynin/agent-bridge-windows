'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookSettings } = require('../tools/hook-settings');

test('exec-form hook for every event the claude adapter uses', () => {
  const s = hookSettings('C:\\b\\bridge-hook.js');
  assert.deepStrictEqual(Object.keys(s.hooks).sort(), ['Notification', 'PermissionDenied', 'PermissionRequest',
    'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.deepStrictEqual(s.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['C:\\b\\bridge-hook.js'] }] }]);
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'node', args: ['C:\\b\\bridge-hook.js'] }] }]);
});

test('CLI prints JSON with the absolute hook path', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'hook-settings.js')], { encoding: 'utf8' });
  const s = JSON.parse(r.stdout);
  assert.strictEqual(s.hooks.Stop[0].hooks[0].args[0], path.join(__dirname, '..', 'hooks', 'bridge-hook.js'));
});
