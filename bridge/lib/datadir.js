'use strict';
// Каталог данных моста (D-9, P-1): секреты и состояние — в профиле пользователя,
// а не в рабочей копии git. Профиль закрыт ACL от других учётных записей (D-8).
const fs = require('fs');
const os = require('os');
const path = require('path');

function dataDir() {
  if (process.env.CLAUDE_BRIDGE_HOME) return path.resolve(process.env.CLAUDE_BRIDGE_HOME);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ClaudeBridge');
}

function ensureDataDirs(root = dataDir()) {
  for (const sub of ['', 'sessions', 'logs', 'certs']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return {
    root,
    config: path.join(root, 'config.json'),
    pairings: path.join(root, 'pairings.json'),
    internet: path.join(root, 'internet.json'),
    ownerToken: path.join(root, 'owner.token'),
    certs: path.join(root, 'certs'),
    sessions: path.join(root, 'sessions'),
    logs: path.join(root, 'logs'),
  };
}

module.exports = { dataDir, ensureDataDirs };
