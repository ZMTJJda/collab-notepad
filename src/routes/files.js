'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { checkOrigin, requirePadUnlock } = require('../middlewares/security');
const { isAdmin } = require('../middlewares/auth');
const { contentDisposition } = require('../utils/file');
const { BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError } = require('../utils/errors');

const clearFilesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many clear-all attempts.' },
});

function createRouter(fileService, padService) {
  const router = express.Router();
  const filePadUnlock = requirePadUnlock(padService, (req) => {
    const f = fileService.getFileById(req.params.id);
    return f ? f.padId : NaN;
  });

  // Download file
  router.get('/:id', filePadUnlock, async (req, res, next) => {
    try {
      const { file, filepath } = await fileService.downloadFile(req.userId, req.params.id);

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', contentDisposition('attachment', file.originalName));
      res.type(file.mimeType || 'application/octet-stream');
      res.sendFile(filepath, (err) => {
        if (err && err.code === 'ENOENT') {
          if (!res.headersSent) res.status(404).json({ error: 'File not found on disk' });
          return;
        }
        if (err && !res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
      });
    } catch (e) { next(e); }
  });

  // Delete single file
  router.delete('/:id', checkOrigin, filePadUnlock, async (req, res, next) => {
    try {
      const excludeWsId = req.body && req.body._wsId;

      // Legacy public file (no owner): require authentication (401 vs 403)
      const file = fileService.getFileById(req.params.id);
      if (file && !file.ownerUserId && !req.userId && !isAdmin(req)) {
        throw UnauthorizedError('Authentication required');
      }

      const result = await fileService.deleteFile(req.userId, isAdmin(req), req.params.id, excludeWsId);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Clear all files (scoped to current pad)
  const clearPadUnlock = requirePadUnlock(padService, (req) => Number(req.body?.padId));
  router.delete('/', clearFilesLimiter, checkOrigin, clearPadUnlock, async (req, res, next) => {
    try {
      const excludeWsId = req.body && req.body._wsId;
      const padIdRaw = req.body?.padId;
      const targetPadId = Number(padIdRaw);
      if (!Number.isInteger(targetPadId) || targetPadId <= 0) {
        throw BadRequestError('padId required');
      }
      const result = await fileService.clearFiles(req.userId, isAdmin(req), targetPadId, excludeWsId);
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = createRouter;
