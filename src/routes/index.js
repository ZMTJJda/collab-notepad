'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin } = require('../middlewares/security');

const createAuthRouter = require('./auth');
const createPadsRouter = require('./pads');
const createFilesRouter = require('./files');
const createInvitationsRouter = require('./invitations');
const createConvertRouter = require('./convert');
const createHealthRouter = require('./health');

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many uploads.' },
});

function mountRoutes(app, services, getServerPort) {
  const { db, padService, fileService, inviteService, convertService } = services;

  app.use('/api/auth', createAuthRouter(db));

  // Global state endpoint (mounted at /api, not /api/pads)
  app.get('/api/state', async (req, res, next) => {
    try {
      const state = await padService.getState(req.userId);
      res.json(state);
    } catch (e) {
      if (res.headersSent) return;
      next(e);
    }
  });

  // Upload endpoint (mounted at /api/upload, not /api/files/upload)
  app.post('/api/upload', uploadLimiter, checkOrigin, async (req, res, next) => {
    try {
      await fileService.upload(req, res);
    } catch (e) {
      if (res.headersSent) return;
      next(e);
    }
  });

  app.use('/api/pads', createPadsRouter(padService));
  app.use('/api/files', createFilesRouter(fileService, padService));
  app.use('/api/invitations', createInvitationsRouter(inviteService));
  app.use('/api/convert', createConvertRouter(convertService, padService));
  app.use('/api', createHealthRouter(db, getServerPort));
}

module.exports = { mountRoutes };
