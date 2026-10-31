'use strict';
// D-13: выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже
// сопряжённом телефоне. Здесь — только учёт ожидающих подтверждений; рассылку и
// выполнение делает server.js.
// D-22.3: у каждого запроса — контрольный код из 4 цифр (человек сверяет его в консоли и на
// телефоне); после отказа/истечения — пауза для этого действия (1 мин, ×2 до 15 мин),
// сбрасывается одобрением.
const crypto = require('crypto');

const MESSAGES = {
  pairinfo: 'Выпустить код сопряжения нового устройства?',
  setInternet: 'Включить доступ к мосту через интернет?',
};

class Confirmations {
  constructor({ ttlMs = 120000, cooldownMs = 60000, maxCooldownMs = 15 * 60000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.cooldownBase = cooldownMs;
    this.cooldownMax = maxCooldownMs;
    this.now = now;
    this.map = new Map();
    this.cooldowns = new Map(); // action -> { until, nextMs }
  }

  /** Сколько мс ещё действует пауза для действия (0 — можно запрашивать). */
  cooldownMs(action) {
    const c = this.cooldowns.get(action);
    return c ? Math.max(0, c.until - this.now()) : 0;
  }

  /** Итог подтверждения: одобрение снимает паузу; отказ/истечение — пауза, следующая вдвое длиннее. */
  noteOutcome(action, allowed) {
    if (allowed) { this.cooldowns.delete(action); return; }
    const c = this.cooldowns.get(action) || { until: 0, nextMs: this.cooldownBase };
    c.until = this.now() + c.nextMs;
    c.nextMs = Math.min(c.nextMs * 2, this.cooldownMax);
    this.cooldowns.set(action, c);
  }

  /** I-2: запросивший отключился — его ожидающие подтверждения снимаются (вернуть для рассылки confirmClosed). */
  cancelByRequester(requester) {
    const out = [];
    for (const [k, e] of this.map) if (e.requester === requester) { this.map.delete(k); out.push(e); }
    return out;
  }

  /** Новое подтверждение; null — такое действие уже ждёт ответа. */
  request(action, requester, run) {
    if (!MESSAGES[action]) throw new Error('unknown action: ' + action);
    const t = this.now();
    for (const e of this.map.values()) if (e.action === action && e.expiresAt > t) return null;
    const e = {
      confirmId: 'cf_' + crypto.randomBytes(8).toString('hex'),
      action, message: MESSAGES[action], checkCode: String(crypto.randomInt(0, 10000)).padStart(4, '0'), at: t, expiresAt: t + this.ttlMs, requester, run,
    };
    this.map.set(e.confirmId, e);
    return e;
  }

  /** Забрать ожидающее подтверждение (однократно); просроченное не выдаётся — его заберёт sweep. */
  resolve(confirmId) {
    if (typeof confirmId !== 'string') return null;
    const e = this.map.get(confirmId);
    if (!e || e.expiresAt <= this.now()) return null;
    this.map.delete(confirmId);
    return e;
  }

  /** Удалить и вернуть просроченные. */
  sweep() {
    const t = this.now();
    const out = [];
    for (const [k, e] of this.map) if (e.expiresAt <= t) { this.map.delete(k); out.push(e); }
    return out;
  }

  list() {
    const t = this.now();
    return [...this.map.values()].filter((e) => e.expiresAt > t);
  }
}

function confirmView(e) {
  return {
    type: 'confirmRequest', confirmId: e.confirmId, action: e.action, message: e.message, checkCode: e.checkCode,
    at: e.at, expiresAt: e.expiresAt,
  };
}

module.exports = { Confirmations, confirmView, MESSAGES };
