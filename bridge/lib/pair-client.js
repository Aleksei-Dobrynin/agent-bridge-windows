'use strict';
// D-29: сопряжение ПК-клиента (домашний ноутбук). Отпечаток сертификата берётся из QR
// (человек переносит файл), поэтому TOFU нет: сертификат сверяется ДО отправки кода.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { pinnedTlsOptions } = require('./cert');

const CODE_RE = /^[0-9a-f]{10}$/i;
const FP_RE = /^[0-9a-f]{64}$/;
const HOST_RE = /^[A-Za-z0-9.:_-]{1,253}$/;
const TOKEN_RE = /^[0-9a-f]{48}$/;

/** Разобрать тикет из QR; любое отклонение — исключение (fail-closed). */
function parseTicket(text) {
  let t;
  try { t = JSON.parse(text); } catch { throw new Error('QR не содержит JSON сопряжения'); }
  if (!t || typeof t !== 'object' || t.cb !== 1) throw new Error('QR не от Claude Bridge');
  if (typeof t.host !== 'string' || !HOST_RE.test(t.host)) throw new Error('неверный адрес в QR');
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65533) throw new Error('неверный порт в QR');
  if (typeof t.code !== 'string' || !CODE_RE.test(t.code)) throw new Error('неверный код в QR');
  if (typeof t.fp !== 'string' || !FP_RE.test(t.fp)) throw new Error('неверный отпечаток в QR');
  return { host: t.host, port: t.port, code: t.code, fp: t.fp.toLowerCase() };
}

/** Сертификат моста с его порта. Проверка цепочки отключена — её заменяет сверка fp из QR. */
function fetchPeerCert(host, port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: '/', method: 'GET', agent: false,
      rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const c = res.socket.getPeerCertificate();
      res.resume();
      if (!c || !c.raw) { reject(new Error('мост не прислал сертификат')); return; }
      resolve(Buffer.from(c.raw));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут TLS (' + host + ':' + port + ')')));
    req.on('error', reject);
    req.end();
  });
}

function postPair(host, port, pin, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, port, path: '/pair', method: 'POST', agent: false, ...pin,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('timeout', () => req.destroy(new Error('таймаут /pair')));
    req.on('error', reject);
    req.end(data);
  });
}

function remotePaths(root) {
  const dir = path.join(root, 'remote');
  return {
    dir,
    profile: path.join(dir, 'profile.json'),
    cert: path.join(dir, 'bridge.cer'),
    token: path.join(dir, 'device.token'),
    secret: path.join(dir, 'iroh.key'),
  };
}

function saveProfile(root, { der, host, port, fingerprint, ticket, name, token }) {
  const p = remotePaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.cert, der);
  // токен — до профиля: валидный профиль без токена бесполезен и вводит в заблуждение
  fs.writeFileSync(p.token, token, { mode: 0o600 });
  fs.writeFileSync(p.profile, JSON.stringify({
    host, port, fingerprint, ticket: ticket || null, name, pairedAt: new Date().toISOString(),
  }, null, 2));
  return p;
}

/** Полный цикл сопряжения. Возвращает {token, fingerprint, host, port, ticket, paths}. */
async function pairDevice({ ticket, name, root, timeoutMs }) {
  const t = parseTicket(typeof ticket === 'string' ? ticket : JSON.stringify(ticket));
  const der = await fetchPeerCert(t.host, t.port, timeoutMs);
  const fp = crypto.createHash('sha256').update(der).digest('hex');
  if (fp !== t.fp) throw new Error('отпечаток сертификата не совпал с QR — сопряжение отменено');
  const pin = pinnedTlsOptions(new crypto.X509Certificate(der).toString(), fp);
  const res = await postPair(t.host, t.port, pin, { code: t.code, name }, timeoutMs);
  if (res.status !== 200) {
    let why = '';
    try { why = JSON.parse(res.body || '{}').error || ''; } catch { /* не JSON */ }
    throw new Error('мост отказал в сопряжении: ' + (why || 'HTTP ' + res.status));
  }
  let r;
  try { r = JSON.parse(res.body); } catch { throw new Error('мост вернул некорректный ответ'); }
  if (!r || typeof r.token !== 'string' || !TOKEN_RE.test(r.token)) {
    throw new Error('мост вернул некорректный токен устройства');
  }
  const paths = saveProfile(root, {
    der, host: t.host, port: t.port, fingerprint: fp, ticket: r.nodeTicket, name, token: r.token,
  });
  return { token: r.token, fingerprint: fp, host: t.host, port: t.port, ticket: r.nodeTicket || null, paths };
}

/** Профиль с диска или null (нет/повреждён). */
function loadProfile(root) {
  const p = remotePaths(root);
  let prof;
  try { prof = JSON.parse(fs.readFileSync(p.profile, 'utf8')); } catch { return null; }
  if (!prof || typeof prof !== 'object' || typeof prof.fingerprint !== 'string' || !FP_RE.test(prof.fingerprint)) return null;
  return { ...prof, paths: p };
}

/** Сообщить мосту NodeId этого ПК (LAN, токен устройства). Ждёт nodeRegistered. */
function registerNode({ host, port, pin, token, nodeId, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:${port}/ws`, {
      ...pin, headers: { Authorization: 'Bearer ' + token },
    });
    let settled = false;
    let timer = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch { /* закрыт */ }
      fn(v);
    };
    timer = setTimeout(() => done(reject, new Error('мост не подтвердил регистрацию p2p-узла')), timeoutMs);
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.type === 'error') {
        done(reject, new Error(typeof m.message === 'string' && m.message ? m.message : 'мост вернул ошибку'));
      } else if (m.type === 'nodeRegistered') {
        if (m.ok === true) done(resolve, m.nodeId);
        else done(reject, new Error('мост не принял NodeId устройства'));
      }
    });
    ws.on('error', (e) => done(reject, e));
    ws.on('close', () => done(reject, new Error('мост закрыл соединение до подтверждения регистрации p2p-узла')));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'registerNode', nodeId })));
  });
}

module.exports = { parseTicket, pairDevice, loadProfile, registerNode, remotePaths };
