'use strict';
// I-1 (P-7): mDNS-объявление моста не раскрывает имя ПК и адреса прочих адаптеров.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { Service } = require('bonjour-service');
const M = require('../lib/mdns');

const FP = 'ab12cd34' + '0'.repeat(56);
const IFACES = {
  'Radmin VPN': [{ family: 'IPv4', address: '26.240.136.90', internal: false, mac: '02:50:00:00:00:01' }],
  'Беспроводная сеть': [
    { family: 'IPv4', address: '10.201.32.155', internal: false, mac: 'aa:bb:cc:dd:ee:ff' },
    { family: 'IPv6', address: 'fe80::1', internal: false, mac: 'aa:bb:cc:dd:ee:ff' },
  ],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.18.128.1', internal: false, mac: '00:15:5d:00:00:01' }],
};

function records(listenHost) {
  const svc = new Service(M.serviceConfig({ name: 'claude-bridge', port: 8790, fingerprint: FP }));
  M.restrictRecords(svc, listenHost, () => IFACES);
  return svc.records();
}

test('service config: neutral host name from the fingerprint, IPv6 off', () => {
  const cfg = M.serviceConfig({ name: 'claude-bridge', port: 8790, fingerprint: FP });
  assert.strictEqual(cfg.host, 'claude-bridge-ab12cd34.local');
  assert.strictEqual(cfg.disableIPv6, true);
  assert.deepStrictEqual(cfg.txt, { path: '/', fp: FP });
});

test('records: no os.hostname(), A only for the listen address, no AAAA', () => {
  const recs = records('10.201.32.155');
  const text = JSON.stringify(recs);
  assert.ok(!text.toLowerCase().includes(os.hostname().toLowerCase()), 'hostname leaked: ' + text);
  const a = recs.filter((r) => r.type === 'A').map((r) => r.data);
  assert.deepStrictEqual(a, ['10.201.32.155']);
  assert.strictEqual(recs.filter((r) => r.type === 'AAAA').length, 0);
  const srv = recs.find((r) => r.type === 'SRV');
  assert.strictEqual(srv.data.target, 'claude-bridge-ab12cd34.local');
});

test('bonjour options: bind multicast to the concrete listen address only', () => {
  assert.deepStrictEqual(M.bonjourOptions('10.201.32.155'), { interface: '10.201.32.155' });
  assert.deepStrictEqual(M.bonjourOptions('0.0.0.0'), {});
  assert.strictEqual(M.shouldPublish('127.0.0.1'), false, 'no LAN -> nothing to announce');
  assert.strictEqual(M.shouldPublish('10.201.32.155'), true);
});

test('explicit host 0.0.0.0: A records for all non-internal IPv4, still no hostname', () => {
  const recs = records('0.0.0.0');
  assert.deepStrictEqual(recs.filter((r) => r.type === 'A').map((r) => r.data).sort(),
    ['10.201.32.155', '172.18.128.1', '26.240.136.90']);
  assert.ok(!JSON.stringify(recs).toLowerCase().includes(os.hostname().toLowerCase()));
});
