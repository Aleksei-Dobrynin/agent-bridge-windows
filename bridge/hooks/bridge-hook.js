#!/usr/bin/env node
'use strict';
// Хук Claude Code -> мост (P-4, P-6). Вне bridge-сессии молча выходит. Никогда не мешает
// работе Claude: любые ошибки проглатываются, код выхода всегда 0, stdout пуст.
// Регистрация (P-6) — exec-форма:
//   {"type":"command","command":"node","args":["<путь>\\bridge-hook.js"]}
// Переменные окружения задаёт мост при запуске сессии (они доходят из PTY до хука):
//   CLAUDE_BRIDGE_SESSION, CLAUDE_BRIDGE_HOOK_TOKEN, CLAUDE_BRIDGE_PORT, CLAUDE_BRIDGE_CERT_FP.
// Любая непредвиденная ошибка — тихий выход с кодом 0 (Claude не должен видеть сбой хука).
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));
const https = require('https');

const sid = process.env.CLAUDE_BRIDGE_SESSION;
const token = process.env.CLAUDE_BRIDGE_HOOK_TOKEN;
const port = parseInt(process.env.CLAUDE_BRIDGE_PORT || '8790', 10);
const fp = (process.env.CLAUDE_BRIDGE_CERT_FP || '').replace(/:/g, '').toLowerCase();
if (!sid || !token || !/^[0-9a-f]{64}$/.test(fp) || !(port > 0 && port < 65536)) process.exit(0);

// Страховка: хук не должен держать Claude, что бы ни случилось (мост завис, stdin не закрыт).
setTimeout(() => process.exit(0), 5000).unref();

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', (d) => { body += d; if (body.length > 1e6) process.exit(0); });
process.stdin.on('end', () => {
  const req = https.request({
    host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 2000,
    // Новое соединение (без keep-alive пула): отпечаток проверяется на КАЖДОМ сокете.
    agent: false,
    rejectUnauthorized: false, // самоподписанный: доверие — только по отпечатку ниже
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Bridge-Session': sid,
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('socket', (sock) => {
    sock.on('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const got = String((cert && cert.fingerprint256) || '').replace(/:/g, '').toLowerCase();
      // тело (и токен в заголовках) уходит только после проверки отпечатка
      if (got !== fp) { req.destroy(); process.exit(0); }
      req.end(body);
    });
  });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
});
