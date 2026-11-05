'use strict';
// D-30: политика подключения ПК-клиента как у телефона (BridgeService) — LAN приоритетен,
// туннель запасной путь, ticket обновляется по LAN и сохраняется в профиль, отзыв не ретраится.
// Модуль не рисует UI: TUI и переподключение — в bridge/remote.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const BEACON_QUERY = 'CLAUDE_BRIDGE?';
const LAN_TIMEOUT_MS = 1500;
const BEACON_TIMEOUT_MS = 1200;
const BEACON_COOLDOWN_MS = 60000;

/** Цели broadcast-запроса маяка: глобальный адрес + направленные на каждый IPv4-интерфейс. */
function broadcastTargets(ifaces = os.networkInterfaces) {
  const out = ['255.255.255.255'];
  for (const list of Object.values(ifaces() || {})) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const ip = String(a.address || '').split('.').map(Number);
      const mask = String(a.netmask || '').split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some(Number.isNaN) || mask.some(Number.isNaN)) continue;
      out.push(ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...new Set(out)];
}

/** Найти мост по UDP-маяку (P-7: в ответе нет имени ПК — сверяем отпечаток). */
function discoverBridge({ fingerprint, port, timeoutMs = BEACON_TIMEOUT_MS, targets }) {
  return new Promise((resolve) => {
    const want = String(fingerprint).toLowerCase();
    const sock = dgram.createSocket({ type: 'udp4' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* закрыт */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', (msg, rinfo) => {
      let m;
      try { m = JSON.parse(msg.toString('utf8')); } catch { return; }
      if (!m || m.claudeBridge !== true) return;
      if (String(m.fp || '').toLowerCase() !== want) return;
      if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65533) return;
      finish({ host: rinfo.address, port: m.port });
    });
    sock.on('error', () => finish(null));
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* не критично */ }
      for (const t of targets || broadcastTargets()) {
        try { sock.send(BEACON_QUERY, port + 1, t); } catch { /* адрес недоступен */ }
      }
    });
  });
}

/** Проверить LAN-путь и заодно забрать свежий ticket (мост отвечает на `internet`). */
function probeLan({ host, port, pin, token, timeoutMs = LAN_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch { /* уже закрыт */ }
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'таймаут' }), timeoutMs);
    try {
      ws = new WebSocket(`wss://${host}:${port}/ws`, {
        ...pin, headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: timeoutMs,
      });
    } catch (e) { done({ ok: false, reason: e.message }); return; }
    ws.on('open', () => { try { ws.send(JSON.stringify({ type: 'internet' })); } catch { /* закроется */ } });
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      done({ ok: false, revoked: res.statusCode === 401, reason: 'HTTP ' + res.statusCode });
    });
    ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (m && m.type === 'internet') {
        done({ ok: true, ticket: typeof m.ticket === 'string' && m.ticket ? m.ticket : null });
      }
    });
    ws.on('error', (e) => done({ ok: false, reason: e.message }));
    ws.on('close', () => done({ ok: false, reason: 'закрыто' }));
  });
}

/** Точечно обновить profile.json (атомарно: tmp + rename). */
function updateProfile(file, patch) {
  let prof;
  try { prof = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const next = { ...prof, ...patch };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}

/**
 * Сессия ПК-клиента. Порядок путей: последний удачный (`lastVia`) первым, второй — запасной.
 * connect() отдаёт готовый WS моста; переподключение и backoff — на стороне вызывающего.
 */
function createSession({ profile, token, pin, startTunnel, saveProfile, probe = probeLan, discover = discoverBridge,
  openWs = (host, port) => defaultOpenWs(host, port, { pin, token }) }) {
  let tunnel = null;
  let via = profile.lastVia === 'tunnel' ? 'tunnel' : 'lan';
  let lastDiscoverAt = 0;

  function stopTunnel() {
    if (!tunnel) return;
    try { tunnel.stop(); } catch { /* уже */ }
    tunnel = null;
  }

  function persist(patch) {
    Object.assign(profile, patch);
    if (!saveProfile) return;
    try { saveProfile(patch); } catch { /* профиль мог исчезнуть — не критично */ }
  }

  async function lanTarget() {
    let host = profile.host;
    let port = profile.port;
    let p = await probe({ host, port, pin, token });
    if (p.ok) return { host, port, ticket: p.ticket };
    if (p.revoked) {
      const e = new Error('мост отклонил токен устройства — оно отозвано?');
      e.revoked = true;
      throw e;
    }
    // DHCP сменил адрес: ищем мост маяком, но не чаще раза в минуту
    if (Date.now() - lastDiscoverAt < BEACON_COOLDOWN_MS) return null;
    lastDiscoverAt = Date.now();
    const found = await discover({ fingerprint: profile.fingerprint, port });
    if (!found || (found.host === host && found.port === port)) return null;
    p = await probe({ host: found.host, port: found.port, pin, token });
    if (!p.ok) return null;
    return { host: found.host, port: found.port, ticket: p.ticket };
  }

  return {
    get via() { return via; },
    async connect() {
      const order = via === 'lan' ? ['lan', 'tunnel'] : ['tunnel', 'lan'];
      const errors = [];
      for (const step of order) {
        try {
          if (step === 'lan') {
            const t = await lanTarget();
            if (!t) { errors.push('LAN недоступен'); continue; }
            const ws = await openWs(t.host, t.port);
            const patch = { lastVia: 'lan' };
            if (t.host !== profile.host || t.port !== profile.port) { patch.host = t.host; patch.port = t.port; }
            if (t.ticket && t.ticket !== profile.ticket) patch.ticket = t.ticket;
            persist(patch);
            via = 'lan';
            return { ws, via };
          }
          if (!profile.ticket) {
            const e = new Error('мост не сообщил ticket туннеля');
            e.noTicket = true;
            throw e;
          }
          tunnel = await startTunnel({ ticket: profile.ticket, secretFile: profile.paths.secret });
          const ws = await openWs('127.0.0.1', tunnel.port);
          persist({ lastVia: 'tunnel' });
          via = 'tunnel';
          return { ws, via };
        } catch (e) {
          if (e.revoked) { stopTunnel(); throw e; }
          stopTunnel();
          errors.push((step === 'lan' ? 'LAN' : 'туннель') + ': ' + e.message);
        }
      }
      throw new Error('Мост недоступен (' + errors.join('; ') + ')');
    },
    stop: stopTunnel,
  };
}

/** Обычное WS-соединение с мостом (пиннинг уже в pin). */
function defaultOpenWs(host, port, { pin, token } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:${port}/ws`, {
      ...pin, headers: { Authorization: 'Bearer ' + token }, handshakeTimeout: 10000,
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => {
      req.destroy();
      const e = new Error('мост ответил HTTP ' + res.statusCode + ' вместо WebSocket');
      e.status = res.statusCode;
      if (res.statusCode === 401) e.revoked = true;
      reject(e);
    });
    ws.once('error', reject);
  });
}

module.exports = {
  createSession, probeLan, discoverBridge, broadcastTargets, updateProfile,
  LAN_TIMEOUT_MS, BEACON_TIMEOUT_MS, BEACON_COOLDOWN_MS,
};
