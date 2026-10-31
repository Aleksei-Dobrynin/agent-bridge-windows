'use strict';
// D-13: выпуск кода сопряжения и включение интернет-доступа подтверждаются на уже
// сопряжённом телефоне. Здесь — только учёт ожидающих подтверждений; рассылку и
// выполнение делает server.js.
const crypto = require('crypto');

const MESSAGES = {
  pairinfo: 'Выпустить код сопряжения нового устройства?',
  setInternet: 'Включить доступ к мосту через интернет?',
};

class Confirmations {
  constructor({ ttlMs = 120000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  /** Новое подтверждение; null — такое действие уже ждёт ответа. */
  request(action, requester, run) {
    if (!MESSAGES[action]) throw new Error('unknown action: ' + action);
    const t = this.now();
    for (const e of this.map.values()) if (e.action === action && e.expiresAt > t) return null;
    const e = {
      confirmId: 'cf_' + crypto.randomBytes(8).toString('hex'),
      action, message: MESSAGES[action], at: t, expiresAt: t + this.ttlMs, requester, run,
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
  return { type: 'confirmRequest', confirmId: e.confirmId, action: e.action, message: e.message, at: e.at, expiresAt: e.expiresAt };
}

module.exports = { Confirmations, confirmView, MESSAGES };
