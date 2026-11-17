'use strict';
// Staff authentication: scrypt password hashing, in-memory sessions, login rate limiting.
const crypto = require('node:crypto');

const SESSION_MINUTES = 30;
const sessions = new Map(); // token -> { adminId, username, role, expires }

// scrypt = slow, memory-hard hash. A random 16-byte salt per account means that
// two staff members with the same password still get different hashes.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createSession(admin) {
  const token = crypto.randomBytes(32).toString('hex'); // 32 random bytes = unguessable
  sessions.set(token, {
    adminId: admin.admin_id, username: admin.username, role: admin.role,
    expires: Date.now() + SESSION_MINUTES * 60e3,
  });
  return token;
}

function getSession(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s;
}

function destroySession(token) { sessions.delete(token); }

// Simple fixed-window rate limiter: at most `limit` attempts per key per minute.
function makeRateLimiter(limit, windowMs = 60e3) {
  const hits = new Map();
  return function allowed(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) { hits.set(key, { start: now, count: 1 }); return true; }
    entry.count += 1;
    return entry.count <= limit;
  };
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, destroySession, makeRateLimiter, SESSION_MINUTES };
