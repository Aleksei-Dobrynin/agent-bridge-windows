'use strict';
// Проводка веб-клиента (bridge/web/app.js) в поддельной DOM-среде (helpers/fakedom.js): фильтр
// вставки (L-10), кнопки запроса с паузой вооружения (D-4, ревью I-1), диалог подтверждения D-13
// (фокус по умолчанию и пауза «Разрешить», ревью I-2), проигрывание буфера (D-19.1).
const test = require('node:test');
const assert = require('node:assert');
const { createApp, ESC } = require('./helpers/fakedom');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSIONS = {
  type: 'sessions', projects: ['C:/w'], defaultAgent: 'claude',
  agents: [{ id: 'claude', name: 'Claude Code', scroll: 'wheel', options: [] }],
  sessions: [
    { id: 's_a', title: 'w · Claude Code', cwd: 'C:/w', alive: true, status: 'idle', agent: 'claude',
      agentName: 'Claude Code', scroll: 'wheel', lastNotify: null },
    { id: 's_b', title: 'w · opencode', cwd: 'C:/w', alive: true, status: 'idle', agent: 'opencode',
      agentName: 'opencode', scroll: 'wheel', lastNotify: null }],
};
const REQ = (o = {}) => ({ type: 'notify', id: 's_a', event: 'request', requestId: 'req_1', message: 'Bash: ls',
  title: 'w · Claude Code', at: 1,
  choices: [{ id: 'once', label: 'Да' }, { id: 'always', label: 'Всегда: ls *' }, { id: 'reject', label: 'Нет' }], ...o });

async function started(opts) {
  const app = createApp(opts);
  await app.opened();
  app.recv(SESSIONS);
  return app;
}

test('paste is filtered: 📋 button, paste into the input, paste into the terminal (L-10)', async () => {
  const app = await started();
  const { byId } = app;
  app.setClipboard('a' + ESC + '[31mb');
  byId.pasteBtn.click();
  await sleep(5);
  assert.strictEqual(byId.msg.value, 'a[31mb');
  byId.msg.value = 'XY'; byId.msg.selectionStart = 1; byId.msg.selectionEnd = 1;
  const e = byId.msg.dispatch('paste', { clipboardData: { getData: () => 'q' + ESC + 'w' } });
  assert.ok(e.defaultPrevented);
  assert.strictEqual(byId.msg.value, 'XqwY');
  app.term.instance.element.dispatch('paste', { clipboardData: { getData: () => 'a' + ESC + '[31mb\r\n' } });
  assert.deepStrictEqual(app.lastSent('input'), { type: 'input', id: 's_a', data: 'a[31mb\r' });
});

test('send button and voice result are filtered too (review M-2)', async () => {
  const app = await started();
  app.byId.msg.value = 'ls' + ESC + '[2J';
  app.run('sendMessage()');
  const inputs = app.sent.filter((m) => m.type === 'input').map((m) => m.data);
  assert.deepStrictEqual(inputs.slice(-2), ['ls[2J', '\r']);
  app.run("voiceMode = 'send'");
  app.win.sttResult(' echo' + ESC + '[31m hi ');
  const after = app.sent.filter((m) => m.type === 'input').map((m) => m.data);
  assert.deepStrictEqual(after.slice(-2), ['echo[31m hi', '\r']);
});

test('request bar: buttons from choices, armed after 500 ms, reply (D-4, review I-1)', async () => {
  const app = await started();
  const { byId } = app;
  const btns = () => byId.reqBtns.children;
  app.recv(REQ({ choices: [] }));
  assert.ok(byId.reqbar.classList.contains('hidden'), 'no choices -> no buttons');
  app.recv(REQ());
  assert.ok(!byId.reqbar.classList.contains('hidden'));
  assert.deepStrictEqual(btns().map((b) => b.textContent), ['Да', 'Всегда: ls *', 'Нет']);
  assert.ok(btns().every((b) => b.disabled), 'just shown -> disabled');
  btns()[0].disabled = false; // даже если кнопку «успели» нажать — клик игнорируется
  btns()[0].click();
  assert.strictEqual(app.lastSent('reply'), undefined, 'too early click ignored');
  await sleep(560);
  assert.ok(btns().every((b) => !b.disabled), 'armed after 500 ms');
  btns()[1].click();
  assert.deepStrictEqual(app.lastSent('reply'), { type: 'reply', id: 's_a', requestId: 'req_1', decision: 'always' });
  assert.ok(btns().every((b) => b.disabled), 'disabled while replying');
  // ответ принят, под пальцем появился следующий запрос — второе касание его не одобряет
  app.recv({ type: 'replyResult', id: 's_a', requestId: 'req_1', ok: true });
  app.recv(REQ({ requestId: 'req_2', at: 2 }));
  const n = app.sent.length;
  btns()[0].disabled = false;
  btns()[0].click();
  assert.strictEqual(app.sent.length, n, 'next request is not approved by a double tap');
  // повтор того же запроса (D-20) не сбрасывает вооружение
  await sleep(560);
  app.recv(REQ({ requestId: 'req_2', at: 2 }));
  assert.ok(btns().every((b) => !b.disabled));
  btns()[2].click();
  assert.deepStrictEqual(app.lastSent('reply'), { type: 'reply', id: 's_a', requestId: 'req_2', decision: 'reject' });
});

test('request bar is hidden while disconnected and comes back with the replay (review M-3, D-20)', async () => {
  const app = await started();
  const { byId } = app;
  app.recv(REQ());
  assert.ok(!byId.reqbar.classList.contains('hidden'));
  app.dropConnection();
  assert.ok(byId.reqbar.classList.contains('hidden'), 'no buttons without a connection');
  await app.opened();
  await sleep(700); // переподключение (reconnectDelay 500 мс)
  app.recv(SESSIONS);
  app.recv(REQ());
  assert.ok(!byId.reqbar.classList.contains('hidden'));
});

test('confirm dialog: deny has default focus, allow is disabled for 700 ms (D-13, review I-2)', async () => {
  const app = await started();
  const { byId } = app;
  const CR = { type: 'confirmRequest', confirmId: 'cf_1', action: 'pairinfo', message: 'Выпустить код?', checkCode: '0427' };
  app.recv(CR);
  assert.ok(byId.confirmDialog.open);
  assert.strictEqual(app.document.activeElement, byId.confirmDeny, 'Enter/tap does not allow by default');
  assert.strictEqual(byId.confirmCode.textContent, '0427');
  assert.strictEqual(byId.confirmAllow.disabled, true);
  byId.confirmAllow.disabled = false;
  byId.confirmAllow.click();
  assert.strictEqual(app.lastSent('confirm'), undefined, 'too early allow ignored');
  await sleep(760);
  assert.strictEqual(byId.confirmAllow.disabled, false);
  // другой запрос в том же открытом диалоге — снова пауза
  app.recv({ ...CR, confirmId: 'cf_2', checkCode: '1111' });
  assert.strictEqual(byId.confirmAllow.disabled, true);
  await sleep(760);
  byId.confirmAllow.click();
  assert.deepStrictEqual(app.lastSent('confirm'), { type: 'confirm', confirmId: 'cf_2', allow: true });
  assert.ok(!byId.confirmDialog.open);
  // отклонить можно сразу
  app.recv({ ...CR, confirmId: 'cf_3' });
  byId.confirmDeny.click();
  assert.deepStrictEqual(app.lastSent('confirm'), { type: 'confirm', confirmId: 'cf_3', allow: false });
});

test('terminal answers to queries in the replayed scrollback are not sent (D-19.1)', async () => {
  const app = await started();
  const inputs = () => app.sent.filter((m) => m.type === 'input');
  const n = inputs().length;
  app.recv({ type: 'scrollback', id: 's_a', data: 'hello' + ESC + '[c', alive: true, cols: 80, rows: 24 });
  app.term.instance.emitData('during-replay');
  await sleep(60);
  assert.ok(app.term.fromTerm.includes(ESC + '[?1;2c'), 'xterm answered DA');
  assert.strictEqual(inputs().length, n, 'nothing sent while replaying');
  app.recv({ type: 'output', id: 's_a', data: ESC + '[c' });
  await sleep(60);
  assert.deepStrictEqual(app.lastSent('input'), { type: 'input', id: 's_a', data: ESC + '[?1;2c' }, 'live query answered');
});

test('system notification is titled by the session agent (review M-9)', async () => {
  const app = await started();
  app.document.hidden = true;
  app.recv({ type: 'notify', id: 's_b', event: 'done', message: 'готово', title: 'w · opencode', at: 1 });
  app.recv({ type: 'notify', id: '', event: 'info', message: 'Устройство отозвано: X', at: 2 });
  assert.deepStrictEqual(app.notifications.map((x) => x.title), ['opencode', 'Agent Bridge']);
  assert.strictEqual(app.notifications[1].body, 'Устройство отозвано: X');
});

test('works without localStorage; bridge error without text shows a fallback (review M-8, M-7)', async () => {
  const app = await started({ storageThrows: true });
  const { byId } = app;
  assert.strictEqual(app.run('current'), 's_a', 'attached despite storage errors');
  byId.newBtn.click();
  assert.ok(byId.newDialog.open);
  byId.projectSel.value = 'C:/w';
  byId.createOk.click();
  assert.deepStrictEqual(app.lastSent('create'), { type: 'create', agent: 'claude', options: {}, cwd: 'C:/w' });
  app.recv({ type: 'error' });
  assert.strictEqual(byId.banner.textContent, '⚠ Ошибка моста');
});
