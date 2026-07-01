'use strict';

const { NotFoundError, ForbiddenError, BadRequestError, ConflictError, GoneError } = require('../utils/errors');
const { generateInviteToken } = require('../utils/crypto');

class InviteService {
  constructor(db, broadcast) {
    this.db = db;
    this.broadcast = broadcast;
  }

  async create(userId, maxUses, expiresInHours) {
    const token = generateInviteToken();
    const invite = {
      token,
      creatorCode: userId,
      maxUses: maxUses > 0 ? maxUses : 0, // 0 = unlimited
      useCount: 0,
      expiresAt: expiresInHours > 0 ? Date.now() + expiresInHours * 3600000 : null,
      createdAt: Date.now(),
    };
    this.db.invitations.create(invite);
    return { token, maxUses, expiresInHours: expiresInHours || null };
  }

  async redeem(userId, token) {
    const invite = this.db.invitations.findByToken(token);
    if (!invite) throw NotFoundError('Invalid invitation token');
    if (invite.expiresAt && Date.now() > invite.expiresAt) {
      throw GoneError('Invitation expired');
    }
    if (invite.maxUses > 0 && invite.useCount >= invite.maxUses) {
      throw GoneError('Invitation fully redeemed');
    }
    if (invite.creatorCode === userId) {
      throw BadRequestError('Cannot redeem your own invitation');
    }
    if (this.db.invitations.hasAccessGrant(invite.creatorCode, userId)) {
      throw ConflictError('Already have access from this inviter');
    }

    this.db.invitations.addGrant({
      inviteToken: token,
      grantorCode: invite.creatorCode,
      granteeCode: userId,
      grantedAt: Date.now(),
    });
    invite.useCount += 1;
    return { ok: true, grantorCode: invite.creatorCode };
  }

  async list(userId) {
    const data = this.db.store.getStore();
    return {
      created: data.inviteTokens.filter(t => t.creatorCode === userId),
      received: data.accessGrants.filter(g => g.granteeCode === userId),
    };
  }

  async delete(userId, token) {
    const invite = this.db.invitations.findByToken(token);
    if (!invite) throw NotFoundError('Token not found');
    if (invite.creatorCode !== userId) throw ForbiddenError('Not your invitation');
    const result = this.db.invitations.remove(token);
    return result;
  }
}

module.exports = InviteService;
