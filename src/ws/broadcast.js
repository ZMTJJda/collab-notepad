'use strict';

const connections = require('./connections');

function toPad(padId, data, excludeWsId) {
  const set = connections.getPadClients(padId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of Array.from(set)) {
    if (excludeWsId && ws.clientId === excludeWsId) continue;
    if (ws.readyState !== 1) { connections.remove(ws); continue; }
    try { ws.send(msg); } catch { connections.remove(ws); }
  }
}

function toAll(data) {
  const msg = JSON.stringify(data);
  const allClients = [];
  // Collect all active clients first (snapshot), to avoid mutation during iteration
  connections.forEach((ws) => {
    if (ws.readyState === 1) {
      allClients.push(ws);
    } else {
      connections.remove(ws);
    }
  });
  for (const ws of allClients) {
    try { ws.send(msg); } catch { connections.remove(ws); }
  }
}

module.exports = { toPad, toAll };
