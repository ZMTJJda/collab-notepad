'use strict';

const { store } = require('./store');
const logger = require('../utils/logger');

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
    logger.info('Migrated old single-pad store to multi-pad format (pad #1)');
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

function run() {
  const data = store.getStore();
  const migrated = migrateStore(data);
  Object.assign(data, migrated);
  return store.flush();
}

module.exports = { run, migrateStore };
