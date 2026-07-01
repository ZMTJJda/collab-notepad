'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin, requirePadUnlock } = require('../middlewares/security');

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many convert attempts.' },
});

function createRouter(convertService, padService) {
  const router = express.Router();
  const convertPadUnlock = requirePadUnlock(padService, (req) => {
    const file = convertService.getFileById(req.params.fileId);
    return file ? file.padId : NaN;
  });

  // Get conversion capabilities
  router.get('/capabilities', (req, res) => {
    res.json(convertService.getCapabilities());
  });

  // Convert file to Markdown
  router.post('/:fileId', convertLimiter, checkOrigin, convertPadUnlock, async (req, res, next) => {
    try {
      const result = await convertService.convert(req.userId, req.params.fileId);
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = createRouter;
