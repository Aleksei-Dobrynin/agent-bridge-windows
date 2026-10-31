'use strict';
// Клиент фонового сервиса opencode v2 (D-12). Факты — «Живая проба opencode v2.1.4»
// в реестре решений: service.json (url/password/pid/version), Basic opencode:<password>,
// живость — GET /api/info, API под /api.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,128}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serviceFilePath(env = process.env) {
  const base = env.XDG_STATE_HOME || path.join(env.USERPROFILE || os.homedir(), '.local', 'state');
  return path.join(base, 'opencode', 'service.json');
}

/** service.json -> { url, password, pid, version } | null. Пароль не отправляется за пределы loopback. */
function readServiceFile(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!j || typeof j.url !== 'string' || typeof j.password !== 'string' || !j.password) return null;
  let u;
  try { u = new URL(j.url); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname)) return null;
  return { url: j.url.replace(/\/+$/, ''), password: j.password, pid: j.pid, version: j.version };
}

function authHeader(password) {
  return 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
}

class OpencodeClient {
  /** start() — запустить сервис (`opencode service start`), если он не отвечает. */
  constructor({ file = serviceFilePath(), start = null, timeoutMs = 5000 } = {}) {
    this.file = file;
    this.start = start;
    this.timeoutMs = timeoutMs;
  }

  info() { return readServiceFile(this.file); }

  request(method, pathname, body, info = this.info()) {
    return new Promise((resolve, reject) => {
      if (!info) { reject(new Error('сервис opencode не найден (service.json)')); return; }
      const u = new URL(info.url + pathname);
      const mod = u.protocol === 'https:' ? https : http;
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = { Authorization: authHeader(info.password), Accept: 'application/json' };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      const req = mod.request(u, { method, agent: false, timeout: this.timeoutMs, headers }, (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { s += d; if (s.length > 4e6) req.destroy(new Error('opencode: слишком большой ответ')); });
        res.on('end', () => {
          let json = null;
          try { json = s ? JSON.parse(s) : null; } catch { /* не JSON */ }
          resolve({ status: res.statusCode, json });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('opencode: таймаут')));
      req.on('error', reject);
      req.end(data || undefined);
    });
  }

  async alive(info = this.info()) {
    if (!info) return false;
    try { return (await this.request('GET', '/api/info', null, info)).status === 200; } catch { return false; }
  }

  async ensure({ attempts = 40, delayMs = 500 } = {}) {
    if (await this.alive()) return this.info();
    if (typeof this.start === 'function') this.start();
    for (let i = 0; i < attempts; i++) {
      await sleep(delayMs);
      if (await this.alive()) return this.info();
    }
    throw new Error('сервис opencode не отвечает (opencode service start)');
  }

  async createSession({ title, directory, permissions }) {
    const body = { title, location: { directory } };
    if (permissions) body.permissions = permissions;
    const r = await this.request('POST', '/api/session', body);
    const id = r.json && r.json.data && r.json.data.id;
    if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || !SESSION_ID.test(id)) {
      throw new Error(`opencode: не удалось создать сессию (HTTP ${r.status})`);
    }
    return id;
  }

  async listPermissions(sid) {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sid)}/permission`);
    if (r.status !== 200) throw new Error(`opencode: список разрешений недоступен (HTTP ${r.status})`);
    const arr = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.data) ? r.json.data : []);
    return arr.filter((p) => p && typeof p.id === 'string');
  }

  /** 'ok' — принят (204), 'stale' — запроса уже нет (404 PermissionNotFoundError). */
  async replyPermission(sid, rid, decision) {
    const r = await this.request('POST',
      `/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(rid)}/reply`, { decision });
    if (r.status === 204 || r.status === 200) return 'ok';
    if (r.status === 404) return 'stale';
    throw new Error(`opencode: ответ на разрешение не принят (HTTP ${r.status})`);
  }
}

module.exports = { OpencodeClient, serviceFilePath, readServiceFile, authHeader };
