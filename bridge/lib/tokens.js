'use strict';
// P-1: токен владельца (файл в профиле) и одноразовые токены для входа браузера.
const fs = require('fs');
const crypto = require('crypto');

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readToken(file) {
  const t = fs.readFileSync(file, 'utf8').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

function loadOrCreateOwnerToken(file) {
  try {
    const t = readToken(file);
    if (t) return t;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // EACCES/EBUSY и т.п. — не затираем токен молча
    // нет файла — создадим эксклюзивно (гонка двух процессов: проигравший перечитает)
    const t = newToken();
    try {
      fs.writeFileSync(file, t + '\n', { flag: 'wx' });
      return t;
    } catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
      const again = readToken(file);
      if (again) return again;
    }
  }
  return rotateOwnerToken(file); // файл есть, но содержимое негодное
}

function rotateOwnerToken(file) {
  const t = newToken();
  fs.writeFileSync(file, t + '\n');
  return t;
}

class OneTimeTokens {
  constructor(ttlMs = 60000, now = Date.now) { this.ttlMs = ttlMs; this.now = now; this.map = new Map(); }
  purge() {
    const now = this.now();
    for (const [k, exp] of this.map) if (exp < now) this.map.delete(k);
  }
  issue() {
    this.purge();
    const t = newToken();
    this.map.set(t, this.now() + this.ttlMs);
    return t;
  }
  /** Отозвать все выданные токены (напр. при ротации токена владельца). */
  clear() {
    this.map.clear();
  }
  consume(t) {
    if (typeof t !== 'string') return false;
    this.purge();
    for (const k of this.map.keys()) {
      if (safeEq(k, t)) { this.map.delete(k); return true; }
    }
    return false;
  }
}

module.exports = { safeEq, newToken, loadOrCreateOwnerToken, rotateOwnerToken, OneTimeTokens };
