'use strict';

const os = require('os');

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx++; }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[idx]}`;
}

function downloadBasename(name, fallback = 'file') {
  return String(name || fallback).replace(/\\/g, '/').split('/').pop().replace(/[\0\r\n]/g, '_') || fallback;
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function contentDisposition(disposition, filename) {
  const name = downloadBasename(filename);
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_').trim() || 'file';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`;
}

module.exports = {
  getLanIP,
  formatBytes,
  downloadBasename,
  encodeRFC5987,
  contentDisposition,
};
