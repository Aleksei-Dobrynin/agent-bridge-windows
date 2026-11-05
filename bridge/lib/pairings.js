'use strict';
// D-30: повторное сопряжение того же p2p-узла (тот же NodeId) не должно плодить устройства:
// перевыпускаем токен существующей записи. Без nodeId поведение прежнее (телефон регистрирует
// NodeId отдельным сообщением registerNode уже после /pair).
function upsertDevice(devices, { tokenHash, name, nodeId, at }) {
  const id = tokenHash.slice(0, 12);
  const same = nodeId ? devices.find((d) => d.nodeId === nodeId) : null;
  if (same) {
    Object.assign(same, { id, tokenHash, name, addedAt: at });
    return { device: same, replaced: true };
  }
  const device = { id, tokenHash, name, addedAt: at };
  if (nodeId) device.nodeId = nodeId;
  devices.push(device);
  return { device, replaced: false };
}

module.exports = { upsertDevice };
