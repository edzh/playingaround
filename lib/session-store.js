'use strict';

const { randomUUID } = require('crypto');

class SessionStore {
  constructor() {
    this._map = new Map();
  }

  create(data) {
    const id = randomUUID();
    this._map.set(id, { id, ...data, createdAt: Date.now() });
    return id;
  }

  get(id) {
    return this._map.get(id) ?? null;
  }

  delete(id) {
    this._map.delete(id);
  }

  // Evict sessions older than maxAgeMs (default 2 hours)
  evictOld(maxAgeMs = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    for (const [id, session] of this._map) {
      if (now - session.createdAt > maxAgeMs) this._map.delete(id);
    }
  }
}

module.exports = new SessionStore();
