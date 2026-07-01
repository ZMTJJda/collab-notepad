'use strict';

const path = require('path');
const fs = require('fs');
const Busboy = require('busboy');
const { NotFoundError, ForbiddenError, BadRequestError } = require('../utils/errors');
const { canAccessPad, canAccessFile: authCanAccessFile, canManagePad, resolveFileOwner } = require('../utils/auth');
const { generateId } = require('../utils/crypto');
const { formatBytes, downloadBasename } = require('../utils/file');
const { MAX_FILE_BYTES } = require('../config');
const logger = require('../utils/logger');

class FileService {
  constructor(db, broadcast, padService) {
    this.db = db;
    this.broadcast = broadcast;
    this.padService = padService || null;
  }

  _hasAccessGrant(grantor, grantee) {
    return this.db.invitations.hasAccessGrant(grantor, grantee);
  }

  canAccessPad(userId, pad) {
    return canAccessPad(userId, pad, this._hasAccessGrant.bind(this));
  }

  canAccessFile(userId, file) {
    return authCanAccessFile(userId, file, this.db.pads.findById.bind(this.db.pads), this._hasAccessGrant.bind(this));
  }

  canManagePad(userId, isAdminUser, pad) {
    return canManagePad(userId, isAdminUser, pad);
  }

  getFileById(fileId) {
    return this.db.files.findById(fileId) || null;
  }

  getPadForFileById(fileId) {
    const file = this.db.files.findById(fileId);
    if (!file) return null;
    return this.db.pads.findById(file.padId || 1) || null;
  }

  async upload(req, res) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) {
      throw BadRequestError('multipart/form-data required');
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 8, parts: 9 },
      });
    } catch {
      throw BadRequestError('Invalid multipart form data');
    }

    let excludeWsId = null;
    let padIdField = null;
    let fileInfo = null;
    let filePath = null;
    let writeStream = null;
    let fileWritePromise = null;
    let fileSeen = false;
    let fileLimitReached = false;
    let finished = false;
    let aborted = false;
    let busboyFinished = false;
    let uploadAccessDenied = false;

    const cleanupPartialFile = () => {
      if (writeStream) { writeStream.destroy(); writeStream = null; }
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
      filePath = null;
    };

    const fail = (status, error) => {
      if (finished || res.headersSent) return;
      finished = true;
      cleanupPartialFile();
      res.status(status).json({ error });
    };

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

    busboy.on('filesLimit', () => fail(400, 'Only one file allowed'));
    busboy.on('partsLimit', () => fail(400, 'Too many form parts'));

    busboy.on('file', (name, file, info) => {
      if (name !== 'file' || fileSeen) { file.resume(); return; }
      fileSeen = true;

      const originalName = downloadBasename(info.filename, '');
      if (!originalName) { file.resume(); return; }

      const id = generateId();
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const filename = `${id}_${safeName}`;
      filePath = path.join(this.db.FILES_DIR, filename);

      // Early access check
      if (padIdField !== null) {
        const earlyPad = this.db.pads.findById(padIdField);
        if (earlyPad && !this.canAccessPad(req.userId, earlyPad)) {
          uploadAccessDenied = true;
          file.resume();
          return;
        }
      }

      fileInfo = {
        id, filename, originalName,
        size: 0,
        mimeType: (info.mimeType || 'application/octet-stream').toLowerCase(),
        createdAt: Date.now(),
        ownerUserId: null,
        padId: 1,
      };

      writeStream = fs.createWriteStream(filePath, { flags: 'wx' });
      fileWritePromise = new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        file.on('error', reject);
      });
      fileWritePromise.catch(() => {});

      file.on('limit', () => {
        fileLimitReached = true;
        if (writeStream) writeStream.destroy(new Error('File too large'));
      });

      file.pipe(writeStream);
      file.on('data', (chunk) => { if (fileInfo) fileInfo.size += chunk.length; });
    });

    busboy.on('error', () => fail(400, 'Invalid multipart form data'));

    busboy.on('finish', async () => {
      busboyFinished = true;
      if (finished || aborted) return;
      if (uploadAccessDenied) {
        finished = true;
        if (!res.headersSent) res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!fileSeen || !fileInfo) return fail(400, 'file required');
      if (fileLimitReached) return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);

      try {
        await fileWritePromise;
      } catch (err) {
        if (finished || aborted) return;
        if (fileLimitReached) return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
        logger.error({ err }, 'Failed to save upload');
        return fail(500, 'Failed to save upload');
      }

      if (finished || aborted) return;

      // Resolve file ownership and pad association
      const targetPadId = padIdField || this.db.pads.findAll()[0]?.id || 1;
      const targetPad = this.db.pads.findById(targetPadId);
      if (!targetPad) return fail(404, 'Pad not found');

      // Authoritative access check
      if (!this.canAccessPad(req.userId, targetPad)) return fail(403, 'Access denied');

      // Pad lock check
      if (targetPad.password && (!this.padService || !this.padService.isValidUnlockToken(
        req.headers['x-pad-token'] || req.query?.padToken, targetPad.id
      ))) {
        return fail(403, 'Pad locked');
      }

      fileInfo.ownerUserId = resolveFileOwner(req.userId, targetPad);
      fileInfo.padId = targetPadId;

      this.db.files.create(fileInfo);
      this.broadcast.toPad(fileInfo.padId, { type: 'file-added', file: fileInfo }, excludeWsId);
      finished = true;
      if (!res.headersSent) res.json(fileInfo);
    });

    req.pipe(busboy);
  }

  async downloadFile(userId, fileId) {
    const file = this.db.files.findById(fileId);
    if (!file) throw NotFoundError('File not found');
    if (!this.canAccessFile(userId, file)) throw NotFoundError('File not found');
    const filepath = path.join(this.db.FILES_DIR, file.filename);
    return { file, filepath };
  }

  async deleteFile(userId, isAdminUser, fileId, excludeWsId) {
    const file = this.db.files.findById(fileId);
    if (!file) throw NotFoundError('File not found');

    const pad = this.db.pads.findById(file.padId || 1);
    if (!pad) throw NotFoundError('Pad not found');

    // Permission check
    if (file.ownerUserId) {
      if (userId !== file.ownerUserId && !isAdminUser) {
        if (!this.canManagePad(userId, isAdminUser, pad)) {
          throw ForbiddenError('Access denied');
        }
      }
    } else {
      if (!this.canManagePad(userId, isAdminUser, pad)) {
        throw ForbiddenError('Access denied');
      }
    }

    this.db.files.remove(fileId);
    try { fs.unlinkSync(path.join(this.db.FILES_DIR, file.filename)); } catch {}
    this.broadcast.toPad(file.padId || 1, { type: 'file-deleted', fileId }, excludeWsId);
    return { ok: true };
  }

  async clearFiles(userId, isAdminUser, padId, excludeWsId) {
    const pad = this.db.pads.findById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    if (!this.canManagePad(userId, isAdminUser, pad)) {
      throw ForbiddenError('Access denied');
    }

    const toDelete = this.db.files.findAll().filter(f => (f.padId || 1) === padId);
    for (const file of toDelete) {
      try { fs.unlinkSync(path.join(this.db.FILES_DIR, file.filename)); } catch {}
      this.db.files.remove(file.id);
    }
    for (const file of toDelete) {
      this.broadcast.toPad(padId, { type: 'file-deleted', fileId: file.id }, excludeWsId);
    }
    return { ok: true, cleared: toDelete.length };
  }
}

module.exports = FileService;
