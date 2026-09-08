'use strict';

/**
 * Redis client with in-memory fallback.
 *
 * If Redis (ioredis) is installed AND reachable, it is used.
 * Otherwise, a simple in-memory Map is used as a fallback —
 * this means state is lost on server restart but the app still works.
 */

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// ── In-memory fallback ──────────────────────────────────────
class MemoryStore {
  constructor() {
    this._store = new Map();
    this._expires = new Map();
    console.log('[Redis] Using in-memory fallback store (state will reset on restart).');
  }

  _checkExpiry(key) {
    const exp = this._expires.get(key);
    if (exp && Date.now() > exp) {
      this._store.delete(key);
      this._expires.delete(key);
      return true;
    }
    return false;
  }

  async get(key) {
    if (this._checkExpiry(key)) return null;
    return this._store.get(key) ?? null;
  }

  async set(key, value, ...args) {
    this._store.set(key, String(value));
    // Handle EX (seconds) and PX (ms) options
    const exIdx = args.indexOf('EX');
    const pxIdx = args.indexOf('PX');
    if (exIdx !== -1 && args[exIdx + 1]) {
      this._expires.set(key, Date.now() + args[exIdx + 1] * 1000);
    } else if (pxIdx !== -1 && args[pxIdx + 1]) {
      this._expires.set(key, Date.now() + args[pxIdx + 1]);
    }
    return 'OK';
  }

  async del(...keys) {
    let deleted = 0;
    for (const k of keys) { if (this._store.delete(k)) deleted++; this._expires.delete(k); }
    return deleted;
  }

  async incr(key) {
    if (this._checkExpiry(key)) this._store.set(key, '0');
    const val = parseInt(this._store.get(key) ?? '0', 10) + 1;
    this._store.set(key, String(val));
    return val;
  }

  async expire(key, seconds) {
    if (!this._store.has(key)) return 0;
    this._expires.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async exists(...keys) {
    return keys.filter(k => !this._checkExpiry(k) && this._store.has(k)).length;
  }

  // Hash commands (hset, hget, hgetall, hdel) — store hash as JSON string
  async hset(key, ...fieldsAndValues) {
    if (this._checkExpiry(key)) this._store.set(key, '{}');
    const obj = JSON.parse(this._store.get(key) ?? '{}');
    for (let i = 0; i < fieldsAndValues.length - 1; i += 2) {
      obj[fieldsAndValues[i]] = fieldsAndValues[i + 1];
    }
    this._store.set(key, JSON.stringify(obj));
    return fieldsAndValues.length / 2;
  }

  async hget(key, field) {
    if (this._checkExpiry(key)) return null;
    const obj = JSON.parse(this._store.get(key) ?? '{}');
    return obj[field] ?? null;
  }

  async hgetall(key) {
    if (this._checkExpiry(key)) return null;
    const raw = this._store.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  async hdel(key, ...fields) {
    if (this._checkExpiry(key)) return 0;
    const obj = JSON.parse(this._store.get(key) ?? '{}');
    let deleted = 0;
    for (const f of fields) { if (f in obj) { delete obj[f]; deleted++; } }
    this._store.set(key, JSON.stringify(obj));
    return deleted;
  }

  async ping() { return 'PONG'; }
  async quit() {}
  on() { return this; }
}

// ── Redis client factory ────────────────────────────────────
let redisClient = null;

async function createRedisClient() {
  if (redisClient) return redisClient;

  let Redis;
  try {
    Redis = require('ioredis');
  } catch {
    redisClient = new MemoryStore();
    return redisClient;
  }

  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false,
  });

  try {
    await client.connect();
    await client.ping();
    console.log(`[Redis] Connected to ${REDIS_URL}`);
    redisClient = client;
  } catch (err) {
    console.warn(`[Redis] Could not connect to ${REDIS_URL}: ${err.message}`);
    console.warn('[Redis] Falling back to in-memory store.');
    try { client.disconnect(); } catch {}
    redisClient = new MemoryStore();
  }

  return redisClient;
}

/** Convenience key constants */
const KEYS = {
  examStatus: 'exam:status',
  examStartTime: 'exam:start_time',
  session: (token) => `session:${token}`,
  rateLimit: (userId, challengeId) => `rate:${userId}:${challengeId}`,
  leaderboard: 'leaderboard:cache',
};

module.exports = { createRedisClient, KEYS };
