'use strict';

const padClients = new Map(); // padId -> Set<ws>
const wsConnectionsPerIp = new Map(); // tracks active WS connections per IP

function add(ws, meta) {
  ws.clientId = meta.clientId;
  ws.padId = meta.padId;
  ws.userId = meta.userId;
  ws.ipAddress = meta.ipAddress;
  ws.isAlive = true;

  if (!padClients.has(meta.padId)) padClients.set(meta.padId, new Set());
  padClients.get(meta.padId).add(ws);

  if (meta.ipAddress) {
    const count = wsConnectionsPerIp.get(meta.ipAddress) || 0;
    wsConnectionsPerIp.set(meta.ipAddress, count + 1);
  }
}

function remove(ws) {
  const set = padClients.get(ws.padId);
  if (!set || !set.delete(ws)) return;
  if (set.size === 0) padClients.delete(ws.padId);

  if (ws.ipAddress) {
    const count = wsConnectionsPerIp.get(ws.ipAddress) || 0;
    if (count <= 1) wsConnectionsPerIp.delete(ws.ipAddress);
    else wsConnectionsPerIp.set(ws.ipAddress, count - 1);
  }
}

function getTotalCount() {
  let count = 0;
  for (const set of padClients.values()) count += set.size;
  return count;
}

function getIpCount(ip) {
  return wsConnectionsPerIp.get(ip) || 0;
}

function getPadCount(padId) {
  const set = padClients.get(padId);
  return set ? set.size : 0;
}

function forEach(fn) {
  for (const set of padClients.values()) {
    for (const ws of set) fn(ws);
  }
}

function getPadClients(padId) {
  return padClients.get(padId);
}

module.exports = {
  add,
  remove,
  getTotalCount,
  getIpCount,
  getPadCount,
  forEach,
  getPadClients,
};
