#!/usr/bin/env node
'use strict';
// Фрагмент настроек Claude Code с хуком моста в exec-форме (P-4, P-6; живая проба:
// строковая форма идёт через Git Bash) для событий, которые использует адаптер claude.
// Ручная проверка: claude-mobile --settings <файл> или проектный .claude\settings.json;
// установщик (подплан 4) сливает его с %USERPROFILE%\.claude\settings.json.
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hooks', 'bridge-hook.js');
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
const OTHER_EVENTS = ['Notification', 'UserPromptSubmit', 'Stop'];

function hookSettings(hookPath = HOOK) {
  const entry = { type: 'command', command: 'node', args: [hookPath] };
  const hooks = {};
  for (const e of TOOL_EVENTS) hooks[e] = [{ matcher: '*', hooks: [entry] }];
  for (const e of OTHER_EVENTS) hooks[e] = [{ hooks: [entry] }];
  return { hooks };
}

if (require.main === module) process.stdout.write(JSON.stringify(hookSettings(), null, 2) + '\n');

module.exports = { hookSettings, TOOL_EVENTS, OTHER_EVENTS };
