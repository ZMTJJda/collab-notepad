'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { JSON_BODY_LIMIT } = require('./config');
const { authenticate } = require('./middlewares/auth');
const errorHandler = require('./middlewares/errorHandler');
const { mountRoutes } = require('./routes');
const logger = require('./utils/logger');

function createApp(services, getServerPort) {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.disable('x-powered-by');

  // Security headers (relaxed CSP for inline SVG favicon)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  // Request logging
  app.use((req, _res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    logger.info(`${req.method} ${req.path} [${ip}]`);
    next();
  });

  // Rate limiting — general API limiter
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api/', generalLimiter);

  // Delete limiters (only count DELETE requests)
  const deleteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    skip: (req) => req.method !== 'DELETE',
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many delete requests.' },
  });
  app.use('/api/pads/', deleteLimiter);
  app.use('/api/files/', deleteLimiter);

  // Body parser
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Authenticate (sets req.userId, never blocks)
  app.use(authenticate);

  // Prevent iOS Safari from caching HTML (ensures fresh CSS/JS refs)
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
  });

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Mount all API routes
  mountRoutes(app, services, getServerPort);

  // Global error handler
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
