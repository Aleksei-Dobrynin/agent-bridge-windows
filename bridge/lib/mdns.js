'use strict';
// P-7 (ревью I-1): mDNS-объявление моста без имени ПК и без адресов прочих адаптеров.
// bonjour-service 1.4 по умолчанию берёт host = os.hostname() и пишет A/AAAA-записи для
// КАЖДОГО интерфейса (Service.records()); опция Bonjour({interface}) ограничивает только
// сокет multicast, но не состав записей. Поэтому имя хоста задаём нейтральное (из
// отпечатка), а records() подменяем: A — только адрес, который мост реально слушает.
const os = require('os');

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isConcreteIPv4(ip) {
  return typeof ip === 'string' && IPV4.test(ip) && ip !== '0.0.0.0' && !ip.startsWith('127.');
}

/** Нечего объявлять, пока нет LAN-адреса (мост слушает только loopback). */
function shouldPublish(listenHost) {
  return listenHost === '0.0.0.0' || isConcreteIPv4(listenHost);
}

function bonjourOptions(listenHost) {
  return isConcreteIPv4(listenHost) ? { interface: listenHost } : {};
}

function serviceConfig({ name, port, fingerprint }) {
  return {
    name: name || 'claude-bridge',
    type: 'claude-bridge',
    port,
    host: 'claude-bridge-' + String(fingerprint).slice(0, 8) + '.local',
    disableIPv6: true,
    txt: { path: '/', fp: fingerprint },
  };
}

/** Подменить service.records(): служебные записи как есть, A — только адрес(а) моста, без AAAA. */
function restrictRecords(service, listenHost, ifaces = os.networkInterfaces) {
  service.records = function records() {
    const out = [this.RecordPTR(this), this.RecordSRV(this), this.RecordTXT(this), this.RecordServicePTR(this)];
    for (const st of this.subtypes || []) out.push(this.RecordSubtypePTR(this, st));
    let addrs = [];
    if (isConcreteIPv4(listenHost)) {
      addrs = [listenHost];
    } else if (listenHost === '0.0.0.0') { // явно настроено «все интерфейсы»
      for (const list of Object.values(ifaces() || {})) {
        for (const a of list || []) {
          if ((a.family === 'IPv4' || a.family === 4) && !a.internal) addrs.push(a.address);
        }
      }
    }
    for (const ip of addrs) out.push(this.RecordA(this, ip));
    return out;
  };
  return service;
}

/** Опубликовать мост; вернуть объект Bonjour (destroy() — снять объявление). */
function publish({ listenHost, name, port, fingerprint, onError }) {
  const { Bonjour } = require('bonjour-service');
  const report = onError || (() => {});
  const bonjour = new Bonjour(bonjourOptions(listenHost), report);
  bonjour.server.mdns.on('error', report); // без обработчика ошибка сокета уронила бы мост
  const service = bonjour.publish(serviceConfig({ name, port, fingerprint }));
  // до объявления: publish() зондирует сеть асинхронно, records() вызывается позже
  restrictRecords(service, listenHost);
  return bonjour;
}

module.exports = { isConcreteIPv4, shouldPublish, bonjourOptions, serviceConfig, restrictRecords, publish };
