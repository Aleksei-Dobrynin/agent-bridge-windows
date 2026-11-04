'use strict';
// Фикстурный claude-tunnel: `id` печатает node_id и выходит; `connect` печатает ready{port}
// (порт задаёт тест) и живёт до kill. Режимы ошибок — CB_FAKE_TUNNEL_MODE=error|hang.
const mode = process.env.CB_FAKE_TUNNEL_MODE || 'ready';
if (process.argv[2] === 'id') {
  process.stdout.write(JSON.stringify({ event: 'id', node_id: process.env.CB_FAKE_NODE_ID || 'a'.repeat(64) }) + '\n');
  process.exit(0);
}
if (mode === 'error') {
  process.stdout.write(JSON.stringify({ event: 'error', message: 'no relay' }) + '\n');
  process.exit(0);
}
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  const port = Number(process.env.CB_FAKE_TUNNEL_PORT);
  if (!Number.isInteger(port)) { console.error('CB_FAKE_TUNNEL_PORT'); process.exit(2); }
  process.stdout.write(JSON.stringify({ event: 'ready', port }) + '\n');
  setInterval(() => {}, 1000);
}
