'use strict';
// Применение событий адаптера (P-2) к сессии: статус, ожидающие запросы разрешений (D-4),
// уведомления. Чистая функция: возвращает WS-сообщения для рассылки всем клиентам.
const STATUSES = new Set(['working', 'waiting', 'idle']);
const DECISIONS = ['once', 'always', 'reject'];

function cleanChoices(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && DECISIONS.includes(c.id) && typeof c.label === 'string')
    .map((c) => ({ id: c.id, label: c.label.slice(0, 40) }));
}

/** Закрыт запрос, о котором говорит lastNotify: показать оставшийся открытый запрос или ничего —
 *  иначе клиент, подключившийся позже, видит в списке «запрос» без кнопок. */
function refreshRequestNotify(session) {
  if (!session.lastNotify || session.lastNotify.event !== 'request') return false;
  let latest = null;
  for (const p of session.pending.values()) if (!latest || p.at >= latest.at) latest = p;
  session.lastNotify = latest ? { event: 'request', message: latest.message, at: latest.at } : null;
  return true;
}

function applyEvents(session, events, now = Date.now()) {
  if (!session.pending) session.pending = new Map();
  const messages = [];
  let sessionsChanged = false;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'status' && STATUSES.has(ev.status)) {
      if (session.status !== ev.status) {
        session.status = ev.status;
        messages.push({ type: 'status', id: session.id, status: ev.status });
        sessionsChanged = true;
      }
    } else if (ev.kind === 'request' && typeof ev.requestId === 'string' && ev.requestId && ev.requestId.length <= 128) {
      const message = String(ev.message || '').slice(0, 500);
      const choices = cleanChoices(ev.choices);
      const pend = { requestId: ev.requestId, message, choices, at: now };
      // D-23.3: сессия агента, которой адресован ответ (дочерняя сессия opencode); клиентам не уходит
      if (typeof ev.agentSessionId === 'string' && ev.agentSessionId && ev.agentSessionId.length <= 128) {
        pend.agentSessionId = ev.agentSessionId;
      }
      session.pending.set(ev.requestId, pend);
      session.lastNotify = { event: 'request', message, at: now };
      messages.push({ type: 'notify', id: session.id, event: 'request', requestId: ev.requestId,
        choices, message, title: session.title, at: now });
      sessionsChanged = true;
    } else if (ev.kind === 'requestClosed' && typeof ev.requestId === 'string') {
      if (session.pending.delete(ev.requestId)) {
        messages.push({ type: 'requestClosed', id: session.id, requestId: ev.requestId });
        if (refreshRequestNotify(session)) sessionsChanged = true;
      }
    } else if (ev.kind === 'notify') {
      const message = String(ev.message || '').slice(0, 500);
      const event = ev.done ? 'done' : 'info';
      session.lastNotify = { event, message, at: now };
      messages.push({ type: 'notify', id: session.id, event, message, title: session.title, at: now });
      sessionsChanged = true;
    }
  }
  return { messages, sessionsChanged };
}

function closeAllRequests(session) {
  const out = [];
  if (!session.pending) return out;
  for (const requestId of session.pending.keys()) out.push({ type: 'requestClosed', id: session.id, requestId });
  session.pending.clear();
  refreshRequestNotify(session);
  return out;
}

module.exports = { applyEvents, closeAllRequests, DECISIONS };
