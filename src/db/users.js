'use strict';

const { store } = require('./store');

const userCodes = new Set(); // Fast lookup mirror of store.users[].code

function init() {
  for (const u of store.getStore().users) {
    userCodes.add(u.code);
  }
}

function exists(code) {
  return userCodes.has(code);
}

function create(user) {
  store.getStore().users.push(user);
  userCodes.add(user.code);
  store.save();
  return user;
}

module.exports = {
  init,
  exists,
  create,
  userCodes,
};
