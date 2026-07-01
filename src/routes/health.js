'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { getLanIP } = require('../utils/file');

function createRouter(db, getServerPort) {
  const router = express.Router();

  // Health check (before any auth, for Docker healthcheck)
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      pads: db.pads.findAll().length,
      files: db.files.findAll().length,
    });
  });

  // QR code
  router.get('/qrcode', async (req, res, next) => {
    try {
      const port = getServerPort ? getServerPort() : 8000;
      const url = `http://${getLanIP()}:${port}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 200 });
      res.type('image/svg+xml').send(svg);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createRouter;
