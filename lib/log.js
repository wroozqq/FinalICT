'use strict';
// Security log (logs/app.log): sign-ins, failed sign-ins, QR rotations, rejected input.
// Never logs passwords, hashes, session tokens or visitor codes.
const fs = require('node:fs');
const path = require('node:path');
const { nowLocal } = require('./db');

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '..', 'logs', 'app.log');

function log(event, details = {}) {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${nowLocal()} ${event} ${JSON.stringify(details)}\n`);
  } catch { /* logging must never break the app */ }
}

module.exports = { log };
