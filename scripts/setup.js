'use strict';
// Creates gym_crowd_tracker.sqlite from db/schema.sql and loads reproducible test data.
// Run again at any time to reset the database to its original state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../lib/auth');
const { nowLocal } = require('../lib/db');

// Deterministic pseudo-random generator: the same seed always gives the same data.
function mulberry32(seed) {
  return function rand() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GYMS = [
  // name, capacity, historical visits, target average minutes, people inside right now
  ['Fitness Hall Astana', 50, 38, 77.7, 12],
  ['Invictus Go', 60, 51, 79.4, 28],
  ['Iron Club', 45, 40, 86.0, 19],
  ['Abyroy', 35, 38, 91.2, 8],
  ['Champion Fitness', 50, 38, 79.4, 15],
  ['Fitness Blitz', 55, 32, 87.9, 22],
  ['Underground', 30, 21, 73.1, 6],
];
// Arrivals per hour 07:00-21:00 in the test month (evening peak is built in on purpose).
const HOUR_COUNTS = { 7: 16, 8: 13, 9: 17, 10: 9, 11: 15, 12: 13, 13: 18, 14: 11, 15: 12, 16: 19, 17: 25, 18: 32, 19: 30, 20: 14, 21: 14 };
const VISITORS = 300;
const ACCOUNTS = [
  ['admin', 'Admin#2026', 'admin'],
  ['analyst', 'Analyst#2026', 'analyst'],
  ['daulet', 'Team#2026', 'admin'],
  ['nurkanat', 'Team#2026', 'admin'],
  ['islamnur', 'Team#2026', 'analyst'],
];

function fmt(date) { return date.toISOString().slice(0, 19).replace('T', ' '); }
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function setup(dbFile) {
  const rand = mulberry32(2620);
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
  const db = new DatabaseSync(dbFile);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  db.exec('BEGIN');

  const insGym = db.prepare('INSERT INTO gym (gym_name, capacity, opens_at, closes_at, auto_checkout_hours) VALUES (?, ?, ?, ?, 3)');
  GYMS.forEach(([name, cap]) => insGym.run(name, cap, '07:00', '23:00'));

  const registered = nowLocal(-60 * 24 * 60);
  const insVisitor = db.prepare('INSERT INTO visitor (visitor_code, consent_given, registered_at, gym_id) VALUES (?, 1, ?, ?)');
  for (let i = 1; i <= VISITORS; i++) {
    insVisitor.run(`V-${String(i).padStart(4, '0')}`, registered, 1 + Math.floor(rand() * GYMS.length));
  }

  // 14 active QR codes (entrance + exit for every gym) and 6 older, deactivated codes
  const insQr = db.prepare('INSERT INTO qr_code (gym_id, code_type, code_value, active, created_at) VALUES (?, ?, ?, ?, ?)');
  const qrHex = () => crypto.randomBytes(4).toString('hex');
  for (let g = 1; g <= 3; g++) { insQr.run(g, 'in', `IN-${qrHex()}`, 0, nowLocal(-14 * 24 * 60)); insQr.run(g, 'out', `OUT-${qrHex()}`, 0, nowLocal(-14 * 24 * 60)); }
  for (let g = 1; g <= GYMS.length; g++) {
    insQr.run(g, 'in', `IN-${qrHex()}`, 1, nowLocal(-7 * 24 * 60));
    insQr.run(g, 'out', `OUT-${qrHex()}`, 1, nowLocal(-7 * 24 * 60));
  }

  // 258 completed historical visits over the previous 30 days
  const hours = shuffle(Object.entries(HOUR_COUNTS).flatMap(([h, n]) => Array(n).fill(Number(h))), rand);
  const gymOfVisit = shuffle(GYMS.flatMap((g, i) => Array(g[2]).fill(i + 1)), rand);
  const today = new Date(nowLocal().slice(0, 10) + 'T00:00:00Z');
  const visits = gymOfVisit.map((gymId, i) => {
    const day = 1 + Math.floor(rand() * 30);
    const start = new Date(today.getTime() - day * 86400e3 + hours[i] * 3600e3 + Math.floor(rand() * 60) * 60e3);
    return { gymId, start, seconds: Math.round((40 + rand() * 90) * 60), visitorId: 21 + Math.floor(rand() * (VISITORS - 20)) };
  });
  // shift durations so every gym has exactly its target average duration
  GYMS.forEach(([, , n, avgMinutes], idx) => {
    const list = visits.filter((v) => v.gymId === idx + 1);
    const target = Math.round(avgMinutes * 60 * n);
    let diff = target - list.reduce((s, v) => s + v.seconds, 0);
    const each = Math.trunc(diff / n);
    list.forEach((v) => { v.seconds += each; });
    diff -= each * n;
    list[0].seconds += diff;
  });
  const insCheckin = db.prepare(`INSERT INTO checkin (visitor_id, gym_id, code_id, check_in_at, check_out_at, method, checkout_method, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'seed')`);
  visits.sort((a, b) => a.start - b.start).forEach((v) => {
    const viaQr = rand() < 0.8;
    insCheckin.run(v.visitorId, v.gymId, viaQr ? 5 + v.gymId * 2 : null /* id of that gym's active entrance code */, fmt(v.start),
      fmt(new Date(v.start.getTime() + v.seconds * 1000)), viaQr ? 'qr' : 'manual', viaQr ? 'qr' : 'manual');
  });

  // People who are inside right now (open visits). Codes V-0001...V-0020 stay free for demos and tests.
  const freeVisitors = shuffle(Array.from({ length: VISITORS - 20 }, (_, i) => i + 21), rand);
  const insOpen = db.prepare(`INSERT INTO checkin (visitor_id, gym_id, check_in_at, method, source) VALUES (?, ?, ?, 'qr', 'seed')`);
  GYMS.forEach((g, idx) => {
    for (let k = 0; k < g[4]; k++) insOpen.run(freeVisitors.pop(), idx + 1, nowLocal(-(10 + Math.floor(rand() * 140))));
  });

  const insAdmin = db.prepare('INSERT INTO admin_user (username, password_hash, password_salt, role) VALUES (?, ?, ?, ?)');
  ACCOUNTS.forEach(([user, pass, role]) => {
    const { hash, salt } = hashPassword(pass);
    insAdmin.run(user, hash, salt, role);
  });

  db.exec('COMMIT');
  const count = (t, w = '') => db.prepare(`SELECT COUNT(*) AS n FROM ${t} ${w}`).get().n;
  const result = {
    gym: count('gym'), visitor: count('visitor'), qr_code: count('qr_code'), admin_user: count('admin_user'),
    checkin: count('checkin'), completed: count('checkin', 'WHERE check_out_at IS NOT NULL'), open: count('checkin', 'WHERE check_out_at IS NULL'),
  };
  db.close();
  return result;
}

module.exports = { setup };

if (require.main === module) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'gym_crowd_tracker.sqlite');
  const r = setup(file);
  console.log(`Database created: ${path.basename(file)}`);
  console.log(`gym ${r.gym} | visitor ${r.visitor} | qr_code ${r.qr_code} | admin_user ${r.admin_user} | checkin ${r.checkin} (completed ${r.completed}, open now ${r.open})`);
}
