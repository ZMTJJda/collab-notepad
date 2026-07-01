'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin } = require('../middlewares/security');
const { requireAuth } = require('../middlewares/auth');
const { UnauthorizedError } = require('../utils/errors');
const { generateUserCode, signSessionToken } = require('../utils/crypto');
const session = require('../auth/session');
const { SESSION_TOKEN_TTL_DAYS, cookieFlags } = require('../config');

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many registration attempts.' },
});

function createRouter(db) {
  const router = express.Router();

  router.post('/register', registerLimiter, checkOrigin, (req, res) => {
    const code = generateUserCode();
    db.users.create({ code, createdAt: Date.now() });

    const requested = Number(req.body?.expiresInDays);
    const expiresInDays = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), SESSION_TOKEN_TTL_DAYS)
      : SESSION_TOKEN_TTL_DAYS;

    const token = signSessionToken(code, expiresInDays);
    res.setHeader('Set-Cookie', `session_token=${token}; ${cookieFlags}; Max-Age=${expiresInDays * 86400}`);
    res.json({ code, token, expiresInDays });
  });

  router.post('/verify', (req, res) => {
    const token = req.body?.token;
    const userId = session.verify(token);
    if (userId && db.users.exists(userId)) {
      res.json({ valid: true, code: userId });
    } else {
      res.json({ valid: false });
    }
  });

  router.get('/me', (req, res, next) => {
    try {
      if (!req.userId) throw UnauthorizedError('Not authenticated');
      res.json({ code: req.userId });
    } catch (e) { next(e); }
  });

  router.post('/logout', checkOrigin, (req, res) => {
    const { parseCookies } = require('../middlewares/auth');
    const cookies = parseCookies(req.headers.cookie || '');
    const cookieToken = cookies['session_token'];
    const headerToken = req.headers['x-session-token'];
    const nowSec = Date.now() / 1000;
    const ttl = SESSION_TOKEN_TTL_DAYS * 86400;

    if (cookieToken) session.revokeToken(cookieToken, nowSec + ttl);
    if (headerToken && typeof headerToken === 'string') session.revokeToken(headerToken, nowSec + ttl);

    res.setHeader('Set-Cookie', `session_token=; ${cookieFlags}; Max-Age=0`);
    res.json({ ok: true });
  });

  return router;
}

module.exports = createRouter;
