'use strict';

/**
 * Permission helpers — pure functions, no req/res, no I/O.
 * These are the single source of truth for access-control rules.
 */

function canAccessPad(userId, pad, hasAccessGrantFn) {
  if (!pad.ownerUserId) return true; // public pad
  if (!userId) return false;
  if (pad.ownerUserId === userId) return true; // owner
  return hasAccessGrantFn ? hasAccessGrantFn(pad.ownerUserId, userId) : false;
}

function canAccessFile(userId, file, findPadById, hasAccessGrantFn) {
  if (!file.ownerUserId) return true; // public file
  if (!userId) return false;
  if (file.ownerUserId === userId) return true;
  const pad = findPadById(file.padId);
  if (pad) return canAccessPad(userId, pad, hasAccessGrantFn);
  return false;
}

function canManagePad(userId, isAdminUser, pad) {
  if (pad.ownerUserId) {
    return userId === pad.ownerUserId || isAdminUser;
  }
  if (pad.creatorCode) {
    return userId === pad.creatorCode || isAdminUser;
  }
  return isAdminUser;
}

function resolveFileOwner(userId, pad) {
  if (pad && pad.ownerUserId) return pad.ownerUserId;
  return userId || null;
}

module.exports = {
  canAccessPad,
  canAccessFile,
  canManagePad,
  resolveFileOwner,
};
