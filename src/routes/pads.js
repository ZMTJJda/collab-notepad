'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin, requirePadUnlock } = require('../middlewares/security');
const { requireAuth, isAdmin } = require('../middlewares/auth');
const { BadRequestError } = require('../utils/errors');

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many write requests.' },
});

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many unlock attempts. Please try again later.' },
});

const publicPadCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  skip: (req) => !!req.userId,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many public pad creations.' },
});

function createRouter(padService) {
  const router = express.Router();
  const padUnlock = requirePadUnlock(padService);

  // Get pad content
  router.get('/:id', padUnlock, async (req, res, next) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
      const pad = await padService.getPad(req.userId, padId);
      res.json({ id: pad.id, text: pad.text, textVersion: pad.textVersion, hasPassword: !!pad.password });
    } catch (e) { next(e); }
  });

  // Update pad text (PUT for normal sync; POST alias for navigator.sendBeacon)
  const updatePadText = async (req, res, next) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
      const text = typeof req.body.text === 'string' ? req.body.text : '';
      const updated = await padService.updateText(req.userId, padId, text, req.body._wsId);
      res.json({ ok: true, textVersion: updated.textVersion });
    } catch (e) { next(e); }
  };

  router.put('/:id/text', writeLimiter, checkOrigin, padUnlock, updatePadText);
  router.post('/:id/text', writeLimiter, checkOrigin, padUnlock, updatePadText);

  // Create new pad
  router.post('/', publicPadCreateLimiter, checkOrigin, async (req, res, next) => {
    try {
      const pad = await padService.createPad(req.userId);
      res.json({ id: pad.id, text: '', textVersion: 0, hasPassword: false, ownerUserId: pad.ownerUserId });
    } catch (e) { next(e); }
  });

  // Set/change/remove pad password
  router.post('/:id/password', unlockLimiter, checkOrigin, async (req, res, next) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
      const unlockToken = req.headers['x-pad-token'];
      const result = await padService.setPassword(
        req.userId, isAdmin(req), padId,
        req.body.password, req.body.currentPassword, unlockToken
      );
      res.json(result);
    } catch (e) { next(e); }
  });

  // Delete pad
  router.delete('/:id', checkOrigin, padUnlock, async (req, res, next) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');

      const result = await padService.deletePad(req.userId, isAdmin(req), padId);

      // Disconnect AFTER successful deletion
      const { getPadClients } = require('../ws/connections');
      const deletedClients = getPadClients(padId);
      if (deletedClients) {
        for (const ws of Array.from(deletedClients)) {
          try { ws.close(4404, 'Pad deleted'); } catch {}
        }
      }

      res.json(result);
    } catch (e) { next(e); }
  });

  // Unlock pad (verify password)
  router.post('/:id/unlock', unlockLimiter, checkOrigin, async (req, res, next) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
      await padService.getPad(req.userId, padId); // access check
      const result = await padService.unlockPad(padId, req.body.password);
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = createRouter;
