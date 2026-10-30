'use strict';
// P-7: адрес основного LAN-интерфейса — его мост слушает вместо 0.0.0.0 и его же
// показывает в QR сопряжения. На Windows среди адаптеров часто есть виртуальные
// (Hyper-V/WSL vEthernet, VirtualBox, VMware) и VPN-оверлеи (Radmin 26.x, Tailscale
// 100.64/10, ZeroTier): телефон в Wi-Fi офиса через них мост не найдёт.
const os = require('os');

const VIRTUAL_NAME = /^(docker|br-|lxc|veth|virbr)|vethernet|wsl|hyper-v|virtualbox|vmware|vbox|loopback|radmin|zerotier|tailscale|hamachi|wireguard|openvpn|tap-/i;

function isRfc1918(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

/**
 * Выбрать адрес из os.networkInterfaces(): IPv4, не loopback, не link-local.
 * Приоритет: частный адрес (RFC 1918) физического адаптера > частный адрес любого
 * адаптера > любой оставшийся. Нет подходящих — '127.0.0.1' (только этот ПК).
 */
function pickLanAddress(ifaces = os.networkInterfaces()) {
  const cands = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('127.') || a.address.startsWith('169.254.')) continue;
      const rank = (isRfc1918(a.address) ? 0 : 2) + (VIRTUAL_NAME.test(name) ? 1 : 0);
      cands.push({ rank, address: a.address });
    }
  }
  cands.sort((x, y) => x.rank - y.rank); // стабильная сортировка: порядок ОС среди равных
  return cands.length ? cands[0].address : '127.0.0.1';
}

module.exports = { pickLanAddress };
