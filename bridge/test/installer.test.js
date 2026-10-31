'use strict';
// Задачи 4–5 подплана 4: install.ps1 / uninstall.ps1 только на временных каталогах
// (-DataRoot, -SettingsPath, -SkipTask -SkipPath, -SkipNpm, -NoStart; ярлык автозагрузки —
// только в -StartupDir во временном каталоге): реальные настройки пользователя, PATH,
// Планировщик, shell:startup, брандмауэр и процессы моста не трогаются.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { hookSettings } = require('../tools/hook-settings');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'bridge', 'hooks', 'bridge-hook.js');
const USER = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } };

function ps(script, args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, script), ...args], { encoding: 'utf8', windowsHide: true, timeout: 240000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** Цель и аргументы ярлыка .lnk (WScript.Shell). */
function readShortcut(file) {
  const cmd = `$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}'); ` +
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json @{ t = $l.TargetPath; a = $l.Arguments; w = $l.WorkingDirectory; s = $l.WindowStyle }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(r.stdout);
}

function sandbox(t, withUserSettings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-inst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = { dir, data: path.join(dir, 'data'), settings: path.join(dir, 'claude', 'settings.json'), startup: path.join(dir, 'Startup') };
  if (withUserSettings) {
    fs.mkdirSync(path.dirname(s.settings), { recursive: true });
    fs.writeFileSync(s.settings, JSON.stringify(USER));
  }
  s.safe = ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipTask', '-SkipPath'];
  // автозапуск ярлыком во временном каталоге вместо задачи Планировщика (D-25 п. 4)
  s.shortcut = ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipPath', '-StartupShortcut', '-StartupDir', s.startup];
  return s;
}
const backups = (s) => fs.readdirSync(path.dirname(s.settings)).filter((f) => f.startsWith('settings.json.bak-'));

test('install.ps1 into temp paths: data dir, config, shim, hook; repeat changes nothing', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  const r = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.strictEqual(r.status, 0, r.out);
  for (const sub of ['sessions', 'logs', 'certs', 'bin']) assert.ok(fs.statSync(path.join(s.data, sub)).isDirectory(), sub);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.data, 'config.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge', 'config.example.json'), 'utf8')));
  assert.strictEqual(fs.readFileSync(path.join(s.data, 'bin', 'claude-mobile.cmd'), 'latin1'),
    `@echo off\r\nnode "${path.join(ROOT, 'bridge', 'attach.js')}" %*\r\n`);
  const st = JSON.parse(fs.readFileSync(s.settings, 'utf8'));
  assert.strictEqual(st.model, 'opus');
  assert.deepStrictEqual(st.hooks.Stop[0], USER.hooks.Stop[0]);
  for (const [ev, groups] of Object.entries(hookSettings(HOOK).hooks)) assert.deepStrictEqual(st.hooks[ev].slice(-1), groups, ev);
  assert.strictEqual(backups(s).length, 1);

  const before = fs.readFileSync(s.settings, 'utf8');
  const r2 = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.strictEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /Конфиг уже есть/);
  assert.match(r2.out, /уже установлен/);
  assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), before);
  assert.strictEqual(backups(s).length, 1);
});

test('install.ps1 -DryRun (with npm and firewall steps) changes nothing', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  const r = ps('install.ps1', [...s.safe, '-DryRun', '-Firewall', '-NoStart']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /\[dry-run\] npm ci/);
  assert.match(r.out, /\[dry-run\] Хук моста будет добавлен/);
  assert.match(r.out, /\[dry-run\] netsh advfirewall firewall add rule name=ClaudeBridge-TCP .*localport=8790 remoteip=localsubnet profile=private/);
  assert.match(r.out, /\[dry-run\] netsh advfirewall firewall add rule name=ClaudeBridge-UDP .*localport=8791 remoteip=localsubnet profile=private/);
  assert.ok(!fs.existsSync(s.data), 'no data dir');
  assert.ok(!fs.existsSync(s.settings), 'no settings');
});

test('install.ps1 refuses a custom -DataRoot without -SkipTask -SkipPath', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  const r = ps('install.ps1', ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipNpm', '-NoStart']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /только для проверки/);
  // ярлык в настоящую папку автозагрузки (без -StartupDir) — тоже отказ
  const r2 = ps('install.ps1', ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipPath', '-StartupShortcut', '-SkipNpm', '-NoStart']);
  assert.notStrictEqual(r2.status, 0);
  assert.match(r2.out, /только для проверки/);
  // ревью I-3 (D-26 п. 4): без -SkipNpm, с -Firewall, с настоящим settings.json — тоже отказ
  for (const [args, missing] of [
    [[...s.safe, '-NoStart'], '-SkipNpm'],
    [[...s.safe, '-SkipNpm', '-NoStart', '-Firewall'], '-Firewall'],
    [['-DataRoot', s.data, '-SkipTask', '-SkipPath', '-SkipNpm', '-NoStart'], '-SettingsPath'],
  ]) {
    const r3 = ps('install.ps1', args);
    assert.notStrictEqual(r3.status, 0, r3.out);
    assert.match(r3.out, new RegExp('Не выполнено: ' + missing), r3.out);
  }
  assert.ok(!fs.existsSync(s.data));
  assert.ok(!fs.existsSync(s.settings));
});

test('install.ps1 stops on a broken settings.json and leaves it as is', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  fs.mkdirSync(path.dirname(s.settings), { recursive: true });
  fs.writeFileSync(s.settings, '{ "hooks": ');
  const r = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /файл не изменён/);
  assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), '{ "hooks": ');
  assert.deepStrictEqual(backups(s), []);
});

test('install.ps1 -StartupShortcut creates the autostart shortcut in -StartupDir (D-25 item 4)', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  fs.mkdirSync(s.startup);
  const dry = ps('install.ps1', [...s.shortcut, '-SkipNpm', '-NoStart', '-DryRun']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] Ярлык автозагрузки/);
  assert.deepStrictEqual(fs.readdirSync(s.startup), [], 'dry run created nothing');

  const r = ps('install.ps1', [...s.shortcut, '-SkipNpm', '-NoStart']);
  assert.strictEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Задача Планировщика/);
  const lnk = readShortcut(path.join(s.startup, 'ClaudeBridge.lnk'));
  assert.match(lnk.t, /node\.exe$/i);
  assert.strictEqual(lnk.a, `"${path.join(ROOT, 'bridge', 'start-bridge.js')}"`);
  assert.strictEqual(lnk.w.toLowerCase(), path.join(ROOT, 'bridge').toLowerCase());
  assert.strictEqual(lnk.s, 7);
});

test('uninstall.ps1 reverses install on temp paths; -RemoveData removes the data dir', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  const inst = ps('install.ps1', [...s.safe, '-SkipNpm', '-NoStart']);
  assert.strictEqual(inst.status, 0, inst.out);
  const shim = path.join(s.data, 'bin', 'claude-mobile.cmd');

  const dry = ps('uninstall.ps1', [...s.safe, '-DryRun', '-RemoveData', '-Firewall']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] Хук моста будет удалён/);
  assert.match(dry.out, /\[dry-run\] netsh advfirewall firewall delete rule name=ClaudeBridge-TCP/);
  assert.ok(fs.existsSync(shim), 'dry run kept the shim');
  assert.ok(fs.existsSync(path.join(s.data, 'config.json')), 'dry run kept the data');

  const r = ps('uninstall.ps1', s.safe);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), USER);
  assert.ok(!fs.existsSync(shim), 'shim removed');
  assert.ok(fs.existsSync(path.join(s.data, 'config.json')), 'data kept without -RemoveData');

  const r2 = ps('uninstall.ps1', [...s.safe, '-RemoveData']);
  assert.strictEqual(r2.status, 0, r2.out);
  assert.match(r2.out, /Хука моста нет/);
  assert.ok(!fs.existsSync(s.data), 'data dir removed');
});

test('uninstall.ps1 refuses a custom -DataRoot without -SkipTask -SkipPath', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  const r = ps('uninstall.ps1', ['-DataRoot', s.data, '-SettingsPath', s.settings]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.out, /только для проверки/);
  const r2 = ps('uninstall.ps1', ['-DataRoot', s.data, '-SettingsPath', s.settings, '-SkipPath', '-StartupShortcut']);
  assert.notStrictEqual(r2.status, 0);
  assert.match(r2.out, /только для проверки/);
  for (const [args, missing] of [
    [[...s.safe, '-Firewall'], '-Firewall'],
    [['-DataRoot', s.data, '-SkipTask', '-SkipPath'], '-SettingsPath'],
  ]) {
    const r3 = ps('uninstall.ps1', args);
    assert.notStrictEqual(r3.status, 0, r3.out);
    assert.match(r3.out, new RegExp('Не выполнено: ' + missing), r3.out);
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')), USER);
});

test('uninstall.ps1 -StartupShortcut removes the autostart shortcut from -StartupDir (D-25 item 4)', { timeout: 600000 }, (t) => {
  const s = sandbox(t, false);
  fs.mkdirSync(s.startup);
  const inst = ps('install.ps1', [...s.shortcut, '-SkipNpm', '-NoStart']);
  assert.strictEqual(inst.status, 0, inst.out);
  const lnk = path.join(s.startup, 'ClaudeBridge.lnk');
  assert.ok(fs.existsSync(lnk), 'shortcut installed');

  const dry = ps('uninstall.ps1', [...s.shortcut, '-DryRun']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.match(dry.out, /\[dry-run\] Удаляю ярлык автозагрузки/);
  assert.ok(fs.existsSync(lnk), 'dry run kept the shortcut');

  const r = ps('uninstall.ps1', s.shortcut);
  assert.strictEqual(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Планировщик/, 'scheduled task untouched');
  assert.ok(!fs.existsSync(lnk), 'shortcut removed');
});

test('uninstall.ps1 -RemoveData refuses a directory that is not a bridge data dir (review I-4)', { timeout: 600000 }, (t) => {
  const s = sandbox(t, true);
  fs.mkdirSync(s.data);
  fs.writeFileSync(path.join(s.data, 'precious.txt'), 'keep me');
  fs.writeFileSync(path.join(s.data, 'config.json'), '{}'); // config.json без certs и sessions — не каталог моста
  const before = fs.readFileSync(s.settings, 'utf8');
  const r = ps('uninstall.ps1', [...s.safe, '-RemoveData']);
  assert.notStrictEqual(r.status, 0, r.out);
  assert.match(r.out, /не похож на каталог данных моста/);
  assert.strictEqual(fs.readFileSync(path.join(s.data, 'precious.txt'), 'utf8'), 'keep me');
  assert.strictEqual(fs.readFileSync(s.settings, 'utf8'), before, 'nothing else was changed');
});
