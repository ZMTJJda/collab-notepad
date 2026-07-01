'use strict';

const crypto = require('crypto');
const session = require('../auth/session');
const { store } = require('../db/store');
const { ADMIN_TOKEN } = require('../config');

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    try {
      result[key] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      result[key] = pair.slice(idx + 1).trim();
    }
  }
  return result;
}

// Authenticate middleware: sets req.userId, never blocks
function authenticate(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.session_token || req.headers['x-session-token'] || null;
  const userId = session.verify(token);
  // Also check if user exists in the store
  const userCodes = new Set(store.getStore().users.map(u => u.code));
  req.userId = (userId && userCodes.has(userId)) ? userId : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const provided = req.headers['x-admin-token'] || '';
  if (provided.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_TOKEN));
}

function hasAccessGrant(grantorCode, granteeCode) {
  return store.getStore().accessGrants.some(
    g => g.grantorCode === grantorCode && g.granteeCode === granteeCode
  );
}

function canAccessPad(userId, pad) {
  if (!pad.ownerUserId) return true; // public pad
  if (!userId) return false;
  if (pad.ownerUserId === userId) return true; // owner
  return hasAccessGrant(pad.ownerUserId, userId); // invited
}

function canAccessFile(userId, file) {
  if (!file.ownerUserId) return true; // public file
  if (!userId) return false;
  if (file.ownerUserId === userId) return true;
  // Check if user has access to the pad this file belongs to
  const pad = store.getStore().pads.find(p => p.id === file.padId);
  if (pad) return canAccessPad(userId, pad);
  return false;
}

function canManagePad(userId, isAdminUser, pad) {
  // Private pad: owner or admin
  if (pad.ownerUserId) {
    return userId === pad.ownerUserId || isAdminUser;
  }
  // Public pad with creator: creator or admin
  if (pad.creatorCode) {
    return userId === pad.creatorCode || isAdminUser;
  }
  // Legacy pad (creatorCode=null): admin only
  return isAdminUser;
}

function resolveFileOwner(userId, pad) {
  // In invited pad, files belong to the pad owner, not the uploader
  if (pad && pad.ownerUserId) return pad.ownerUserId;
  return userId || null;
}

module.exports = {
  parseCookies,
  authenticate,
  requireAuth,
  isAdmin,
  hasAccessGrant,
  canAccessPad,
  canAccessFile,
  canManagePad,
  resolveFileOwner,
};
