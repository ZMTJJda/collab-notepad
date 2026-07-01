'use strict';

const { verifySessionToken } = require('../utils/crypto');
const { store } = require('../db/store');
const revokedTokens = require('../db/revokedTokens');
const logger = require('../utils/logger');

function revokeToken(token, expiresAtEpoch) {
  revokedTokens.set(token, expiresAtEpoch);
  // Immediately persist to store and flush to disk (eliminates 200ms debounce window)
  store.getStore().revokedTokens = Object.fromEntries(revokedTokens.getAll());
  store.flush().catch(() => {});
}

function isTokenRevoked(token) {
  if (!revokedTokens.has(token)) return false;
  if (Date.now() / 1000 > revokedTokens.get(token)) {
    revokedTokens.del(token); // expired, clean up
    return false;
  }
  return true;
}

// Cleanup revoked tokens every 10 minutes
const revokedCleanupTimer = setInterval(() => {
  revokedTokens.cleanupExpired();
}, 600000);
revokedCleanupTimer.unref?.();

function verify(token) {
  if (!token || isTokenRevoked(token)) return null;
  return verifySessionToken(token);
}

// Restore revoked tokens from store on startup
function restoreFromStore() {
  revokedTokens.restoreFromStoreData(store.getStore());
  logger.info(`Restored ${revokedTokens.size()} revoked tokens from store`);
}

function getRevokedTokens() {
  return revokedTokens.getAll();
}

function getCleanupTimer() {
  return revokedCleanupTimer;
}

module.exports = {
  verify,
  revokeToken,
  isTokenRevoked,
  restoreFromStore,
  getRevokedTokens,
  getCleanupTimer,
};
