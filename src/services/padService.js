'use strict';

const { NotFoundError, ForbiddenError, BadRequestError, UnauthorizedError } = require('../utils/errors');
const { canAccessPad, canAccessFile, canManagePad, resolveFileOwner } = require('../utils/auth');
const { hashPassword, verifyPassword } = require('../auth/password');
const { generateId } = require('../utils/crypto');
const { MAX_PADS, UNLOCK_TOKEN_TTL_MS } = require('../config');

class PadService {
  constructor(db, broadcast) {
    this.db = db;
    this.broadcast = broadcast;
    this.unlockTokens = new Map();
    this.unlockCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [token, entry] of this.unlockTokens) {
        if (now > entry.expires) this.unlockTokens.delete(token);
      }
    }, 600000);
    this.unlockCleanupTimer.unref?.();
  }

  padMeta(pad) {
    return {
      id: pad.id,
      hasPassword: !!pad.password,
      createdAt: pad.createdAt,
      ownerUserId: pad.ownerUserId || null,
    };
  }

  createUnlockToken(padId) {
    const token = generateId() + generateId();
    this.unlockTokens.set(token, { padId, expires: Date.now() + UNLOCK_TOKEN_TTL_MS });
    return token;
  }

  isValidUnlockToken(token, padId) {
    if (!token) return false;
    const entry = this.unlockTokens.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expires) {
      this.unlockTokens.delete(token);
      return false;
    }
    return entry.padId === padId;
  }

  canAccessPad(userId, pad) {
    return canAccessPad(userId, pad, this.db.invitations.hasAccessGrant.bind(this.db.invitations));
  }

  canAccessFile(userId, file) {
    return canAccessFile(
      userId, file,
      this.db.pads.findById.bind(this.db.pads),
      this.db.invitations.hasAccessGrant.bind(this.db.invitations)
    );
  }

  canManagePad(userId, isAdminUser, pad) {
    return canManagePad(userId, isAdminUser, pad);
  }

  getPadById(padId) {
    return this.db.pads.findById(padId) || null;
  }

  async getPad(userId, padId) {
    const pad = this.db.pads.findById(padId);
    if (!pad) throw NotFoundError('Pad not found');
    if (!this.canAccessPad(userId, pad)) {
      throw ForbiddenError('Access denied');
    }
    return pad;
  }

  async getState(userId) {
    const hasGrantFn = this.db.invitations.hasAccessGrant.bind(this.db.invitations);
    const pads = this.db.pads.findAll();
    const files = this.db.files.findAll();
    const accessiblePads = pads.filter(p => canAccessPad(userId, p, hasGrantFn));
    const accessibleFiles = files.filter(f =>
      canAccessFile(userId, f, this.db.pads.findById.bind(this.db.pads), hasGrantFn)
    );
    return {
      pads: accessiblePads.map(p => this.padMeta(p)),
      files: accessibleFiles,
      userCode: userId || null,
    };
  }

  async updateText(userId, padId, text, excludeWsId) {
    const pad = this.db.pads.findById(padId);
    if (!pad) throw NotFoundError('Pad not found');
    if (!this.canAccessPad(userId, pad)) throw ForbiddenError('Access denied');

    const updated = this.db.pads.updateText(padId, text);
    this.broadcast.toPad(padId, {
      type: 'text-update',
      padId: pad.id,
      text: updated.text,
      textVersion: updated.textVersion,
    }, excludeWsId);
    return updated;
  }

  async createPad(userId) {
    const pads = this.db.pads.findAll();
    if (pads.length >= MAX_PADS) {
      throw BadRequestError(`Maximum ${MAX_PADS} pads reached`);
    }
    const pad = this.db.pads.create({
      ownerUserId: userId || null,
      creatorCode: userId || null,
    });
    this.broadcast.toAll({ type: 'pad-created', pad: this.padMeta(pad) });
    return pad;
  }

  async setPassword(userId, isAdminUser, padId, newPassword, currentPassword, unlockToken) {
    const pad = this.db.pads.findById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    if (!this.canManagePad(userId, isAdminUser, pad)) {
      if (!userId) throw UnauthorizedError('Authentication required');
      throw ForbiddenError('Access denied');
    }

    // If pad has a password, require current password OR valid unlock token
    if (pad.password) {
      const hasValidToken = unlockToken && this.isValidUnlockToken(unlockToken, pad.id);
      if (!hasValidToken) {
        if (!currentPassword) throw ForbiddenError('Current password incorrect');
        const valid = await verifyPassword(currentPassword, pad.password);
        if (!valid) throw ForbiddenError('Current password incorrect');
      }
    }

    const hash = newPassword ? await hashPassword(newPassword) : null;
    if (newPassword && !hash) throw BadRequestError('Invalid password');

    const updated = this.db.pads.updatePassword(padId, hash);

    for (const [token, entry] of this.unlockTokens) {
      if (entry.padId === padId) this.unlockTokens.delete(token);
    }

    let newToken = null;
    if (updated.password) {
      newToken = this.createUnlockToken(padId);
    }

    this.broadcast.toAll({ type: 'pad-updated', pad: this.padMeta(updated) });
    return { ok: true, hasPassword: !!updated.password, token: newToken };
  }

  async deletePad(userId, isAdminUser, padId) {
    const pad = this.db.pads.findById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    if (!this.canManagePad(userId, isAdminUser, pad)) {
      throw ForbiddenError('Access denied');
    }

    const pads = this.db.pads.findAll();
    if (pads.length <= 1) throw BadRequestError('Cannot delete the last pad');

    for (const [token, entry] of this.unlockTokens) {
      if (entry.padId === padId) this.unlockTokens.delete(token);
    }

    // Delete files via db layer (handles disk + store)
    const filesToDelete = this.db.files.findAll().filter(f => (f.padId || 1) === padId);
    for (const file of filesToDelete) {
      this.db.files.remove(file.id);
    }

    this.db.pads.remove(padId);
    this.broadcast.toAll({ type: 'pad-deleted', padId });
    for (const file of filesToDelete) {
      this.broadcast.toPad(padId, { type: 'file-deleted', fileId: file.id });
    }

    return { ok: true, deletedFiles: filesToDelete.length };
  }

  async unlockPad(padId, password) {
    const pad = this.db.pads.findById(padId);
    if (!pad) throw NotFoundError('Pad not found');
    if (!pad.password) return { ok: true, token: null };

    const isValid = await verifyPassword(password, pad.password);
    if (!isValid) throw ForbiddenError('Wrong password');

    const token = this.createUnlockToken(padId);
    return { ok: true, token };
  }

  getCleanupTimer() {
    return this.unlockCleanupTimer;
  }
}

module.exports = PadService;
