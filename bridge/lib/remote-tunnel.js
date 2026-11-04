'use strict';
// D-29: туннель на стороне ПК-клиента. Порт берём ТОЛЬКО из ready (tunnel/src/main.rs:593),
// туннель не сдаётся сам — переподключение внутри iroh, наш процесс живёт до выхода клиента.
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function defaultExe() {
  return process.env.CLAUDE_BRIDGE_TUNNEL || path.join(__dirname, '..', 'bin', 'claude-tunnel.exe');
}

/** Команда запуска: `.js` (тестовый фикстур) — через node, иначе — сам бинарь. */
function command(exePath) {
  return /\.(c|m)?js$/i.test(exePath)
    ? { cmd: process.execPath, pre: [exePath] }
    : { cmd: exePath, pre: [] };
}

/** Запустить `connect` и дождаться ready. */
function startTunnel({ ticket, secretFile, exePath = defaultExe(), timeoutMs = 30000,
  spawnFn = spawn, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (!ticket) { reject(new Error('нет ticket туннеля — включите интернет-доступ на рабочем ПК')); return; }
    if (typeof secretFile !== 'string' || !secretFile.trim()) {
      reject(new Error('не указан файл ключа туннеля')); return;
    }
    const { cmd, pre } = command(exePath);
    const child = spawnFn(cmd, [...pre, 'connect', `--ticket=${ticket}`,
      '--listen', '127.0.0.1:0', '--secret-file', secretFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    let acc = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => fail(new Error('туннель не поднялся за ' + Math.round(timeoutMs / 1000) + ' с')), timeoutMs);
    const stop = () => { try { child.kill(); } catch { /* уже вышел */ } };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      reject(e);
    };
    const handleLine = (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.event === 'ready' && Number.isInteger(m.port)) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ port: m.port, child, stop });
      } else if (m.event === 'error') {
        fail(new Error('туннель: ' + (m.message || 'ошибка')));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      acc += d;
      let i;
      while ((i = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, i);
        acc = acc.slice(i + 1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => fail(new Error('не удалось запустить туннель: ' + e.message)));
    // close, а не exit: к этому моменту stdout дочитан и последняя строка (ready/error) разобрана.
    child.on('close', (code) => {
      if (acc.trim()) { handleLine(acc); acc = ''; }
      fail(new Error('туннель завершился (код ' + code + ')' +
        (stderr.trim() ? ': ' + stderr.trim() : '')));
    });
  });
}

/** Постоянный NodeId этого ПК (`id --secret-file`), ключ создаётся при первом вызове. */
function readNodeId({ exePath = defaultExe(), secretFile, env = process.env } = {}) {
  const { cmd, pre } = command(exePath);
  const r = spawnSync(cmd, [...pre, 'id', '--secret-file', secretFile],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, env });
  if (r.error) throw new Error('не удалось запустить туннель: ' + r.error.message);
  if (r.status !== 0) throw new Error('туннель id завершился с кодом ' + r.status);
  for (const line of String(r.stdout).split(/\r?\n/)) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.event === 'id' && typeof m.node_id === 'string' && /^[0-9a-f]{64}$/.test(m.node_id)) return m.node_id;
  }
  throw new Error('туннель не вернул node_id');
}

module.exports = { startTunnel, readNodeId, defaultExe };
