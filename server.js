const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Busboy = require('busboy');
const QRCode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { Worker } = require('worker_threads');

const PORT = Number(process.env.PORT ?? 8000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30000;
const UNLOCK_TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8h (pad unlock bearer window)
const MAX_PADS = 50;
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS ?? 72);
const FILE_TTL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const CONVERT_MAX_BYTES = Number(process.env.CONVERT_MAX_BYTES ?? 10 * 1024 * 1024); // 10MB
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS ?? 60 * 1000); // 60s

// Supported extensions for Markdown conversion (single source of truth)
const CONVERTIBLE_EXTS = [
  'pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'log',
  'html', 'htm', 'json', 'xml', 'yaml', 'yml',
  'jpg', 'jpeg', 'png', 'gif',
];

// Feature flags for conversion capabilities
const CONVERT_FEATURES = {
  pptx: true,
  imageMetadata: true,
  imageCaption: false,
  ocr: false,
};

const MAX_PASSWORD_LENGTH = 1024; // Cap scrypt input to prevent event-loop blocking
const MAX_WS_CONNECTIONS = 1000;  // Hard ceiling to protect memory/heartbeat

// --- Session & Auth ---
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || (isProduction
  ? (() => { throw new Error('SESSION_SECRET env var is required in production'); })()
  : crypto.randomBytes(32).toString('hex'));
const cookieFlags = isProduction
  ? 'HttpOnly; SameSite=Strict; Path=/; Secure'
  : 'HttpOnly; SameSite=Strict; Path=/';
const SESSION_TOKEN_TTL_DAYS = Number(process.env.SESSION_TOKEN_TTL_DAYS ?? 30);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;

fs.mkdirSync(FILES_DIR, { recursive: true });

// --- Helpers ---

function generateId() {
  return crypto.randomBytes(12).toString('base64url');
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

// --- Cookie parser ---

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    try {
      result[key] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      result[key] = pair.slice(idx + 1).trim();
    }
  }
  return result;
}

// --- Session token ---

function signSessionToken(userId, expiresInDays) {
  const ttl = expiresInDays || SESSION_TOKEN_TTL_DAYS;
  const ts = Math.floor(Date.now() / 1000 + ttl * 86400).toString(36);
  const sig = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${ts}`).digest('hex');
  return `${userId}.${ts}.${sig}`;
}

// Token blocklist for explicit logout / revocation
const revokedTokens = new Map(); // token -> expiresAt (epoch seconds)

function revokeToken(token, expiresAtEpoch) {
  revokedTokens.set(token, expiresAtEpoch);
}

function isTokenRevoked(token) {
  if (!revokedTokens.has(token)) return false;
  if (Date.now() / 1000 > revokedTokens.get(token)) {
    revokedTokens.delete(token); // expired, clean up
    return false;
  }
  return true;
}

// Cleanup revoked tokens every 10 minutes
const revokedCleanupTimer = setInterval(() => {
  const nowSec = Date.now() / 1000;
  for (const [token, exp] of revokedTokens) {
    if (nowSec > exp) revokedTokens.delete(token);
  }
}, 600000);
revokedCleanupTimer.unref?.();

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (isTokenRevoked(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, tsStr, sig] = parts;
  if (!userId || !tsStr || !sig) return null;
  const expiresAt = parseInt(tsStr, 36);
  if (isNaN(expiresAt) || Date.now() / 1000 > expiresAt) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${tsStr}`).digest('hex');
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ? userId : null;
}

// --- Origin check (CSRF) ---

function isPrivateIp(hostname) {
  // Strip IPv6-mapped IPv4 prefix (e.g. ::ffff:192.168.1.1)
  hostname = hostname.replace(/^::ffff:/i, '');
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // IPv6 unique local (fc00::/7) and link-local (fe80::/10)
  if (/^fc[0-9a-f]/i.test(hostname) || /^fe80:/i.test(hostname)) return true;
  return false;
}

function isAllowedOrigin(origin) {
  // No Origin header usually means a non-browser client; allow it because such
  // clients can set arbitrary headers anyway and are not a CSRF threat.
  if (!origin) return true;
  // Explicit "Origin: null" comes from file://, data://, or sandboxed contexts
  // and must not be treated as same-origin.
  if (origin === 'null') return false;
  if (origin === PUBLIC_ORIGIN) return true; // Exact match
  try {
    const host = new URL(origin).hostname;
    // Always allow private/LAN IPs (RFC 1918 / IPv6 ULA & link-local) so mobile
    // and LAN clients work even when PUBLIC_ORIGIN is set to a domain name.
    if (isPrivateIp(host)) return true;
  } catch {}
  return false;
}

function extractOriginFromReferer(referer) {
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

function requireOrigin(req, res, next) {
  // Safe methods (GET/HEAD/OPTIONS) can proceed without an Origin header.
  // State-changing methods must provide a valid Origin header.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const origin = req.headers.origin;
  if (origin) {
    // Origin present — validate directly
    if (isAllowedOrigin(origin)) return next();
  } else {
    // No Origin header — fall back to Referer (e.g. form submissions, non-browser clients)
    const refererOrigin = extractOriginFromReferer(req.headers.referer);
    if (refererOrigin && isAllowedOrigin(refererOrigin)) return next();
    // Neither Origin nor valid Referer — allow only same-origin non-browser requests
    // (curl, scripts, etc. that share the session cookie but never send Origin/Referer)
    if (!refererOrigin) return next();
  }
  return res.status(403).json({ error: 'Invalid origin' });
}

// --- Admin check ---

function isAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return false;
  const provided = req.headers['x-admin-token'] || '';
  if (provided.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(adminToken));
}

// --- Password helpers ---

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    if (typeof password !== 'string' || password.length === 0) return resolve(null);
    if (password.length > MAX_PASSWORD_LENGTH) password = password.slice(0, MAX_PASSWORD_LENGTH);
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (!stored || typeof stored !== 'string' || typeof password !== 'string') return resolve(false);
    if (password.length > MAX_PASSWORD_LENGTH) password = password.slice(0, MAX_PASSWORD_LENGTH);
    const parts = stored.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
    try {
      const salt = Buffer.from(parts[1], 'hex');
      const hash = Buffer.from(parts[2], 'hex');
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(hash, derivedKey));
      });
    } catch {
      resolve(false);
    }
  });
}

// --- Unlock token store ---

const unlockTokens = new Map(); // token -> { padId, expires }

function createUnlockToken(padId) {
  const token = generateId() + generateId();
  unlockTokens.set(token, { padId, expires: Date.now() + UNLOCK_TOKEN_TTL_MS });
  return token;
}

function isValidUnlockToken(token, padId) {
  if (!token) return false;
  const entry = unlockTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expires) {
    unlockTokens.delete(token);
    return false;
  }
  return entry.padId === padId;
}

// Read per-pad unlock token from header (HTTP) or query string (downloads / WS).
function getRequestPadToken(req) {
  return req.headers['x-pad-token'] || req.query?.padToken || null;
}

// Cleanup expired tokens every 10 minutes
const unlockCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of unlockTokens) {
    if (now > entry.expires) unlockTokens.delete(token);
  }
}, 600000);
unlockCleanupTimer.unref?.();

// --- Store ---

let store = { pads: [], files: [], users: [], inviteTokens: [], accessGrants: [], revokedTokens: {} };
const userCodes = new Set(); // Fast lookup mirror of store.users[].code

function migrateStore(raw) {
  // Migrate old single-pad format → multi-pad
  if (!raw.pads && raw.text !== undefined) {
    const oldText = raw.text || '';
    const oldVersion = Number.isInteger(raw.textVersion) ? raw.textVersion : 0;
    raw = {
      pads: [{
        id: 1,
        text: oldText,
        textVersion: oldVersion,
        password: null,
        createdAt: Date.now(),
        ownerUserId: null,
        creatorCode: null,
      }],
      files: raw.files || [],
    };
    console.log('Migrated old single-pad store to multi-pad format (pad #1)');
  }

  if (!Array.isArray(raw.pads)) raw.pads = [];
  if (raw.pads.length === 0) {
    raw.pads.push({ id: 1, text: '', textVersion: 0, password: null, createdAt: Date.now(), ownerUserId: null, creatorCode: null });
  }
  if (!raw.files) raw.files = [];

  // Migrate: add identity fields if missing
  if (!Array.isArray(raw.users)) raw.users = [];
  if (!Array.isArray(raw.inviteTokens)) raw.inviteTokens = [];
  if (!Array.isArray(raw.accessGrants)) raw.accessGrants = [];
  for (const pad of raw.pads) {
    if (!('ownerUserId' in pad)) pad.ownerUserId = null;
    if (!('creatorCode' in pad)) pad.creatorCode = null;
  }
  for (const file of raw.files) {
    if (!('ownerUserId' in file)) file.ownerUserId = null;
    if (!('padId' in file)) file.padId = raw.pads[0]?.id || 1;
  }

  return raw;
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store:', e.message);
    // Backup corrupted file for manual recovery
    try {
      const backupName = `${STORE_FILE}.bak.${Date.now()}`;
      fs.copyFileSync(STORE_FILE, backupName);
      console.error(`  -> backed up to ${backupName}`);
    } catch {}
  }

  // Load revoked tokens from persisted store (prune expired on load)
  const persistedRevoked = store.revokedTokens || {};
  const now = Date.now() / 1000;
  for (const [token, expiresAt] of Object.entries(persistedRevoked)) {
    if (expiresAt > now) revokedTokens.set(token, expiresAt);
  }

  store = migrateStore(store);
  // Rebuild userCodes lookup after loading store
  for (const u of store.users) userCodes.add(u.code);
}

function writeStoreAtomic() {
  // Persist revoked tokens into store before writing
  store.revokedTokens = Object.fromEntries(revokedTokens);
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch {}
}

let saveTimeout;
function saveStore() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try { writeStoreAtomic(); }
    catch (e) { console.error('Failed to save store:', e.message); }
  }, 200);
}

function flushStore() {
  clearTimeout(saveTimeout);
  try { writeStoreAtomic(); }
  catch (e) { console.error('Failed to flush store:', e.message); }
}

loadStore();

// --- File TTL cleanup ---

function cleanupExpiredFiles() {
  const ttlMs = FILE_TTL_HOURS * 3600000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const now = Date.now();
  const expired = store.files.filter(f => now - (f.createdAt || 0) > ttlMs);
  if (expired.length === 0) return;
  for (const file of expired) {
    try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  }
  const expiredIds = new Set(expired.map(f => f.id));
  store.files = store.files.filter(f => !expiredIds.has(f.id));
  // Sync write: TTL cleanup is rare (hourly); don't risk losing deletions
  // if the process exits within the 200ms saveStore debounce window.
  flushStore();
  // Notify online clients so their file lists update without waiting for a refresh
  for (const file of expired) {
    broadcastToPad(file.padId || store.pads[0]?.id || 1, { type: 'file-deleted', fileId: file.id });
  }
  console.log(`  Cleaned up ${expired.length} expired file(s) (TTL=${FILE_TTL_HOURS}h)`);
}

const fileTtlTimer = setInterval(cleanupExpiredFiles, FILE_TTL_CHECK_INTERVAL_MS);
fileTtlTimer.unref?.();

// --- User identity ---

function generateUserCode() {
  return crypto.randomBytes(6).toString('base64url'); // 8 chars
}

function generateInviteToken() {
  return crypto.randomBytes(16).toString('base64url'); // 22 chars, 128 bit
}

// --- Access control ---

function hasAccessGrant(grantorCode, granteeCode) {
  return store.accessGrants.some(
    g => g.grantorCode === grantorCode && g.granteeCode === granteeCode
  );
}

function canAccessPad(userId, pad) {
  if (!pad.ownerUserId) return true; // public pad
  if (!userId) return false;
  if (pad.ownerUserId === userId) return true; // owner
  return hasAccessGrant(pad.ownerUserId, userId); // invited
}

function canAccessFile(userId, file) {
  if (!file.ownerUserId) return true; // public file
  if (!userId) return false;
  if (file.ownerUserId === userId) return true;
  // Check if user has access to the pad this file belongs to
  const pad = findPad(file.padId);
  if (pad) return canAccessPad(userId, pad);
  return false;
}

function resolveFileOwner(req, pad) {
  // In invited pad, files belong to the pad owner, not the uploader
  if (pad && pad.ownerUserId) return pad.ownerUserId;
  return req.userId || null;
}

function canManagePad(req, pad) {
  // Private pad: owner or admin
  if (pad.ownerUserId) {
    return req.userId === pad.ownerUserId || isAdmin(req);
  }
  // Public pad with creator: creator or admin
  if (pad.creatorCode) {
    return req.userId === pad.creatorCode || isAdmin(req);
  }
  // Legacy pad (creatorCode=null): admin only
  return isAdmin(req);
}

// --- Pad helpers ---

function findPad(id) {
  return store.pads.find(p => p.id === id);
}

function padMeta(pad) {
  return {
    id: pad.id,
    hasPassword: !!pad.password,
    createdAt: pad.createdAt,
    ownerUserId: pad.ownerUserId || null,
  };
}

// --- Express ---

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
  console.log(`  ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path} [${ip}]`);
  next();
});

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', generalLimiter);

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests.' },
});

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many unlock attempts. Please try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many registration attempts.' },
});

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

const publicPadCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  skip: (req) => !!req.userId,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many public pad creations.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many uploads.' },
});

const clearFilesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many clear-all attempts.' },
});

const deleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  skip: (req) => req.method !== 'DELETE',
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many delete requests.' },
});

app.use('/api/pads/', deleteLimiter); // only counts DELETEs on /api/pads/*
app.use('/api/files/', deleteLimiter); // only counts DELETEs on /api/files/*

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many convert attempts.' },
});

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Authenticate middleware (sets req.userId, never blocks)
app.use((req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.session_token || req.headers['x-session-token'] || null;
  const userId = verifySessionToken(token);
  req.userId = (userId && userCodes.has(userId)) ? userId : null;
  next();
});

// Prevent iOS Safari from caching HTML (ensures fresh CSS/JS refs)
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function getServerPort() {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : PORT;
}

function getNetworkUrl() {
  return `http://${getLanIP()}:${getServerPort()}`;
}

// --- Health check (before any auth, for Docker healthcheck) ---
// authenticate middleware runs before this but only sets req.userId, never blocks

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    pads: store.pads.length,
    files: store.files.length,
  });
});

// QR code
app.get('/api/qrcode', async (_req, res, next) => {
  try {
    const svg = await QRCode.toString(getNetworkUrl(), { type: 'svg', margin: 2, width: 200 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    next(err);
  }
});

// --- Auth API ---

app.post('/api/auth/register', registerLimiter, requireOrigin, (req, res) => {
  const code = generateUserCode();
  store.users.push({ code, createdAt: Date.now() });
  userCodes.add(code);
  saveStore();
  const requested = Number(req.body?.expiresInDays);
  const expiresInDays = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), SESSION_TOKEN_TTL_DAYS)
    : SESSION_TOKEN_TTL_DAYS;
  const token = signSessionToken(code, expiresInDays);
  res.setHeader('Set-Cookie', `session_token=${token}; ${cookieFlags}; Max-Age=${expiresInDays * 86400}`);
  res.json({ code, token, expiresInDays });
});

app.post('/api/auth/verify', (req, res) => {
  const token = req.body?.token;
  const userId = verifySessionToken(token);
  if (userId && userCodes.has(userId)) {
    res.json({ valid: true, code: userId });
  } else {
    res.json({ valid: false });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ code: req.userId });
});

app.post('/api/auth/logout', requireOrigin, (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const cookieToken = cookies['session_token'];
  const headerToken = req.headers['x-session-token'];
  const nowSec = Date.now() / 1000;
  const ttl = SESSION_TOKEN_TTL_DAYS * 86400;
  if (cookieToken) revokeToken(cookieToken, nowSec + ttl);
  if (headerToken && typeof headerToken === 'string') revokeToken(headerToken, nowSec + ttl);
  res.setHeader('Set-Cookie', `session_token=; ${cookieFlags}; Max-Age=0`);
  res.json({ ok: true });
});

// --- Invitation API ---

app.post('/api/invitations', inviteCreateLimiter, requireOrigin, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const rawMaxUses = Number(req.body?.maxUses);
  const maxUses = Number.isFinite(rawMaxUses) && rawMaxUses >= 0 ? Math.floor(rawMaxUses) : 1;
  const expiresInHours = Number(req.body?.expiresInHours) || 0;
  const token = generateInviteToken();
  store.inviteTokens.push({
    token,
    creatorCode: req.userId,
    maxUses: maxUses > 0 ? maxUses : 0, // 0 = unlimited
    useCount: 0,
    expiresAt: expiresInHours > 0 ? Date.now() + expiresInHours * 3600000 : null,
    createdAt: Date.now(),
  });
  saveStore();
  res.json({ token, maxUses, expiresInHours: expiresInHours || null });
});

app.post('/api/invitations/redeem', redeemLimiter, requireOrigin, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const invite = store.inviteTokens.find(t => t.token === token);
  if (!invite) return res.status(404).json({ error: 'Invalid invitation token' });
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    return res.status(410).json({ error: 'Invitation expired' });
  }
  if (invite.maxUses > 0 && invite.useCount >= invite.maxUses) {
    return res.status(410).json({ error: 'Invitation fully redeemed' });
  }
  if (invite.creatorCode === req.userId) {
    return res.status(400).json({ error: 'Cannot redeem your own invitation' });
  }
  if (hasAccessGrant(invite.creatorCode, req.userId)) {
    return res.status(409).json({ error: 'Already have access from this inviter' });
  }

  store.accessGrants.push({
    inviteToken: token,
    grantorCode: invite.creatorCode,
    granteeCode: req.userId,
    grantedAt: Date.now(),
  });
  invite.useCount += 1;
  saveStore();
  res.json({ ok: true, grantorCode: invite.creatorCode });
});

app.get('/api/invitations', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const created = store.inviteTokens.filter(t => t.creatorCode === req.userId);
  const received = store.accessGrants.filter(g => g.granteeCode === req.userId);
  res.json({ created, received });
});

app.delete('/api/invitations/:token', requireOrigin, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const idx = store.inviteTokens.findIndex(t => t.token === req.params.token);
  if (idx === -1) return res.status(404).json({ error: 'Token not found' });
  if (store.inviteTokens[idx].creatorCode !== req.userId) {
    return res.status(403).json({ error: 'Not your invitation' });
  }
  const deletedToken = req.params.token;
  store.inviteTokens.splice(idx, 1);
  // Clean up access grants created via this invitation to prevent unbounded growth
  const grantsBefore = store.accessGrants.length;
  store.accessGrants = store.accessGrants.filter(g => g.inviteToken !== deletedToken);
  const revokedGrants = grantsBefore - store.accessGrants.length;
  saveStore();
  res.json({ ok: true, revokedGrants });
});

// --- Pad API ---

// Get global state (pad list metadata + files)
app.get('/api/state', (req, res) => {
  const accessiblePads = store.pads.filter(p => canAccessPad(req.userId, p));
  const accessibleFiles = store.files.filter(f => canAccessFile(req.userId, f));
  res.json({
    pads: accessiblePads.map(padMeta),
    files: accessibleFiles,
    userCode: req.userId || null,
  });
});

// Get pad content
app.get('/api/pads/:id', (req, res) => {
  const padId = Number(req.params.id);
  if (!Number.isInteger(padId) || padId <= 0) return res.status(400).json({ error: 'Invalid pad ID' });
  const pad = findPad(padId);
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  if (!canAccessPad(req.userId, pad)) return res.status(403).json({ error: 'Access denied' });

  if (pad.password) {
    const token = req.headers['x-pad-token'];
    if (!isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
  }

  res.json({ id: pad.id, text: pad.text, textVersion: pad.textVersion, hasPassword: !!pad.password });
});

// Update pad text (PUT for normal sync; POST alias for navigator.sendBeacon on unload)
function updatePadText(req, res) {
  const padId = Number(req.params.id);
  if (!Number.isInteger(padId) || padId <= 0) return res.status(400).json({ error: 'Invalid pad ID' });
  const pad = findPad(padId);
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  if (!canAccessPad(req.userId, pad)) return res.status(403).json({ error: 'Access denied' });

  if (pad.password) {
    const token = getRequestPadToken(req);
    if (!isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
  }

  pad.text = typeof req.body.text === 'string' ? req.body.text : '';
  pad.textVersion += 1;
  saveStore();
  broadcastToPad(pad.id, {
    type: 'text-update',
    padId: pad.id,
    text: pad.text,
    textVersion: pad.textVersion,
  }, req.body._wsId);
  res.json({ ok: true, textVersion: pad.textVersion });
}
app.put('/api/pads/:id/text', writeLimiter, requireOrigin, updatePadText);
app.post('/api/pads/:id/text', writeLimiter, requireOrigin, updatePadText); // sendBeacon alias

// Create new pad
app.post('/api/pads', publicPadCreateLimiter, requireOrigin, (req, res) => {
  if (store.pads.length >= MAX_PADS) {
    return res.status(400).json({ error: `Maximum ${MAX_PADS} pads reached` });
  }
  // Reuse the smallest available ID; this keeps IDs compact after deletions
  const usedIds = new Set(store.pads.map(p => p.id));
  let id = 1;
  while (usedIds.has(id)) id++;
  const pad = {
    id,
    text: '',
    textVersion: 0,
    password: null,
    createdAt: Date.now(),
    ownerUserId: req.userId || null,
    creatorCode: req.userId || null,
  };
  store.pads.push(pad);
  flushStore(); // Critical: pad creation must not be lost on crash
  broadcastToAll({ type: 'pad-created', pad: padMeta(pad) });
  res.json({ id, text: '', textVersion: 0, hasPassword: false, ownerUserId: pad.ownerUserId });
});

// Set/change/remove pad password
app.post('/api/pads/:id/password', unlockLimiter, requireOrigin, async (req, res) => {
  try {
    const padId = Number(req.params.id);
    if (!Number.isInteger(padId) || padId <= 0) return res.status(400).json({ error: 'Invalid pad ID' });
    const pad = findPad(padId);
    if (!pad) return res.status(404).json({ error: 'Pad not found' });
    // Permission: own pad → OK; public pad → creator/Admin; legacy → Admin (fallback any auth)
    if (!canManagePad(req, pad)) {
      return res.status(pad.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
    }

    // If pad already has a password, require current password or unlock token
    if (pad.password) {
      const token = req.headers['x-pad-token'];
      if (!isValidUnlockToken(token, pad.id)) {
        const currentPassword = req.body.currentPassword;
        if (!currentPassword || !(await verifyPassword(currentPassword, pad.password))) {
          return res.status(403).json({ error: 'Current password incorrect' });
        }
      }
    }

    const newPassword = req.body.password;
    if (newPassword && typeof newPassword === 'string' && newPassword.length > 0) {
      pad.password = await hashPassword(newPassword);
    } else {
      pad.password = null;
    }
    if (newPassword && !pad.password) {
      return res.status(400).json({ error: 'Invalid password' });
    }
    flushStore(); // Critical: password change must persist immediately

    // Invalidate old unlock tokens for this pad
    for (const [token, entry] of unlockTokens) {
      if (entry.padId === pad.id) unlockTokens.delete(token);
    }

    // Issue new unlock token if password was set (so caller stays unlocked)
    let newToken = null;
    if (pad.password) {
      newToken = createUnlockToken(pad.id);
    }

    broadcastToAll({ type: 'pad-updated', pad: padMeta(pad) });
    res.json({ ok: true, hasPassword: !!pad.password, token: newToken });
  } catch (e) {
    console.error('Password change error:', e.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process password change' });
    }
  }
});

// Delete pad
app.delete('/api/pads/:id', requireOrigin, (req, res) => {
  const padId = Number(req.params.id);
  if (!Number.isInteger(padId) || padId <= 0) return res.status(400).json({ error: 'Invalid pad ID' });
  const pad = findPad(padId);
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  // Permission: own pad → OK; public pad → creator/Admin; legacy → Admin (fallback any auth)
  if (!canManagePad(req, pad)) {
    return res.status(pad.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
  }

  if (pad.password) {
    const token = req.headers['x-pad-token'];
    if (!isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
  }

  // Don't allow deleting the last pad
  if (store.pads.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last pad' });
  }

  // Invalidate unlock tokens for this pad
  for (const [token, entry] of unlockTokens) {
    if (entry.padId === padId) unlockTokens.delete(token);
  }

  // Delete all files belonging to this pad so they don't become orphaned
  const filesToDelete = store.files.filter(f => (f.padId || 1) === padId);
  for (const file of filesToDelete) {
    try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  }
  const deletedFileIds = filesToDelete.map(f => f.id);
  store.files = store.files.filter(f => (f.padId || 1) !== padId);

  store.pads = store.pads.filter(p => p.id !== padId);
  flushStore(); // Critical: pad deletion must not be lost on crash
  broadcastToAll({ type: 'pad-deleted', padId });
  for (const fileId of deletedFileIds) {
    broadcastToPad(padId, { type: 'file-deleted', fileId });
  }
  // Disconnect anyone still connected to the deleted pad so they don't keep
  // sending/receiving on a ghost pad.
  const deletedClients = padClients.get(padId);
  if (deletedClients) {
    for (const ws of Array.from(deletedClients)) {
      try { ws.close(4404, 'Pad deleted'); } catch {}
    }
  }
  res.json({ ok: true, deletedFiles: deletedFileIds.length });
});

// Unlock pad (verify password)
app.post('/api/pads/:id/unlock', unlockLimiter, requireOrigin, async (req, res) => {
  const padId = Number(req.params.id);
  if (!Number.isInteger(padId) || padId <= 0) return res.status(400).json({ error: 'Invalid pad ID' });
  const pad = findPad(padId);
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  if (!canAccessPad(req.userId, pad)) return res.status(403).json({ error: 'Access denied' });

  if (!pad.password) {
    return res.json({ ok: true, token: null });
  }

  const password = req.body.password;
  if (!password || !(await verifyPassword(password, pad.password))) {
    return res.status(403).json({ error: 'Wrong password' });
  }

  const token = createUnlockToken(pad.id);
  res.json({ ok: true, token });
});

// --- File API ---

// Upload file
app.post('/api/upload', uploadLimiter, requireOrigin, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'multipart/form-data required' });
  }

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        fileSize: MAX_FILE_BYTES,
        fields: 8,
        parts: 9,
      },
    });
  } catch {
    return res.status(400).json({ error: 'Invalid multipart form data' });
  }

  let excludeWsId = null;
  let padIdField = null;
  let fileInfo = null;
  let fileSeen = false;
  let fileLimitReached = false;
  let finished = false;
  let aborted = false;
  let filePath = null;
  let fileWritePromise = null;
  let writeStream = null;
  let busboyFinished = false; // Tracks whether busboy finished normally
  let uploadAccessDenied = false;

  function cleanupPartialFile() {
    if (writeStream) {
      writeStream.destroy();
      writeStream = null;
    }
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    filePath = null;
  }

  function fail(status, error) {
    if (finished) return;
    finished = true;
    cleanupPartialFile();
    res.status(status).json({ error });
  }

  // req.on('aborted') is deprecated in Node.js 14+; 'close' fires for all
  // disconnects (including TCP RST). We distinguish normal completion
  // (busboy finish → res.end) from premature closes via busboyFinished.
  req.on('close', () => {
    if (!finished && req.destroyed && !busboyFinished) {
      aborted = true;
      cleanupPartialFile();
    }
  });

  busboy.on('field', (name, value) => {
    if (name === '_wsId') excludeWsId = String(value || '');
    if (name === 'padId') padIdField = Number(value) || null;
  });

  busboy.on('filesLimit', () => {
    fail(400, 'Only one file allowed');
  });

  busboy.on('partsLimit', () => {
    fail(400, 'Too many form parts');
  });

  busboy.on('file', (name, file, info) => {
    if (name !== 'file') {
      file.resume();
      return;
    }
    if (fileSeen) {
      file.resume();
      return;
    }

    fileSeen = true;

    const originalName = downloadBasename(info.filename, '');
    if (!originalName) {
      file.resume();
      return;
    }

    const id = generateId();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const filename = `${id}_${safeName}`;
    filePath = path.join(FILES_DIR, filename);

    // Early access check: only safe to short-circuit when padId field has
    // already arrived (field order is not guaranteed by multipart). The
    // authoritative check runs at finish time.
    if (padIdField !== null) {
      const earlyPad = findPad(padIdField);
      if (earlyPad && !canAccessPad(req.userId, earlyPad)) {
        uploadAccessDenied = true;
        file.resume();
        return;
      }
    }

    fileInfo = {
      id,
      filename,
      originalName,
      size: 0,
      mimeType: (info.mimeType || 'application/octet-stream').toLowerCase(),
      createdAt: Date.now(),
      ownerUserId: null, // set after busboy finishes
      padId: 1,          // set after busboy finishes
    };

    writeStream = fs.createWriteStream(filePath, { flags: 'wx' });
    // Rejections here are from busboy errors (fail() already called) — swallow
    // silently. Genuine disk errors (ENOSPC/EACCES) reject the inner promise and
    // are caught by the try/catch in the busboy 'finish' handler below.
    fileWritePromise = new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      file.on('error', reject);
    });
    fileWritePromise.catch(() => {}); // Prevent unhandled rejection on busboy errors

    file.on('limit', () => {
      fileLimitReached = true;
      if (writeStream) writeStream.destroy(new Error('File too large'));
    });

    file.pipe(writeStream);

    file.on('data', (chunk) => {
      if (!fileInfo) return;
      fileInfo.size += chunk.length;
    });
  });

  busboy.on('error', () => {
    fail(400, 'Invalid multipart form data');
  });

  busboy.on('finish', async () => {
    busboyFinished = true; // Normal completion, do not treat as abort
    if (finished || aborted) return;
    if (uploadAccessDenied) {
      finished = true;
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fileSeen || !fileInfo) {
      return fail(400, 'file required');
    }
    if (fileLimitReached) {
      return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
    }

    try {
      await fileWritePromise;
    } catch (err) {
      if (finished || aborted) return;
      if (fileLimitReached) {
        return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
      }
      console.error('Failed to save upload:', err);
      return fail(500, 'Failed to save upload');
    }

    if (finished || aborted) return;

    // Resolve file ownership and pad association
    const targetPadId = padIdField || store.pads[0]?.id || 1;
    const targetPad = findPad(targetPadId);
    if (!targetPad) {
      return fail(404, 'Pad not found');
    }
    // Authoritative access check: padId field may have arrived after the file
    // part, so the early check in the 'file' handler could have missed it.
    if (!canAccessPad(req.userId, targetPad)) {
      return fail(403, 'Access denied');
    }
    if (targetPad.password && !isValidUnlockToken(getRequestPadToken(req), targetPad.id)) {
      return fail(403, 'Pad locked');
    }
    fileInfo.ownerUserId = resolveFileOwner(req, targetPad);
    fileInfo.padId = targetPadId;

    store.files.unshift(fileInfo);
    flushStore(); // Ensure file metadata persists immediately
    broadcastToPad(fileInfo.padId, { type: 'file-added', file: fileInfo }, excludeWsId);
    finished = true;
    res.json(fileInfo);
  });

  req.pipe(busboy);
});

// Download file
app.get('/api/files/:id', (req, res) => {
  const file = store.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!canAccessFile(req.userId, file)) return res.status(403).json({ error: 'File not found' }); // don't leak existence
  const filePad = findPad(file.padId);
  if (filePad?.password && !isValidUnlockToken(getRequestPadToken(req), filePad.id)) {
    return res.status(403).json({ error: 'Pad locked', hasPassword: true });
  }
  const filepath = path.join(FILES_DIR, file.filename);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition('attachment', file.originalName));
  res.type(file.mimeType || 'application/octet-stream');
  res.sendFile(filepath, (err) => {
    if (err && err.code === 'ENOENT') {
      // File vanished between metadata check and read; sendFile may have partially
      // flushed headers, so we can't reliably change status — log and end.
      console.error(`File missing on disk: ${file.filename}`);
      if (!res.headersSent) res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    if (err && !res.headersSent) {
      console.error('Download error:', err.message);
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

// --- Markdown conversion ---

// In-flight conversion locks: prevents concurrent convert requests for the
// same source file from both passing the 409 check and producing duplicate .md
const convertingFiles = new Set();
const MAX_CONCURRENT_CONVERTS = 3;
let activeConverts = 0;

// Run parsers in a worker thread so a timeout can hard-terminate conversion
// (worker.terminate()) instead of leaving it burning CPU on the main loop.
// Worker is spawned per-request and terminated on completion/timeout.
// resourceLimits caps the worker heap so a malicious/malformed document that
// triggers runaway allocation in a parser can't OOM the main process.
function convertInWorker(buffer, ext, mimeType, originalName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'convert-worker.js'), {
      workerData: { buffer, ext, mimeType, originalName },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(new Error('CONVERT_TIMEOUT'));
    }, timeoutMs);

    worker.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (msg.ok) resolve(msg.markdown);
      else {
        const err = new Error(msg.error || 'Conversion failed');
        err.code = msg.code || 'CONVERSION_FAILED';
        reject(err);
      }
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {}); // ensure worker is killed on error
      reject(err);
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      } else {
        reject(new Error('Conversion completed without producing output'));
      }
    });
  });
}

// Convert file to Markdown
app.get('/api/convert/capabilities', (req, res) => {
  res.json({
    extensions: CONVERTIBLE_EXTS,
    maxBytes: CONVERT_MAX_BYTES,
    timeoutMs: CONVERT_TIMEOUT_MS,
    features: CONVERT_FEATURES,
  });
});

app.post('/api/convert/:fileId', convertLimiter, requireOrigin, async (req, res) => {
  if (activeConverts >= MAX_CONCURRENT_CONVERTS) {
    return res.status(503).json({ error: 'Too many conversions in progress, try again shortly' });
  }
  activeConverts++; // increment immediately so the check is atomic
  let mdDiskPath = null;
  try {
    const file = store.files.find(f => f.id === req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!canAccessFile(req.userId, file)) return res.status(403).json({ error: 'File not found' }); // don't leak existence
    const filePad = findPad(file.padId);
    if (filePad?.password && !isValidUnlockToken(getRequestPadToken(req), filePad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
    if (file.originalName.toLowerCase().endsWith('.md')) {
      return res.status(400).json({ error: 'Markdown files cannot be converted' });
    }

    const filepath = path.join(FILES_DIR, file.filename);
    let stat;
    try {
      stat = await fs.promises.stat(filepath);
    } catch {
      return res.status(404).json({ error: 'File not found on disk' });
    }
    if (stat.size > CONVERT_MAX_BYTES) {
      return res.status(413).json({ error: 'File too large to convert' });
    }

    // Check if already converted
    const baseName = file.originalName.replace(/\.[^.]+$/, '');
    const mdOriginalName = `${baseName}.md`;
    if (store.files.some(f => f.originalName === mdOriginalName && f.padId === file.padId)) {
      return res.status(409).json({ error: 'Already converted' });
    }

    // Prevent concurrent converts of the same file from racing past the 409 check
    if (convertingFiles.has(req.params.fileId)) {
      return res.status(409).json({ error: 'Conversion already in progress' });
    }
    convertingFiles.add(req.params.fileId);

    const ext = path.extname(file.originalName).toLowerCase();
    let markdown;
    try {
      const buffer = await fs.promises.readFile(filepath);
      markdown = await convertInWorker(buffer, ext, file.mimeType, file.originalName, CONVERT_TIMEOUT_MS);
    } catch (e) {
      if (e.message === 'CONVERT_TIMEOUT') {
        return res.status(504).json({ error: 'Conversion timed out' });
      }
      if (e.message === 'UNSUPPORTED_FILE_TYPE' || e.code === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(415).json({ error: 'Unsupported file type' });
      }
      if (e.code === 'CONVERSION_INPUT_ERROR') {
        return res.status(422).json({ error: 'File could not be converted' });
      }
      console.error('Convert error:', e.message);
      return res.status(500).json({ error: 'Conversion failed' });
    }

    const mdId = generateId();
    const safeBaseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const safeMdName = `${safeBaseName}.md`;
    const mdDiskName = `${mdId}_${safeMdName}`;
    mdDiskPath = path.join(FILES_DIR, mdDiskName);

    await fs.promises.writeFile(mdDiskPath, markdown, 'utf8');

    const targetPad = findPad(file.padId);
    const mdFile = {
      id: mdId,
      filename: mdDiskName,
      originalName: mdOriginalName,
      size: Buffer.byteLength(markdown, 'utf8'),
      mimeType: 'text/markdown',
      createdAt: Date.now(),
      ownerUserId: resolveFileOwner(req, targetPad),
      padId: file.padId,
    };

    // 1) In-memory state: add converted first, keep original until flush succeeds
    store.files.unshift(mdFile);

    // 2) Persist metadata BEFORE deleting the original file on disk.
    //    A crash here leaves the original on disk (recoverable), and the new
    //    file is already in the store.
    flushStore(); // Conversion result must persist immediately

    // 3) Now safe to remove the original from store and disk
    const originalIdx = store.files.findIndex(f => f.id === file.id);
    if (originalIdx !== -1) {
      store.files.splice(originalIdx, 1);
    }
    try { fs.unlinkSync(filepath); } catch {}
    flushStore(); // Remove original from store too

    // 4) Notify clients
    broadcastToPad(file.padId, { type: 'file-deleted', fileId: file.id });
    broadcastToPad(mdFile.padId, { type: 'file-added', file: mdFile });
    res.json(mdFile);
  } catch (e) {
    console.error('Unexpected convert error:', e.message);
    if (mdDiskPath) {
      try { fs.unlinkSync(mdDiskPath); } catch {}
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Conversion failed' });
    }
  } finally {
    convertingFiles.delete(req.params.fileId);
    activeConverts--;
  }
});

// Delete single file
app.delete('/api/files/:id', requireOrigin, (req, res) => {
  const excludeWsId = req.body && req.body._wsId;
  const idx = store.files.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'File not found' });
  const file = store.files[idx];
  const pad = findPad(file.padId || store.pads[0]?.id || 1);
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  // Permission: file owner → OK; otherwise pad creator/Admin (legacy fallback: any auth user)
  if (file.ownerUserId) {
    if (req.userId !== file.ownerUserId && !isAdmin(req)) {
      // Not the uploader: check if user can manage the pad
      if (!pad || !canManagePad(req, pad)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }
  } else {
    // Legacy public file (ownerUserId=null): require pad manager or admin
    if (!pad || !canManagePad(req, pad)) {
      return res.status(pad?.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
    }
  }
  if (pad.password && !isValidUnlockToken(getRequestPadToken(req), pad.id)) {
    return res.status(403).json({ error: 'Pad locked', hasPassword: true });
  }
  store.files.splice(idx, 1);
  try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  flushStore(); // File deletion must persist immediately
  broadcastToPad(file.padId || store.pads[0]?.id || 1, { type: 'file-deleted', fileId: file.id }, excludeWsId);
  res.json({ ok: true });
});

// Clear all files (scoped to current pad)
app.delete('/api/files', clearFilesLimiter, requireOrigin, (req, res) => {
  const excludeWsId = req.body && req.body._wsId;
  const padIdRaw = req.body?.padId;
  const targetPadId = Number(padIdRaw);
  if (!Number.isInteger(targetPadId) || targetPadId <= 0) {
    return res.status(400).json({ error: 'padId required' });
  }
  const targetPad = findPad(targetPadId);
  if (!targetPad) return res.status(404).json({ error: 'Pad not found' });

  // Permission: pad manager (owner / creator / admin)
  if (!canManagePad(req, targetPad)) {
    return res.status(targetPad.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
  }

  if (targetPad.password && !isValidUnlockToken(getRequestPadToken(req), targetPad.id)) {
    return res.status(403).json({ error: 'Pad locked', hasPassword: true });
  }

  const toDelete = store.files.filter(f => (f.padId || 1) === targetPadId);
  for (const file of toDelete) {
    try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  }
  const clearedIds = toDelete.map(f => f.id);
  store.files = store.files.filter(f => (f.padId || 1) !== targetPadId);
  flushStore(); // File clear must persist immediately
  for (const id of clearedIds) {
    broadcastToPad(targetPadId, { type: 'file-deleted', fileId: id }, excludeWsId);
  }
  res.json({ ok: true, cleared: clearedIds.length });
});

// Error handler
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `File too large (max ${formatBytes(MAX_FILE_BYTES)})` });
  }
  if (err.status >= 400 && err.status < 500) {
    // Don't echo raw err.message — it may contain parser internals
    return res.status(err.status).json({ error: 'Bad request' });
  }
  console.error('Unexpected error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- HTTP + WebSocket ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const padClients = new Map(); // padId -> Set<ws>
const wsConnectionsPerIp = new Map(); // tracks active WS connections per IP
const MAX_WS_CONNECTIONS_PER_IP = 10;

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress;
}

function getTotalClientCount() {
  let count = 0;
  for (const set of padClients.values()) count += set.size;
  return count;
}

function getPadClientCount(padId) {
  const set = padClients.get(padId);
  return set ? set.size : 0;
}

function broadcastPadOnlineCount(padId) {
  broadcastToPad(padId, { type: 'online-count', count: getPadClientCount(padId) });
}

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  for (const [, padSet] of padClients) {
    for (const ws of padSet) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(msg);
      } catch {
        removeClient(ws);
      }
    }
  }
}

function addClient(ws) {
  if (!padClients.has(ws.padId)) padClients.set(ws.padId, new Set());
  padClients.get(ws.padId).add(ws);
  if (ws.ipAddress) {
    const count = wsConnectionsPerIp.get(ws.ipAddress) || 0;
    wsConnectionsPerIp.set(ws.ipAddress, count + 1);
  }
}

function removeClient(ws) {
  const set = padClients.get(ws.padId);
  if (!set || !set.delete(ws)) return;
  if (set.size === 0) padClients.delete(ws.padId);
  if (ws.ipAddress) {
    const count = wsConnectionsPerIp.get(ws.ipAddress) || 0;
    if (count <= 1) wsConnectionsPerIp.delete(ws.ipAddress);
    else wsConnectionsPerIp.set(ws.ipAddress, count - 1);
  }
  if (ws.padId != null) broadcastPadOnlineCount(ws.padId);
}

wss.on('connection', (ws, req) => {
  // Hard connection ceiling to protect memory and heartbeat CPU
  if (getTotalClientCount() >= MAX_WS_CONNECTIONS) {
    ws.close(1013, 'Server overloaded');
    return;
  }

  // Per-IP connection limit to prevent single-IP pool exhaustion
  const clientIp = getClientIp(req);
  const ipCount = wsConnectionsPerIp.get(clientIp) || 0;
  if (ipCount >= MAX_WS_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Connection limit reached for this IP');
    return;
  }

  // Origin check: prevent cross-origin WebSocket connections
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) {
    ws.close(4400, 'Invalid origin');
    return;
  }

  // Parse padId and token from URL query
  const url = new URL(req.url, 'http://localhost');
  const rawPad = Number(url.searchParams.get('pad'));
  const padId = Number.isInteger(rawPad) && rawPad > 0 ? rawPad : 1;

  // Token verification: Cookie only (session token is never transmitted in URL)
  const cookieToken = parseCookies(req.headers.cookie || '')['session_token'];
  const token = cookieToken || null;
  const userId = verifySessionToken(token);
  ws.userId = (userId && userCodes.has(userId)) ? userId : null;

  // Access control: reject non-existent pads immediately
  const targetPad = findPad(padId);
  if (!targetPad) {
    ws.close(4404, 'Pad not found');
    return;
  }
  if (!canAccessPad(ws.userId, targetPad)) {
    ws.close(4401, 'Access denied');
    return;
  }

  // Password-protected pad: require a valid unlock token via query string
  if (targetPad.password) {
    const padToken = url.searchParams.get('padToken') || null;
    if (!isValidUnlockToken(padToken, padId)) {
      ws.close(4403, 'Pad locked');
      return;
    }
  }

  ws.ipAddress = clientIp;
  ws.clientId = generateId();
  ws.padId = padId;
  ws.isAlive = true;
  addClient(ws);

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));

  ws.send(JSON.stringify({ type: 'hello', wsId: ws.clientId, padId, userId: ws.userId }));
  broadcastPadOnlineCount(padId);
});

function broadcastToPad(padId, data, excludeWsId) {
  const padSet = padClients.get(padId);
  if (!padSet || padSet.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of padSet) {
    if (excludeWsId && ws.clientId === excludeWsId) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(msg);
    } catch {
      removeClient(ws);
    }
  }
}

const heartbeatTimer = setInterval(() => {
  for (const [, padSet] of padClients) {
    for (const ws of padSet) {
      if (ws.readyState !== WebSocket.OPEN) {
        removeClient(ws);
        continue;
      }
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// --- Graceful shutdown ---

function gracefulShutdown(signal) {
  console.log(`\n  ${signal} received, shutting down...`);
  clearInterval(heartbeatTimer);
  clearInterval(unlockCleanupTimer);
  clearInterval(fileTtlTimer);
  clearInterval(revokedCleanupTimer);
  flushStore();
  for (const [, padSet] of padClients) {
    for (const ws of padSet) {
      try { ws.close(1001, 'Server shutting down'); } catch {}
    }
  }
  server.close(() => {
    console.log('  Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.on('close', () => {
  clearInterval(heartbeatTimer);
  clearInterval(unlockCleanupTimer);
  clearInterval(fileTtlTimer);
  clearInterval(revokedCleanupTimer);
});

// --- Start ---

const lanIP = getLanIP();

server.listen(PORT, '0.0.0.0', async () => {
  const currentPort = getServerPort();
  const url = `http://${lanIP}:${currentPort}`;
  // Initial cleanup runs here (not at module load) so `padClients`/broadcastToPad
  // are initialized — expired files get broadcast to any already-connected clients.
  cleanupExpiredFiles();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     CoMark-Notepad is running!         ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${currentPort}`.padEnd(44) + '║');
  console.log(`  ║  Network: ${url}`.padEnd(44) + '║');
  console.log(`  ║  Pads:    ${store.pads.length} (${store.pads.map(p => p.id).join(', ')})`.padEnd(44) + '║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  if (isProduction && !process.env.PUBLIC_ORIGIN) {
    console.log('  ⚠  WARNING: PUBLIC_ORIGIN is not set. Origin-based CSRF protection');
    console.log('     will accept any localhost/LAN origin. Set PUBLIC_ORIGIN in production.');
    console.log('');
  }

  try {
    const qr = await QRCode.toString(url, { type: 'terminal', small: true });
    console.log('  Scan QR code to connect from phone:');
    console.log('');
    console.log(qr);
  } catch {}
});
