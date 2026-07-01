'use strict';

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { AppError, NotFoundError, ForbiddenError, BadRequestError, ConflictError, ServiceUnavailableError, RequestTimeoutError } = require('../utils/errors');
const { generateId } = require('../utils/crypto');
const { canAccessFile: authCanAccessFile } = require('../utils/auth');
const { CONVERT_MAX_BYTES, CONVERT_TIMEOUT_MS, CONVERTIBLE_EXTS, CONVERT_FEATURES } = require('../config');
const logger = require('../utils/logger');

const convertingFiles = new Set();
const MAX_CONCURRENT_CONVERTS = 3;
let activeConverts = 0;

class ConvertService {
  constructor(db, broadcast) {
    this.db = db;
    this.broadcast = broadcast;
  }

  getCapabilities() {
    return {
      extensions: CONVERTIBLE_EXTS,
      maxBytes: CONVERT_MAX_BYTES,
      timeoutMs: CONVERT_TIMEOUT_MS,
      features: CONVERT_FEATURES,
    };
  }

  _hasAccessGrant(grantor, grantee) {
    return this.db.invitations.hasAccessGrant(grantor, grantee);
  }

  getFileById(fileId) {
    return this.db.files.findById(fileId) || null;
  }

  async convert(userId, fileId) {
    if (activeConverts >= MAX_CONCURRENT_CONVERTS) {
      throw ServiceUnavailableError('Too many conversions in progress, try again shortly');
    }
    activeConverts++;
    let mdDiskPath = null;
    let lockAcquired = false;

    try {
      const file = this.db.files.findById(fileId);
      if (!file) throw NotFoundError('File not found');

      // Use shared auth helper for file access check
      const hasGrant = this._hasAccessGrant.bind(this);
      if (!authCanAccessFile(userId, file, this.db.pads.findById.bind(this.db.pads), hasGrant)) {
        throw ForbiddenError('Access denied');
      }

      if (file.originalName.toLowerCase().endsWith('.md')) {
        throw BadRequestError('Markdown files cannot be converted');
      }

      const filepath = path.join(this.db.FILES_DIR, file.filename);
      let stat;
      try {
        stat = await fs.promises.stat(filepath);
      } catch {
        throw NotFoundError('File not found on disk');
      }
      if (stat.size > CONVERT_MAX_BYTES) {
        throw BadRequestError('File too large to convert');
      }

      // Check if already converted
      const baseName = file.originalName.replace(/\.[^.]+$/, '');
      const mdOriginalName = `${baseName}.md`;
      if (this.db.files.findAll().some(f => f.originalName === mdOriginalName && f.padId === file.padId)) {
        throw ConflictError('Already converted');
      }

      // Prevent concurrent converts of the same file
      if (convertingFiles.has(fileId)) {
        throw ConflictError('Conversion already in progress');
      }
      convertingFiles.add(fileId);
      lockAcquired = true;

      const ext = path.extname(file.originalName).toLowerCase();
      let markdown;
      try {
        const buffer = await fs.promises.readFile(filepath);
        markdown = await this._convertInWorker(buffer, ext, file.mimeType, file.originalName);
      } catch (e) {
        if (e.message === 'CONVERT_TIMEOUT') {
          throw RequestTimeoutError('Conversion timed out');
        }
        if (e.message === 'UNSUPPORTED_FILE_TYPE' || e.code === 'UNSUPPORTED_FILE_TYPE') {
          throw new AppError('Unsupported file type', 415, 'UNSUPPORTED_FILE_TYPE');
        }
        if (e.code === 'CONVERSION_INPUT_ERROR') {
          throw new AppError('File could not be converted', 422, 'CONVERSION_INPUT_ERROR');
        }
        logger.error({ err: e }, 'Convert error');
        throw BadRequestError('Conversion failed');
      }

      const mdId = generateId();
      const safeBaseName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const safeMdName = `${safeBaseName}.md`;
      const mdDiskName = `${mdId}_${safeMdName}`;
      mdDiskPath = path.join(this.db.FILES_DIR, mdDiskName);

      await fs.promises.writeFile(mdDiskPath, markdown, 'utf8');

      const targetPad = this.db.pads.findById(file.padId);
      const mdFile = {
        id: mdId,
        filename: mdDiskName,
        originalName: mdOriginalName,
        size: Buffer.byteLength(markdown, 'utf8'),
        mimeType: 'text/markdown',
        createdAt: Date.now(),
        ownerUserId: targetPad?.ownerUserId || userId || null,
        padId: file.padId,
      };

      this.db.files.create(mdFile);
      this.db.files.remove(fileId);
      try { fs.unlinkSync(filepath); } catch {}

      this.broadcast.toPad(file.padId, { type: 'file-deleted', fileId: file.id });
      this.broadcast.toPad(mdFile.padId, { type: 'file-added', file: mdFile });

      return mdFile;
    } finally {
      if (lockAcquired) convertingFiles.delete(fileId);
      activeConverts--;
    }
  }

  _convertInWorker(buffer, ext, mimeType, originalName) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, '../../convert-worker.js'), {
        workerData: { buffer, ext, mimeType, originalName },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate().catch(() => {});
        reject(new Error('CONVERT_TIMEOUT'));
      }, CONVERT_TIMEOUT_MS);

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
        worker.terminate().catch(() => {});
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
}

module.exports = ConvertService;
