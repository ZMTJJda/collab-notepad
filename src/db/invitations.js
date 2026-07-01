'use strict';

const { store } = require('./store');

function findByToken(token) {
  return store.getStore().inviteTokens.find(t => t.token === token);
}

function create(invite) {
  store.getStore().inviteTokens.push(invite);
  store.save();
  return invite;
}

function remove(token) {
  const data = store.getStore();
  const idx = data.inviteTokens.findIndex(t => t.token === token);
  if (idx === -1) return false;
  data.inviteTokens.splice(idx, 1);
  // Clean up access grants created via this invitation to prevent unbounded growth
  const grantsBefore = data.accessGrants.length;
  data.accessGrants = data.accessGrants.filter(g => g.inviteToken !== token);
  const revokedGrants = grantsBefore - data.accessGrants.length;
  store.flush(); // Critical: invitation deletion must persist immediately
  return { ok: true, revokedGrants };
}

function hasAccessGrant(grantorCode, granteeCode) {
  return store.getStore().accessGrants.some(
    g => g.grantorCode === grantorCode && g.granteeCode === granteeCode
  );
}

function addGrant(grant) {
  store.getStore().accessGrants.push(grant);
  store.save();
}

module.exports = {
  findByToken,
  create,
  remove,
  hasAccessGrant,
  addGrant,
};
