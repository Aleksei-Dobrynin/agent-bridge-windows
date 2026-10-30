'use strict';
// Task 15: start-bridge.js сразу возвращает управление, мост живёт отсоединённым процессом.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers/bridge');

const START = path.join(__dirname, '..', 'start-bridge.js');

function listenerPid(port) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ` +
    'Select-Object -First 1 -ExpandProperty OwningProcess'], { encoding: 'utf8', windowsHide: true });
  const pid = String(r.stdout || '').trim();
  return /^\d+$/.test(pid) ? pid : null;
}

test('start-bridge.js returns at once and the detached bridge serves', { timeout: 120000 }, async (t) => {
  const home = H.tempHome('cb-start-');
  const port = H.pickPort(29790);
  let pid = null;
  t.after(() => H.cleanup(home, pid ? [{ pid }] : []));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [START], {
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_LISTEN_PORT: String(port), CLAUDE_BRIDGE_TEST: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 10000, 'launcher returned quickly');
  const { owner, pin } = await H.ownerAndPin(home);
  assert.ok(await H.waitFor(async () => {
    const res = await H.request(port, pin, { path: '/health', headers: { Authorization: 'Bearer ' + owner } });
    return res && res.statusCode === 200;
  }), 'detached bridge answers /health');
  pid = listenerPid(port);
  assert.ok(pid, 'bridge pid found');

  // повторный запуск при работающем мосте — no-op: второй экземпляр выходит по
  // EADDRINUSE, не успев ничего запустить (маяк, туннель, хранители)
  const dup = H.startBridge(home, port);
  assert.strictEqual(await dup.exited, 1);
  assert.match(dup.stderr, /EADDRINUSE/);
  assert.doesNotMatch(dup.stderr, /UDP beacon/, 'duplicate did not get to the startup side effects');
  assert.strictEqual(listenerPid(port), pid, 'first bridge still owns the port');
});
