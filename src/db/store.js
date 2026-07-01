'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { STORE_FILE, FILES_DIR } = require('../config');
const revokedTokens = require('./revokedTokens');
const logger = require('../utils/logger');

// Ensure directories exist
fsSync.mkdirSync(FILES_DIR, { recursive: true });

class JSONStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.dirty = false;
    this.saveTimer = null;
    this.writeLock = false;
  }

  async load() {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      this.data = JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.data = { pads: [], files: [], users: [], inviteTokens: [], accessGrants: [], revokedTokens: {} };
        await this.flush();
      } else {
        logger.error({ err: error }, 'Failed to load store');
        // Backup corrupted file for manual recovery
        try {
          const backupName = `${this.filePath}.bak.${Date.now()}`;
          await fs.copyFile(this.filePath, backupName);
          logger.info(`  -> backed up to ${backupName}`);
        } catch {}
        // Initialize with empty data
        this.data = { pads: [], files: [], users: [], inviteTokens: [], accessGrants: [], revokedTokens: {} };
      }
    }
  }

  getStore() {
    return this.data;
  }

  // Debounced write: high-frequency operations
  save() {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 200);
    }
  }

  // Atomic synchronous write: critical operations
  async flush() {
    if (!this.dirty || this.writeLock) return;
    this.writeLock = true;
    try {
      await this.writeAtomic();
      this.dirty = false;
    } finally {
      this.writeLock = false;
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
    }
  }

  async writeAtomic() {
    // Persist revoked tokens before writing
    this.data.revokedTokens = Object.fromEntries(revokedTokens.getAll());

    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
    await fs.rename(tempPath, this.filePath);
    try { await fs.chmod(this.filePath, 0o600); } catch {}
  }

  // Synchronous flush for graceful shutdown
  flushSync() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      // Persist revoked tokens
      this.data.revokedTokens = Object.fromEntries(revokedTokens.getAll());

      const tmp = this.filePath + '.tmp';
      fsSync.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fsSync.renameSync(tmp, this.filePath);
      try { fsSync.chmodSync(this.filePath, 0o600); } catch {}
      this.dirty = false;
    } catch (e) {
      logger.error({ err: e }, 'Failed to flush store synchronously');
    }
  }
}

// Singleton instance
const store = new JSONStore(STORE_FILE);

module.exports = {
  store,
  FILES_DIR,
};
