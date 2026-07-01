'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { checkOrigin } = require('../middlewares/security');
const { UnauthorizedError, BadRequestError } = require('../utils/errors');

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many redeem attempts.' },
});

const inviteCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  keyGenerator: (req) => req.userId || ipKeyGenerator(req.ip || req.socket.remoteAddress || ''),
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many invitations created.' },
});

function createRouter(inviteService) {
  const router = express.Router();

  // Create invitation
  router.post('/', inviteCreateLimiter, checkOrigin, async (req, res, next) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      const rawMaxUses = Number(req.body?.maxUses);
      const maxUses = Number.isFinite(rawMaxUses) && rawMaxUses >= 0 ? Math.floor(rawMaxUses) : 1;
      const expiresInHours = Number(req.body?.expiresInHours) || 0;

      const result = await inviteService.create(req.userId, maxUses, expiresInHours);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Redeem invitation
  router.post('/redeem', redeemLimiter, checkOrigin, async (req, res, next) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      const token = req.body?.token;
      if (!token) throw BadRequestError('Token required');

      const result = await inviteService.redeem(req.userId, token);
      res.json(result);
    } catch (e) { next(e); }
  });

  // List invitations
  router.get('/', async (req, res, next) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      const result = await inviteService.list(req.userId);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Delete invitation
  router.delete('/:token', checkOrigin, async (req, res, next) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      const result = await inviteService.delete(req.userId, req.params.token);
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = createRouter;
