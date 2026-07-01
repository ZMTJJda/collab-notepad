'use strict';

const crypto = require('crypto');
const { SESSION_SECRET, SESSION_TOKEN_TTL_DAYS, MAX_PASSWORD_LENGTH } = require('../config');

function generateId() {
  return crypto.randomBytes(12).toString('base64url');
}

function generateUserCode() {
  return crypto.randomBytes(6).toString('base64url'); // 8 chars
}

function generateInviteToken() {
  return crypto.randomBytes(16).toString('base64url'); // 22 chars, 128 bit
}

function signSessionToken(userId, expiresInDays) {
  const ttl = expiresInDays || SESSION_TOKEN_TTL_DAYS;
  const ts = Math.floor(Date.now() / 1000 + ttl * 86400).toString(36);
  const sig = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${ts}`).digest('hex');
  return `${userId}.${ts}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, tsStr, sig] = parts;
  if (!userId || !tsStr || !sig) return null;
  const expiresAt = parseInt(tsStr, 36);
  if (isNaN(expiresAt) || Date.now() / 1000 > expiresAt) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${tsStr}`).digest('hex');
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ? userId : null;
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (typeof password !== 'string' || password.length === 0) return resolve(null);
    const pw = password.length > MAX_PASSWORD_LENGTH ? password.slice(0, MAX_PASSWORD_LENGTH) : password;
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (!stored || typeof stored !== 'string' || typeof password !== 'string') return resolve(false);
    const pw = password.length > MAX_PASSWORD_LENGTH ? password.slice(0, MAX_PASSWORD_LENGTH) : password;
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    try {
      const salt = Buffer.from(parts[1], 'hex');
      const hash = Buffer.from(parts[2], 'hex');
      crypto.scrypt(pw, salt, 64, (err, derivedKey) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(hash, derivedKey));
      });
    } catch {
      resolve(false);
    }
  });
}

module.exports = {
  generateId,
  generateUserCode,
  generateInviteToken,
  signSessionToken,
  verifySessionToken,
  hashPassword,
  verifyPassword,
};
