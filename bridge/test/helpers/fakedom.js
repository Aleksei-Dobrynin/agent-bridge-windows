'use strict';
// Минимальная поддельная DOM-среда для проверки проводки bridge/web/app.js в node:test без
// браузера и без новых зависимостей (jsdom не используется). Элементы создаются по id из
// index.html; app.js и lib.js выполняются в vm-контексте; WebSocket — подделка, сообщения моста
// подаются вручную (recv), исходящие копятся в sent. Терминал — заглушка xterm: write() разбирает
// данные асинхронно и, как xterm, отвечает в onData на запрос DA (ESC [ c) во время разбора.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', '..', 'web');
const ESC = String.fromCharCode(27);

class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; }
  contains(c) { return this.s.has(c); }
}

class El {
  constructor(doc, tag, id) {
    this.doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parent = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.autofocus = false;
    this.open = false;
    this.members = []; // для <dialog>: элементы с id внутри (из разметки)
    this.selectionStart = null;
    this.selectionEnd = null;
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.scrollLeft = 0;
    this.scrollTop = 0;
  }
  set className(v) { this.classList = new ClassList(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return [...this.classList.s].join(' '); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.children = []; this._text = String(v); }
  get innerHTML() { return this._text; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatch(t, ev = {}) {
    const e = Object.assign({ type: t, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, ev);
    for (const fn of [...(this.listeners[t] || [])]) fn(e);
    if (t === 'click' && typeof this.onclick === 'function') this.onclick(e);
    return e;
  }
  /** Как браузер: по отключённой кнопке click не срабатывает. */
  click() { if (this.disabled) return null; return this.dispatch('click'); }
  /** Как showModal(): фокус — элементу с autofocus, иначе первому фокусируемому внутри. */
  showModal() {
    this.open = true;
    const focusable = this.members.filter((e) => ['BUTTON', 'INPUT', 'SELECT'].includes(e.tagName));
    const target = focusable.find((e) => e.autofocus) || focusable[0];
    if (target) target.focus();
  }
  close() { if (this.open) { this.open = false; this.dispatch('close'); } }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; }
  descendants() { const out = []; for (const c of this.children) { out.push(c); out.push(...c.descendants()); } return out; }
}

// таймеры приложения не должны держать процесс теста
const unref = (t) => { if (t && t.unref) t.unref(); return t; };

/**
 * Загрузить index.html (только id-элементы), lib.js и app.js.
 * Возвращает { win, byId, term, sent, recv, run, lastSent, confirms, setConfirm, setClipboard, open, close }.
 */
function createApp({ storageThrows = false } = {}) {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const document = {
    activeElement: null,
    hidden: false,
    createElement: (t) => new El(document, t),
    createTextNode: (t) => { const n = new El(document, '#text'); n._text = String(t); return n; },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      if (m) return byId[m[1]] || null;
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      if (sel === '#keys button') return keyBtns;
      const m = /^#([\w-]+)\s+(\w+)(?:\[data-([\w-]+)\])?$/.exec(sel);
      if (m && byId[m[1]]) {
        return byId[m[1]].descendants().filter((e) => e.tagName === m[2].toUpperCase() &&
          (!m[3] || e.dataset[m[3]] !== undefined));
      }
      throw new Error('fakedom: unsupported selector ' + sel);
    },
    addEventListener() {},
  };
  document.body = new El(document, 'body');
  const byId = {};
  for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const idm = /\sid="([^"]+)"/.exec(m[2]);
    if (!idm) continue;
    const el = new El(document, m[1], idm[1]);
    const cls = /\sclass="([^"]+)"/.exec(m[2]);
    if (cls) el.className = cls[1];
    el.autofocus = /\sautofocus(?=[\s>=/]|$)/.test(m[2]);
    byId[idm[1]] = el;
  }
  // принадлежность элементов диалогам — по разметке
  for (const m of html.matchAll(/<dialog\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/dialog>/g)) {
    byId[m[1]].members = [...m[2].matchAll(/\sid="([^"]+)"/g)].map((x) => byId[x[1]]);
  }
  const keyBtns = [...html.matchAll(/<button data-key="([^"]+)"/g)].map((m) => {
    const b = new El(document, 'button'); b.dataset.key = m[1]; return b;
  });

  const sent = [];
  let sock = null;
  class FakeWS {
    constructor() {
      sock = this;
      this.readyState = 0;
      unref(setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0));
    }
    send(s) { sent.push(JSON.parse(s)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  const term = {
    writes: [],
    fromTerm: [],
    instance: null,
  };
  class Terminal {
    constructor() {
      term.instance = this;
      this.cols = 80; this.rows = 24;
      this.modes = { mouseTrackingMode: 'none' };
      this.buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 24,
        getLine: () => ({ translateToString: () => '' }) } };
      this._onData = [];
    }
    open(el) { this.element = new El(document, 'div'); el.appendChild(this.element); }
    onData(cb) { this._onData.push(cb); }
    onScroll() {} onResize() {} onWriteParsed() {}
    write(data, cb) {
      term.writes.push(data);
      unref(setTimeout(() => {
        if (String(data).includes(ESC + '[c')) this.emitData(ESC + '[?1;2c'); // ответ DA
        if (cb) cb();
      }, 20));
    }
    /** То, что xterm отдаёт в onData (набор человека, ответы терминала, вставка). */
    emitData(d) { term.fromTerm.push(d); for (const f of this._onData) f(d); }
    paste(d) { this.emitData(d.replace(/\n/g, '\r')); }
    reset() {} clear() {} resize(c, r) { this.cols = c; this.rows = r; }
    scrollLines() {} scrollToBottom() {} select() {} clearSelection() {} getSelection() { return ''; }
  }

  const store = {};
  const confirms = [];
  let confirmAnswer = () => true;
  let clipboard = '';
  const notifications = [];
  const win = {
    document,
    localStorage: storageThrows ? {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    } : {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    navigator: { clipboard: { readText: async () => clipboard, writeText: async () => {} }, vibrate: () => true },
    location: { protocol: 'https:', host: '127.0.0.1:0' },
    confirm: (q) => { confirms.push(q); return confirmAnswer(q); },
    Notification: Object.assign(function Notification(title, opts) { notifications.push({ title, ...opts }); },
      { permission: 'granted' }),
    Terminal,
    FitAddon: {},
    WebSocket: FakeWS,
    setTimeout: (f, ms, ...a) => unref(setTimeout(f, ms, ...a)),
    clearTimeout,
    setInterval: (f, ms, ...a) => unref(setInterval(f, ms, ...a)),
    clearInterval,
    console, JSON, Math, Date, Promise,
    addEventListener() {},
  };
  win.window = win;
  win.self = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'lib.js'), 'utf8'), ctx, { filename: 'lib.js' });
  vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

  return {
    win, byId, term, sent, document, notifications, store,
    run: (code) => vm.runInContext(code, ctx),
    recv: (m) => sock.onmessage({ data: JSON.stringify(m) }),
    lastSent: (type) => sent.filter((m) => m.type === type).pop(),
    confirms,
    setConfirm: (f) => { confirmAnswer = f; },
    setClipboard: (t) => { clipboard = t; },
    /** Дождаться открытия WS (onopen). */
    opened: () => new Promise((r) => { const t = () => (sock && sock.readyState === 1 ? r() : setTimeout(t, 1)); t(); }),
    dropConnection: () => sock.close(),
  };
}

module.exports = { createApp, ESC };
