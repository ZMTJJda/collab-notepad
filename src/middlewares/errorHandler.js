'use strict';

const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { formatBytes } = require('../utils/file');
const { MAX_FILE_BYTES } = require('../config');

function errorHandler(err, req, res, next) {
  // 1. If headers already sent, pass to Express default handler
  if (res.headersSent) return next(err);

  // 2. Handle JSON body parser errors
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `File too large (max ${formatBytes(MAX_FILE_BYTES)})` });
  }
  if (err.status >= 400 && err.status < 500) {
    // Don't echo raw err.message — it may contain parser internals
    return res.status(err.status).json({ error: 'Bad request' });
  }

  // 3. Handle expected business errors
  if (err instanceof AppError) {
    logger.warn({ err, req: { method: req.method, url: req.url } }, 'Business Error');
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }

  // 4. Unknown errors: log and return generic message
  logger.error({ err }, 'Unhandled System Error');
  res.status(500).json({ error: 'Internal Server Error', code: 'SYSTEM_ERROR' });
}

module.exports = errorHandler;
