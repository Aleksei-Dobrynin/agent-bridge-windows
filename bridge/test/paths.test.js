'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../lib/paths');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-paths-')));
const proj = path.join(tmp, 'Work', 'RepoA');
fs.mkdirSync(proj, { recursive: true });
const outside = path.join(tmp, 'Secret');
fs.mkdirSync(outside, { recursive: true });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('expandConfigPath: ~, %VAR%, forward slashes', () => {
  assert.strictEqual(P.expandConfigPath('~'), path.win32.normalize(os.homedir()));
  assert.strictEqual(P.expandConfigPath('~/x'), path.win32.join(os.homedir(), 'x'));
  process.env.CB_TEST_DIR = 'C:\\data';
  assert.strictEqual(P.expandConfigPath('%CB_TEST_DIR%/proj'), 'C:\\data\\proj');
  delete process.env.CB_TEST_DIR;
  assert.strictEqual(P.expandConfigPath('%NO_SUCH_VAR_CB%\\a'), null, 'unresolved variable is not absolute');
  assert.strictEqual(P.expandConfigPath(''), null);
  assert.strictEqual(P.expandConfigPath(42), null);
});

test('isAcceptableRemoteForm rejects UNC, device, drive-relative, control chars', () => {
  assert.ok(P.isAcceptableRemoteForm('C:\\work'));
  assert.ok(P.isAcceptableRemoteForm('c:/work/repo'));
  for (const bad of ['\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '//server/share',
    'C:foo', 'work\\repo', '', 'C:\\a\u0000b', 42, null]) {
    assert.strictEqual(P.isAcceptableRemoteForm(bad), false, String(bad));
  }
});

test('canonical fixes case and returns null for missing', () => {
  const c = P.canonical(proj.toUpperCase());
  assert.strictEqual(c, proj);
  assert.strictEqual(P.canonical(path.join(tmp, 'nope')), null);
});

test('isInside: case-insensitive, drive root, different drive, sibling prefix', () => {
  assert.ok(P.isInside('C:\\Work', 'c:\\work\\repo'));
  assert.ok(P.isInside('C:\\Work', 'C:\\Work'));
  assert.ok(P.isInside('C:\\', 'C:\\anything\\x'));
  assert.strictEqual(P.isInside('C:\\Work', 'D:\\Work\\repo'), false);
  assert.strictEqual(P.isInside('C:\\Work', 'C:\\Work-secret'), false);
  assert.strictEqual(P.isInside('C:\\Work', 'C:\\Work\\..\\Secret'), false);
});

test('samePath ignores case, separators and trailing slash', () => {
  assert.ok(P.samePath('C:\\Work\\Repo\\', 'c:/work/repo'));
  assert.strictEqual(P.samePath('C:\\Work\\Repo', 'C:\\Work\\Repo2'), false);
  assert.strictEqual(P.samePath(null, 'C:\\x'), false);
});

test('resolveRemoteCwd: inside root -> canonical, otherwise fallback', () => {
  const roots = [path.join(tmp, 'work')];
  assert.strictEqual(P.resolveRemoteCwd(proj.toLowerCase(), roots, 'FALLBACK'), proj);
  assert.strictEqual(P.resolveRemoteCwd(outside, roots, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveRemoteCwd('\\\\localhost\\c$\\x', roots, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveRemoteCwd(path.join(tmp, 'work', 'missing'), roots, 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveRemoteCwd('', roots, 'FALLBACK'), 'FALLBACK');
});

test('resolveRemoteCwd: junction inside root pointing outside is rejected', () => {
  const link = path.join(tmp, 'Work', 'escape');
  fs.symlinkSync(outside, link, 'junction');
  assert.strictEqual(P.resolveRemoteCwd(link, [path.join(tmp, 'Work')], 'FALLBACK'), 'FALLBACK');
});

test('expandConfigPath: relative and drive-relative roots are rejected', () => {
  for (const bad of ['projects', 'C:', 'C:foo', '.\\x', '\\\\server\\share']) {
    assert.strictEqual(P.expandConfigPath(bad), null, bad);
  }
});

test('a FILE is not a valid cwd (remote and local)', () => {
  const file = path.join(proj, 'file.txt');
  fs.writeFileSync(file, 'x');
  assert.strictEqual(P.resolveRemoteCwd(file, [path.join(tmp, 'Work')], 'FALLBACK'), 'FALLBACK');
  assert.strictEqual(P.resolveLocalCwd(file, 'fallback'), 'fallback');
  assert.strictEqual(P.resolveLocalCwd(proj, 'fallback'), proj);
});

test('resolveRemoteCwd: ADS, trailing dot/space, device names -> fallback', () => {
  const roots = [path.join(tmp, 'Work')];
  const cases = [
    path.join(tmp, 'Work') + '\\..\\Secret::$INDEX_ALLOCATION',
    proj + '.',
    proj + ' ',
    'CON', 'C:\\CON', path.join(tmp, 'Work', 'NUL'), path.join(tmp, 'Work', 'com1.txt'),
  ];
  for (const c of cases) assert.strictEqual(P.resolveRemoteCwd(c, roots, 'FALLBACK'), 'FALLBACK', c);
});

test('resolveRemoteCwd: multiple roots, one does not exist', () => {
  const roots = [path.join(tmp, 'no-such-root'), path.join(tmp, 'Work')];
  assert.strictEqual(P.resolveRemoteCwd(proj, roots, 'FALLBACK'), proj);
});

test('resolveRemoteCwd: 8.3 short name of a long dir inside root', (t) => {
  const longDir = path.join(tmp, 'Work', 'A Very Long Directory Name');
  fs.mkdirSync(longDir, { recursive: true });
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${longDir}") do @echo %~sI"`],
    { encoding: 'utf8', windowsVerbatimArguments: true });
  const short = (r.stdout || '').trim();
  if (!short || short.toLowerCase() === longDir.toLowerCase() || !fs.existsSync(short)) {
    return t.skip('8.3 names disabled on this volume');
  }
  assert.strictEqual(P.resolveRemoteCwd(short, [path.join(tmp, 'Work')], 'FALLBACK'), longDir);
});
