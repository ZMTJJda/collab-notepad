'use strict';

const { store } = require('./store');

function findById(id) {
  return store.getStore().pads.find(p => p.id === id);
}

function findAll() {
  return store.getStore().pads;
}

function create(pad) {
  const data = store.getStore();
  const usedIds = new Set(data.pads.map(p => p.id));
  let id = 1;
  while (usedIds.has(id)) id++;

  const newPad = {
    id,
    text: '',
    textVersion: 0,
    password: null,
    createdAt: Date.now(),
    ownerUserId: pad.ownerUserId || null,
    creatorCode: pad.creatorCode || null,
  };
  data.pads.push(newPad);
  store.flush(); // Critical: pad creation must not be lost
  return newPad;
}

function updateText(id, text) {
  const pad = findById(id);
  if (!pad) return null;
  pad.text = text;
  pad.textVersion++;
  store.save();
  return pad;
}

function updatePassword(id, passwordHash) {
  const pad = findById(id);
  if (!pad) return null;
  pad.password = passwordHash;
  store.flush(); // Critical: password change must persist immediately
  return pad;
}

function remove(id) {
  const data = store.getStore();
  data.pads = data.pads.filter(p => p.id !== id);
  store.flush(); // Critical: pad deletion must not be lost
}

module.exports = {
  findById,
  findAll,
  create,
  updateText,
  updatePassword,
  remove,
};
