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
const NON_LOOPBACK = 'service.json указывает не на loopback — мост не отправит пароль';
// M-4: общий предел ожидания сервиса при создании сессии (а не попытки × таймаут запроса)
const ENSURE_DEADLINE_MS = 25000;

/** Ошибка с текстом, который можно показать клиенту моста (M-3): без путей, адресов и паролей. */
function userError(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

function serviceFilePath(env = process.env) {
  const base = env.XDG_STATE_HOME || path.join(env.USERPROFILE || os.homedir(), '.local', 'state');
  return path.join(base, 'opencode', 'service.json');
}

/** service.json -> { info } | { missing: true } | { refused: текст }. Пароль не отправляется за
 *  пределы loopback (M-1); url — только origin: путь, query, hash и userinfo отбрасываются (M-2). */
function parseServiceFile(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { missing: true }; }
  if (!j || typeof j.url !== 'string' || typeof j.password !== 'string' || !j.password) return { missing: true };
  let u;
  try { u = new URL(j.url); } catch { return { missing: true }; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.has(u.hostname)) return { refused: NON_LOOPBACK };
  return { info: { url: u.origin, password: j.password, pid: j.pid, version: j.version } };
}

/** service.json -> { url, password, pid, version } | null (нет, битый или не loopback). */
function readServiceFile(file) {
  return parseServiceFile(file).info || null;
}

function authHeader(password) {
  return 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
}

class OpencodeClient {
  /** start() — запустить сервис (`opencode service start`), если он не отвечает.
   *  SSE: backoffMs..maxBackoffMs — пауза перед переподключением (удваивается, сброс после 200);
   *  idleMs — тишина в потоке, после которой он считается мёртвым (v2.1.4 шлёт `: heartbeat` раз в 15 с).
   *  Пауза сбрасывается только после первого байта тела потока (M-7): сервис, отвечающий 200 и сразу
   *  закрывающий поток, не должен вызывать переподключения без паузы. */
  constructor({ file = serviceFilePath(), start = null, timeoutMs = 5000,
    backoffMs = 500, maxBackoffMs = 10000, idleMs = 45000, ensureDeadlineMs = ENSURE_DEADLINE_MS } = {}) {
    this.file = file;
    this.start = start;
    this.timeoutMs = timeoutMs;
    this.ensureDeadlineMs = ensureDeadlineMs;
    this.ensuring = null;
    this.minBackoff = backoffMs;
    this.maxBackoff = maxBackoffMs;
    this.idleMs = idleMs;
    this.subs = new Map();
    this.sse = null;
    this.sseOpen = false;
    this.backoff = backoffMs;
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.closed = false;
  }

  info() { return readServiceFile(this.file); }

  request(method, pathname, body, info = this.info(), timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!info) { reject(userError('сервис opencode не найден (service.json)')); return; }
      const u = new URL(info.url + pathname);
      const mod = u.protocol === 'https:' ? https : http;
      const data = body == null ? null : Buffer.from(JSON.stringify(body));
      const headers = { Authorization: authHeader(info.password), Accept: 'application/json' };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      const req = mod.request(u, { method, agent: false, timeout: timeoutMs, headers }, (res) => {
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

  async alive(info = this.info(), timeoutMs = this.timeoutMs) {
    if (!info) return false;
    try { return (await this.request('GET', '/api/info', null, info, timeoutMs)).status === 200; } catch { return false; }
  }

  /** Сервис отвечает -> info; иначе запустить и ждать не дольше deadlineMs (M-4). Параллельные
   *  вызовы (несколько сессий создаются разом) делят одну попытку и один запуск сервиса.
   *  service.json не на loopback -> отказ без запуска (M-1). */
  ensure({ deadlineMs = this.ensureDeadlineMs, delayMs = 500 } = {}) {
    if (this.ensuring) return this.ensuring;
    const p = this._ensure(deadlineMs, delayMs).finally(() => { if (this.ensuring === p) this.ensuring = null; });
    this.ensuring = p;
    return p;
  }

  async _ensure(deadlineMs, delayMs) {
    const end = Date.now() + deadlineMs;
    const left = () => Math.max(end - Date.now(), 1);
    const check = async () => {
      const st = parseServiceFile(this.file);
      if (st.refused) throw userError(st.refused);
      return st.info && await this.alive(st.info, Math.min(this.timeoutMs, left())) ? st.info : null;
    };
    let info = await check();
    if (info) return info;
    if (typeof this.start === 'function') this.start();
    while (Date.now() < end) {
      await sleep(Math.min(delayMs, left()));
      info = await check();
      if (info) return info;
    }
    throw userError('сервис opencode не отвечает (opencode service start)');
  }

  async createSession({ title, directory, permissions }) {
    const body = { title, location: { directory } };
    if (permissions) body.permissions = permissions;
    const r = await this.request('POST', '/api/session', body);
    const id = r.json && r.json.data && r.json.data.id;
    if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || !SESSION_ID.test(id)) {
      throw userError(`opencode: не удалось создать сессию (HTTP ${r.status})`);
    }
    return id;
  }

  /** Ожидающие запросы сессии. Неожиданная форма ответа — ошибка (M-6): ресинхронизация по
   *  «пустому» списку закрыла бы все открытые запросы. */
  async listPermissions(sid) {
    const r = await this.request('GET', `/api/session/${encodeURIComponent(sid)}/permission`);
    if (r.status !== 200) throw new Error(`opencode: список разрешений недоступен (HTTP ${r.status})`);
    const arr = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.data) ? r.json.data : null);
    if (!arr) throw new Error('opencode: неожиданный ответ на список разрешений');
    return arr.filter((p) => p && typeof p.id === 'string');
  }

  /** Сессии, которые сейчас выполняются (GET /api/session/active, OpenAPI v2.1.4:
   *  data: { ses_…: { type: 'running' } }; отсутствующие в ответе — неактивны). */
  async activeSessions() {
    const r = await this.request('GET', '/api/session/active');
    const data = r.json && r.json.data;
    if (r.status !== 200 || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`opencode: неожиданный ответ на список активных сессий (HTTP ${r.status})`);
    }
    return new Set(Object.keys(data));
  }

  /** 'ok' — принят (204); 'stale' — запроса уже нет (404 PermissionNotFoundError, M-6);
   *  прочие ответы, в т.ч. 404 SessionNotFoundError, — ошибка. */
  async replyPermission(sid, rid, decision) {
    const r = await this.request('POST',
      `/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(rid)}/reply`, { decision });
    if (r.status === 204 || r.status === 200) return 'ok';
    const tag = r.json && (r.json._tag || r.json.name);
    if (r.status === 404 && tag === 'PermissionNotFoundError') return 'stale';
    throw new Error(`opencode: ответ на разрешение не принят (HTTP ${r.status}${typeof tag === 'string' ? ' ' + tag : ''})`);
  }

  /** Подписка на события одной сессии. handler(evt) получает события SSE с этим sessionID
   *  и синтетическое { type:'bridge.resync', data:{ sessionID, startedAt, permissions, running } }
   *  после (пере)подключения: поток общий для всех сессий и пропущенное при обрыве не досылает
   *  (живая проба v2.1.4). startedAt — performance.now() в момент запроса списков; running —
   *  выполняется ли сессия (true/false) или undefined, если список активных сессий недоступен. */
  subscribe(sid, handler) {
    this.closed = false;
    this.subs.set(sid, handler);
    if (this.sseOpen) this._resync([sid]);
    else this._ensureSse();
    return () => {
      if (this.subs.get(sid) === handler) this.subs.delete(sid);
      if (!this.subs.size) this._closeSse();
    };
  }

  close() {
    this.closed = true;
    this.subs.clear();
    this._closeSse();
  }

  _ensureSse() {
    if (this.closed || this.sse || this.reconnectTimer || !this.subs.size) return;
    const info = this.info();
    if (!info) { this._scheduleReconnect(); return; }
    const u = new URL(info.url + '/api/event');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', agent: false,
      headers: { Authorization: authHeader(info.password), Accept: 'text/event-stream' },
    }, (res) => {
      if (this.sse !== req) { res.resume(); return; }
      if (res.statusCode !== 200) { res.resume(); this._dropSse(req); return; }
      this.sseOpen = true;
      this._touch(req);
      this._resync([...this.subs.keys()]);
      // Buffer-чанки: парсер сам декодирует UTF-8 потоково (символ может быть разрезан между чанками)
      const feed = sseParser((evt) => this._dispatch(evt));
      let gotData = false;
      res.on('data', (chunk) => {
        // M-7: пауза переподключения сбрасывается по первому байту потока, а не по HTTP 200
        if (!gotData) { gotData = true; this.backoff = this.minBackoff; }
        this._touch(req);
        feed(chunk);
      });
      // обрыв со стороны сервиса: в зависимости от версии Node — end, error(aborted) или только close;
      // _dropSse идемпотентен
      res.on('end', () => this._dropSse(req));
      res.on('error', () => this._dropSse(req));
      res.on('close', () => this._dropSse(req));
    });
    req.on('error', () => this._dropSse(req));
    this.sse = req;
    this._touch(req); // ожидание заголовков ответа тоже ограничено idleMs
    req.end();
  }

  /** Сторожевой таймер тишины: любой байт потока (в т.ч. `: heartbeat`) продлевает соединение. */
  _touch(req) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._dropSse(req), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _dropSse(req) {
    if (this.sse !== req) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.sse = null;
    this.sseOpen = false;
    try { req.destroy(); } catch { /* уже закрыт */ }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer || !this.subs.size) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._ensureSse(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  _closeSse() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const req = this.sse;
    this.sse = null;
    this.sseOpen = false;
    if (req) { try { req.destroy(); } catch { /* уже закрыт */ } }
  }

  _dispatch(evt) {
    if (!evt || typeof evt.type !== 'string' || !evt.data || typeof evt.data !== 'object') return;
    const handler = typeof evt.data.sessionID === 'string' ? this.subs.get(evt.data.sessionID) : null;
    if (!handler) return;
    this._call(handler, evt);
  }

  /** Ошибка обработчика (синхронная или отклонённый промис) не рвёт поток и не мешает другим сессиям. */
  _call(handler, evt) {
    try {
      const r = handler(evt);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('[opencode] обработчик события:', e && e.message));
    } catch (e) {
      console.error('[opencode] обработчик события:', e && e.message);
    }
  }

  /** startedAt (performance.now() в момент запроса списка): список отражает события, полученные
   *  до этого момента; более поздние события подписчик не должен «откатывать» по этому списку. */
  _resync(sids) {
    for (const sid of sids) {
      const startedAt = performance.now();
      // M-5: выполняется ли сессия — чтобы после ресинхронизации статус не остался устаревшим;
      // недоступный список активных сессий ресинхронизацию разрешений не отменяет
      const running = this.activeSessions().then((set) => set.has(sid), () => undefined);
      Promise.all([this.listPermissions(sid), running]).then(([permissions, run]) => {
        const handler = this.subs.get(sid);
        if (handler) {
          this._call(handler, { type: 'bridge.resync', data: { sessionID: sid, startedAt, permissions, running: run } });
        }
      }).catch((e) => console.error('[opencode] ресинхронизация:', e.message));
    }
  }
}

/** Парсер text/event-stream: накапливает строки `data:` до пустой строки, отдаёт JSON.
 *  Чанки — строки или Buffer (UTF-8 декодируется потоково). Событие длиннее maxEventBytes
 *  отбрасывается целиком, разбор продолжается со следующего события. */
function sseParser(onEvent, { maxEventBytes = 8e6 } = {}) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let data = [];
  let size = 0;
  let skipping = false;
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const text = data.join('\n');
        const had = data.length;
        data = [];
        size = 0;
        if (skipping) { skipping = false; continue; }
        if (!had) continue;
        let evt;
        try { evt = JSON.parse(text); } catch { continue; }
        onEvent(evt);
      } else if (skipping) {
        // остаток слишком большого события
      } else if (line.startsWith('data:')) {
        const part = line.slice(5).replace(/^ /, '');
        size += part.length + 1;
        if (size > maxEventBytes) { skipping = true; data = []; size = 0; } else data.push(part);
      }
      // `: комментарий` (heartbeat), `event:`, `id:`, `retry:` — не используются
    }
    // незавершённая строка тоже ограничена: иначе поток без переводов строк съест память
    if (buf.length + size > maxEventBytes) { buf = ''; data = []; size = 0; skipping = true; }
  };
}

module.exports = { OpencodeClient, serviceFilePath, readServiceFile, authHeader, sseParser };
