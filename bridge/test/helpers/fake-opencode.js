'use strict';
// Фейковый фоновый сервис opencode v2 для тестов — без реального opencode и токенов модели.
// Повторяет факты живой пробы v2.1.4: Basic opencode:<pw>, /api/info, POST /api/session -> data.id,
// SSE /api/event со строками только `data:`, список/ответ разрешений, 204 и 404.
const fs = require('fs');
const path = require('path');
const http = require('http');

function startFakeOpencode({ password = 'test-pw' } = {}) {
  const state = { sessions: [], replies: [], perms: new Map(), sse: new Set(), unauthorized: 0, sseConnects: 0, sseConnectTimes: [], sseStatus: 200,
    sseEmpty: false, active: new Set(), createStatus: 200, replyDelayMs: 0,
    // дочерние сессии (субагенты, D-23.3): id -> parentID; список GET /api/session?parentID=…
    // (OpenAPI v2.1.4); listStatus != 200 — сервис без такого списка
    parents: new Map(), listStatus: 200, listQueries: [], deleted: new Set() };
  const expected = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');

  function emit(evt) {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const r of state.sse) r.write(line);
  }
  /** Сырые байты во все SSE-соединения — для проверки разрезанных чанков. */
  function writeRaw(buf) {
    for (const r of state.sse) r.write(buf);
  }
  function addSilently(sessionID, perm) {
    const p = { sessionID, action: 'shell', resources: [], save: [], ...perm };
    const list = state.perms.get(sessionID) || [];
    list.push(p);
    state.perms.set(sessionID, list);
    return p;
  }
  function ask(sessionID, perm) {
    const p = addSilently(sessionID, perm);
    emit({ type: 'permission.asked', data: p });
    return p;
  }
  /** Дочерняя сессия; announce — с событием session.created (как v2.1.4: data.sessionID, data.parentID). */
  function addChild(sessionID, parentID, { announce = true } = {}) {
    state.parents.set(sessionID, parentID);
    if (announce) emit({ type: 'session.created', data: { sessionID, parentID, title: 'sub', agent: 'general' } });
  }
  function dropSse() {
    for (const r of state.sse) { try { r.destroy(); } catch { /* закрыт */ } }
    state.sse.clear();
  }

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) { state.unauthorized++; res.writeHead(401); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let m;
      if (req.method === 'GET' && u.pathname === '/api/info') return json(200, { data: { pid: process.pid, version: 'fake' } });
      if (req.method === 'GET' && u.pathname === '/api/session') {
        state.listQueries.push(u.search);
        if (state.listStatus !== 200) return json(state.listStatus, { name: 'BadRequest' });
        const parent = u.searchParams.get('parentID');
        const data = [...state.parents].filter(([, p]) => !parent || p === parent)
          .map(([id, p]) => ({ id, parentID: p, projectID: 'prj', title: 'sub' }));
        return json(200, { data, cursor: { previous: null, next: null } });
      }
      if (req.method === 'POST' && u.pathname === '/api/session') {
        if (state.createStatus !== 200) return json(state.createStatus, { name: 'Error' });
        const id = 'ses_fake' + (state.sessions.length + 1);
        state.sessions.push({ id, body: JSON.parse(body || '{}') });
        return json(200, { data: { id } });
      }
      if (req.method === 'GET' && u.pathname === '/api/event') {
        state.sseConnects++;
        state.sseConnectTimes.push(Date.now());
        if (state.sseStatus !== 200) { res.writeHead(state.sseStatus); res.end(); return undefined; }
        // 200 без единого байта тела и сразу закрыт (сервис «моргает»)
        if (state.sseEmpty) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); return undefined; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        // как v2.1.4: первое событие server.connected без sessionID, затем `: heartbeat` каждые 15 с
        res.write('data: {"id":"evt_fake","type":"server.connected","data":{}}\n\n: heartbeat\n\n');
        state.sse.add(res);
        res.on('close', () => state.sse.delete(res));
        return undefined;
      }
      // как v2.1.4: активные (выполняющиеся) сессии — data: { ses_…: { type: 'running' } }
      if (req.method === 'GET' && u.pathname === '/api/session/active') {
        return json(200, { data: Object.fromEntries([...state.active].map((id) => [id, { type: 'running' }])) });
      }
      if (req.method === 'GET' && (m = u.pathname.match(/^\/api\/session\/([^/]+)\/permission$/))) {
        if (state.deleted.has(m[1])) return json(404, { _tag: 'SessionNotFoundError', sessionID: m[1] });
        return json(200, { data: state.perms.get(m[1]) || [] });
      }
      if (req.method === 'POST' && (m = u.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/))) {
        // медленный сервис (M-4): ответ — через replyDelayMs
        if (state.replyDelayMs > 0) { const mm = m; setTimeout(() => replyPermission(mm), state.replyDelayMs); return undefined; }
        return replyPermission(m);
      }
      return json(404, { name: 'NotFound' });

      function replyPermission(m) {
        const list = state.perms.get(m[1]) || [];
        const i = list.findIndex((p) => p.id === m[2]);
        if (i < 0) return json(404, { _tag: 'PermissionNotFoundError', requestID: m[2], message: 'not found' });
        const decision = JSON.parse(body || '{}').decision;
        if (!['once', 'always', 'reject'].includes(decision)) return json(400, { name: 'BadRequest' });
        list.splice(i, 1);
        state.replies.push({ sessionID: m[1], requestID: m[2], decision });
        res.writeHead(204);
        res.end();
        emit({ type: 'permission.replied', data: { sessionID: m[1], requestID: m[2], reply: decision } });
        return undefined;
      }
    });
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url, password, state, emit, writeRaw, ask, addSilently, addChild, dropSse,
      writeServiceFile(dir, overrides = {}) {
        const file = path.join(dir, 'opencode', 'service.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ url, password, pid: process.pid, version: 'fake', ...overrides }));
        return file;
      },
      close() {
        dropSse();
        return new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
      },
    });
  }));
}

module.exports = { startFakeOpencode };
