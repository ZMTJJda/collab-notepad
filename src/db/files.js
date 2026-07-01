'use strict';

const { store } = require('./store');

function findById(id) {
  return store.getStore().files.find(f => f.id === id);
}

function findAll() {
  return store.getStore().files;
}

function create(fileInfo) {
  store.getStore().files.unshift(fileInfo);
  store.flush(); // Ensure file metadata persists immediately
  return fileInfo;
}

function remove(id) {
  const data = store.getStore();
  data.files = data.files.filter(f => f.id !== id);
  store.flush(); // Critical: file deletion must persist immediately
}

function removeByPadId(padId) {
  const data = store.getStore();
  data.files = data.files.filter(f => (f.padId || 1) !== padId);
  store.flush();
}

function findExpired(ttlMs) {
  const now = Date.now();
  return store.getStore().files.filter(f => now - (f.createdAt || 0) > ttlMs);
}

module.exports = {
  findById,
  findAll,
  create,
  remove,
  removeByPadId,
  findExpired,
};
