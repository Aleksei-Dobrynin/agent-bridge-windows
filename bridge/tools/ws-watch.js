#!/usr/bin/env node
'use strict';
// Отладка протокола D-4/D-5 от имени владельца: печатает notify/status/requestClosed/replyResult.
// Ввод: номер варианта — ответить на последний запрос; «new <agent> [опция,опция]» — новая
// сессия агента в текущем каталоге с опциями (например: new opencode askShell).
// Каталог данных — lib/datadir.js (CLAUDE_BRIDGE_HOME), порт — CLAUDE_BRIDGE_LISTEN_PORT или
// port из config.json (как у моста и claude-mobile).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { ensureDataDirs } = require('../lib/datadir');
const { pinnedTlsOptions } = require('../lib/cert');

const DATA = ensureDataDirs();
const envPort = process.env.CLAUDE_BRIDGE_LISTEN_PORT;
const port = envPort ? Number(envPort) : (JSON.parse(fs.readFileSync(DATA.config, 'utf8')).port || 8790);
const der = fs.readFileSync(path.join(DATA.certs, 'bridge.cer'));
const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
  ...pinnedTlsOptions(new crypto.X509Certificate(der).toString(), crypto.createHash('sha256').update(der).digest('hex')),
  headers: { Authorization: 'Bearer ' + fs.readFileSync(DATA.ownerToken, 'utf8').trim() },
});
let last = null;
const time = () => new Date().toLocaleTimeString('ru-RU');

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'notify') {
    console.log(`${time()} [notify ${m.event}] ${m.id} ${m.message}`);
    if (m.requestId) { last = m; m.choices.forEach((c, i) => console.log(`    ${i + 1}) ${c.label} (${c.id})`)); }
  } else if (['status', 'requestClosed', 'replyResult', 'created', 'createConflict', 'error'].includes(m.type)) {
    console.log(`${time()} [${m.type}] ${JSON.stringify(m)}`);
  } else if (m.type === 'sessions') {
    console.log(`${time()} [sessions] ${m.sessions.map((s) => `${s.id}:${s.agent}:${s.status}`).join(' ') || '—'}` +
      `  агенты: ${(m.agents || []).map((a) => a.id).join(', ')}`);
  }
});
ws.on('error', (e) => { console.error('Мост недоступен: ' + e.message); process.exit(1); });
ws.on('close', () => process.exit(0));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const l = line.trim();
  const nm = l.match(/^new\s+(\S+)(?:\s+(\S+))?$/);
  if (nm) {
    const options = {};
    for (const o of (nm[2] || '').split(',').filter(Boolean)) options[o] = true;
    ws.send(JSON.stringify({ type: 'create', agent: nm[1], options, cwd: process.cwd() }));
    return;
  }
  const n = parseInt(l, 10);
  if (!last || !(n >= 1 && n <= last.choices.length)) { console.log('нет активного запроса или неверный номер'); return; }
  ws.send(JSON.stringify({ type: 'reply', id: last.id, requestId: last.requestId, decision: last.choices[n - 1].id }));
});
