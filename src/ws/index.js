'use strict';

const { WebSocketServer } = require('ws');
const connections = require('./connections');
const broadcast = require('./broadcast');
const session = require('../auth/session');
const { parseCookies } = require('../middlewares/auth');
const { isAllowedOrigin } = require('../middlewares/security');
const db = require('../db');
const { generateId } = require('../utils/crypto');
const { MAX_WS_CONNECTIONS, MAX_WS_CONNECTIONS_PER_IP, HEARTBEAT_INTERVAL_MS } = require('../config');
const logger = require('../utils/logger');

function initWSS(server, padService) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // Hard connection ceiling to protect memory and heartbeat CPU
    if (connections.getTotalCount() >= MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Server overloaded');
      return;
    }

    // Per-IP connection limit to prevent single-IP pool exhaustion
    const clientIp = req.ip || req.socket.remoteAddress;
    if (connections.getIpCount(clientIp) >= MAX_WS_CONNECTIONS_PER_IP) {
      ws.close(1013, 'Connection limit reached for this IP');
      return;
    }

    // Origin check: prevent cross-origin WebSocket connections.
    // Unlike checkOrigin (HTTP), WebSocket handshakes from browsers always
    // include an Origin header, so a missing Origin here indicates a non-browser
    // client — allow it (same rationale as isAllowedOrigin returning true for
    // missing Origin on GET requests).
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      ws.close(4400, 'Invalid origin');
      return;
    }

    // Parse padId and token from URL query
    const url = new URL(req.url, 'http://localhost');
    const rawPad = Number(url.searchParams.get('pad'));
    const padId = Number.isInteger(rawPad) && rawPad > 0 ? rawPad : 1;

    // Token verification: Cookie only (session token is never transmitted in URL)
    const cookieToken = parseCookies(req.headers.cookie || '')['session_token'];
    const token = cookieToken || null;
    const userId = session.verify(token);
    ws.userId = (userId && db.users.exists(userId)) ? userId : null;

    // Access control: reject non-existent pads immediately
    const targetPad = db.pads.findById(padId);
    if (!targetPad) {
      ws.close(4404, 'Pad not found');
      return;
    }

    // Check pad access
    if (!targetPad.ownerUserId || targetPad.ownerUserId === ws.userId) {
      // Public pad or owner — allow
    } else if (!ws.userId || !db.invitations.hasAccessGrant(targetPad.ownerUserId, ws.userId)) {
      ws.close(4401, 'Access denied');
      return;
    }

    // Password-protected pad: require a valid unlock token via query string
    if (targetPad.password) {
      const padToken = url.searchParams.get('padToken') || null;
      if (!padService || !padService.isValidUnlockToken(padToken, padId)) {
        ws.close(4403, 'Pad locked');
        return;
      }
    }

    ws.ipAddress = clientIp;
    ws.clientId = generateId();
    ws.padId = padId;
    ws.isAlive = true;
    connections.add(ws, { clientId: ws.clientId, padId, userId: ws.userId, ipAddress: clientIp });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      connections.remove(ws);
      broadcast.toPad(padId, { type: 'online-count', count: connections.getPadCount(padId) });
    });
    ws.on('error', () => connections.remove(ws));

    ws.send(JSON.stringify({ type: 'hello', wsId: ws.clientId, padId, userId: ws.userId }));
    broadcast.toPad(padId, { type: 'online-count', count: connections.getPadCount(padId) });
  });

  // Heartbeat
  const heartbeatTimer = setInterval(() => {
    connections.forEach((ws) => {
      if (ws.readyState !== 1) { connections.remove(ws); return; }
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  return { wss, heartbeatTimer };
}

module.exports = { initWSS };
