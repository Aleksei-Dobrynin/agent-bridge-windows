'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pickLanAddress } = require('../lib/lan');

const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });

test('prefers private Wi-Fi/Ethernet over VPN overlay and Hyper-V/WSL adapters', () => {
  // реальный порядок адаптеров на машине разработки
  assert.strictEqual(pickLanAddress({
    'Radmin VPN': [v4('26.240.136.90')],
    'Беспроводная сеть': [v4('10.201.32.155')],
    'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    'vEthernet (Default Switch)': [v4('172.23.48.1')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.18.128.1')],
  }), '10.201.32.155');
});

test('skips link-local and IPv6; private virtual beats public', () => {
  assert.strictEqual(pickLanAddress({
    Ethernet: [{ family: 'IPv6', address: 'fe80::1', internal: false }, v4('169.254.10.1')],
    'Tailscale': [v4('100.100.1.2')],
    'vEthernet (Default Switch)': [v4('172.23.48.1')],
  }), '172.23.48.1');
});

test('keeps OS order among equal candidates; nothing usable -> loopback', () => {
  assert.strictEqual(pickLanAddress({ A: [v4('192.168.1.5')], B: [v4('192.168.2.5')] }), '192.168.1.5');
  assert.strictEqual(pickLanAddress({ lo: [v4('127.0.0.1', true)] }), '127.0.0.1');
  assert.strictEqual(pickLanAddress({}), '127.0.0.1');
});

test('no private (RFC 1918) IPv4 -> loopback, never a public/CGNAT address (m-5)', () => {
  assert.strictEqual(pickLanAddress({ Ethernet: [v4('8.8.4.4')] }), '127.0.0.1', 'public');
  assert.strictEqual(pickLanAddress({ 'Мобильная сеть': [v4('100.72.10.5')] }), '127.0.0.1', 'CGNAT');
  assert.strictEqual(pickLanAddress({ 'Radmin VPN': [v4('26.240.136.90')], Tailscale: [v4('100.100.1.2')] }), '127.0.0.1', 'VPN overlays');
  assert.strictEqual(pickLanAddress({ Ethernet: [v4('8.8.4.4')], 'vEthernet (WSL)': [v4('172.18.128.1')] }), '172.18.128.1',
    'private virtual still beats public');
  for (const ip of ['172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1']) {
    assert.strictEqual(pickLanAddress({ Ethernet: [v4(ip)] }), '127.0.0.1', ip);
  }
});
