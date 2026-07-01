'use strict';

/**
 * Revoked token blocklist — shared between auth/session.js and db/store.js.
 * Breaks the circular dependency: session.js ↔ store.js.
 *
 * Dependency direction (no cycles):
 *   auth/session.js  →  db/revokedTokens.js
 *   db/store.js      →  db/revokedTokens.js
 */

const revokedTokens = new Map(); // token -> expiresAt (epoch seconds)

function set(token, expiresAtEpoch) {
  revokedTokens.set(token, expiresAtEpoch);
}

function has(token) {
  return revokedTokens.has(token);
}

function get(token) {
  return revokedTokens.get(token);
}

function del(token) {
  revokedTokens.delete(token);
}

function getAll() {
  return revokedTokens;
}

function size() {
  return revokedTokens.size;
}

function cleanupExpired() {
  const nowSec = Date.now() / 1000;
  for (const [token, exp] of revokedTokens) {
    if (nowSec > exp) revokedTokens.delete(token);
  }
}

/**
 * Restore from raw store data object (called once at startup).
 * Filters out already-expired tokens.
 */
function restoreFromStoreData(storeData) {
  const raw = (storeData && storeData.revokedTokens) || {};
  const nowSec = Date.now() / 1000;
  for (const [token, expiresAt] of Object.entries(raw)) {
    if (expiresAt > nowSec) {
      revokedTokens.set(token, expiresAt);
    }
  }
}

module.exports = {
  set,
  has,
  get,
  del,
  getAll,
  size,
  cleanupExpired,
  restoreFromStoreData,
};
