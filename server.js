'use strict';
// Gym Crowd Tracker - web server (Node.js built-in modules only, no npm packages).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, nowLocal, crowdLevel } = require('./lib/db');
const auth = require('./lib/auth');
const qr = require('./lib/qr');
const { log } = require('./lib/log');
const os = require('node:os');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CODE_RE = /^V-[A-Z0-9]{4,8}$/;      // visitor code format, e.g. V-0001 or V-7KQ2MX
const QR_RE = /^(IN|OUT)-[a-f0-9]{8}$/;   // QR code value format
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
};

// ---------- small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted; }

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000) { reject(new HttpError(413, 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }

function normaliseCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpError(400, 'Visitor code must look like V-0001.');
  return code;
}

function parseGymId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Choose a gym.');
  return id;
}

// The laptop's address in the local Wi-Fi network (e.g. 192.168.1.25), so a phone can open QR links.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

// Address written into QR codes. If staff opened the dashboard as localhost / 127.0.0.1 (which a phone
// cannot reach) and the server is open to the network, the laptop's Wi-Fi address is used instead.
function qrBase(req) {
  const proto = isHttps(req) ? 'https' : 'http';
  const host = String(req.headers.host || 'localhost:3000').replace(/[^\w.:\[\]-]/g, '');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  if (local && process.env.HOST === '0.0.0.0') {
    const ip = lanAddress();
    const port = host.includes(':') && !host.startsWith('[') ? host.split(':').pop() : (req.socket.localPort || 3000);
    if (ip) return { base: `${proto}://${ip}:${port}`, phoneReady: true };
  }
  return { base: `${proto}://${host}`, phoneReady: !local };
}

// ---------- application ----------
function createApp(dbFile) {
  const { db, q } = openDb(dbFile);
  const loginLimiter = auth.makeRateLimiter(5);     // 5 login attempts per minute per IP
  const visitorLimiter = auth.makeRateLimiter(60);  // slows down guessing of visitor codes
  const startedAt = Date.now();

  const runAutoCheckout = () => q.autoCheckout.run(nowLocal()).changes;

  function gymList() {
    runAutoCheckout();
    return q.gyms.all().map((g) => ({
      gymId: g.gym_id, name: g.gym_name, capacity: g.capacity, opensAt: g.opens_at, closesAt: g.closes_at,
      inside: g.inside, ...crowdLevel(g.inside, g.capacity),
    }));
  }

  function gymStatus(gymId) {
    const g = gymList().find((x) => x.gymId === gymId);
    if (!g) throw new HttpError(404, 'Gym not found.');
    return g;
  }

  function findVisitor(code) {
    const v = q.visitorByCode.get(code);
    if (!v) throw new HttpError(404, 'This visitor code is not registered. Tap "Get anonymous code" first.');
    return v;
  }

  // Validates a scanned QR value: must exist, be active, match the gym and the action.
  function checkQr(value, gymId, type) {
    if (value === undefined || value === null || value === '') return null;
    if (!QR_RE.test(String(value))) throw new HttpError(400, 'QR code is not valid.');
    const code = q.qrByValue.get(String(value));
    if (!code || !code.active) throw new HttpError(400, 'This QR code is no longer active. Scan the code at the door.');
    if (code.code_type !== type) throw new HttpError(400, `This is an ${code.code_type === 'in' ? 'entrance' : 'exit'} code. Use it to ${code.code_type === 'in' ? 'check in' : 'check out'}.`);
    if (gymId !== undefined && code.gym_id !== gymId) throw new HttpError(400, 'This QR code belongs to another gym.');
    return code;
  }

  function requireRole(req, ...roles) {
    const s = auth.getSession(getCookie(req, 'sid'));
    if (!s) throw new HttpError(401, 'Administrator sign-in required.');
    if (roles.length && !roles.includes(s.role)) throw new HttpError(403, `This action requires the ${roles.join(' or ')} role.`);
    return s;
  }

  const routes = {
    'GET /health': () => {
      db.prepare('SELECT 1').get();
      return [200, { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), time: nowLocal() }];
    },

    // ----- visitor (public) -----
    'GET /api/gyms': () => [200, { gyms: gymList(), updatedAt: nowLocal() }],

    'GET /api/today': (req, url) => {
      const gymId = parseGymId(url.searchParams.get('gym'));
      return [200, { gymId, hours: q.today.all(gymId, nowLocal()).map((r) => ({ hour: r.hour, arrivals: r.arrivals })) }];
    },

    'POST /api/my-visits': async (req) => {
      const body = await readJson(req);
      const code = normaliseCode(body.code);
      runAutoCheckout();
      const v = findVisitor(code);
      const s = q.myStats.get(nowLocal(), v.visitor_id);
      const fav = q.myFavourite.get(v.visitor_id);
      return [200, {
        code, visits: s.visits, minutes: s.minutes, last7: s.last7 || 0,
        favouriteGym: fav ? fav.gym : null,
        recent: q.myRecent.all(v.visitor_id).map((r) => ({
          gym: r.gym, checkIn: r.check_in_at, checkOut: r.check_out_at, minutes: r.minutes, auto: r.checkout_method === 'auto',
        })),
      }];
    },

    'GET /api/busy-hours': (req, url) => {
      const gymId = parseGymId(url.searchParams.get('gym'));
      const raw = url.searchParams.get('weekday');
      const weekday = raw === 'all' ? 'all' : Number(raw);
      if (weekday !== 'all' && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new HttpError(400, 'weekday must be 0-6 or "all".');
      const rows = weekday === 'all' ? q.busyHoursAll.all(gymId) : q.busyHours.all(gymId, weekday);
      return [200, {
        gymId, weekday, sampleVisits: rows.reduce((s, r) => s + r.visits, 0),
        hours: rows.map((r) => ({ hour: r.hour, avgArrivals: r.avg_arrivals })),
      }];
    },

    'POST /api/visitors': async (req) => {
      const body = await readJson(req);
      if (body.consent !== true) throw new HttpError(400, 'Please accept the privacy notice first.');
      const gymId = parseGymId(body.gymId);
      if (!q.gym.get(gymId)) throw new HttpError(404, 'Gym not found.');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
      let code;
      do {
        code = 'V-' + Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
      } while (q.visitorByCode.get(code));
      q.insertVisitor.run(code, nowLocal(), gymId);
      return [201, { code }];
    },

    'POST /api/status': async (req) => {
      const body = await readJson(req);
      const code = normaliseCode(body.code);
      runAutoCheckout();
      const v = findVisitor(code);
      const open = q.openVisit.get(v.visitor_id);
      return [200, {
        code, active: Boolean(open),
        visit: open ? { gymId: open.gym_id, gymName: open.gym_name, since: open.check_in_at } : null,
      }];
    },

    'POST /api/checkin': async (req) => {
      const body = await readJson(req);
      const code = normaliseCode(body.code);
      const gymId = parseGymId(body.gymId);
      if (!q.gym.get(gymId)) throw new HttpError(404, 'Gym not found.');
      const qrCode = checkQr(body.qr, gymId, 'in');
      runAutoCheckout();
      const v = findVisitor(code);
      const open = q.openVisit.get(v.visitor_id);
      if (open) throw new HttpError(409, `You are already checked in at ${open.gym_name}. Check out first.`);
      try {
        q.insertCheckin.run(v.visitor_id, gymId, qrCode ? qrCode.code_id : null, nowLocal(), qrCode ? 'qr' : 'manual');
      } catch (e) {
        // the UNIQUE partial index is the final guard against a double check-in
        if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'You are already checked in. Check out first.');
        throw e;
      }
      const gym = gymStatus(gymId);
      return [200, { message: `Checked in at ${gym.name}. Crowd level now: ${gym.level} (${gym.inside}).`, gym }];
    },

    'POST /api/checkout': async (req) => {
      const body = await readJson(req);
      const code = normaliseCode(body.code);
      runAutoCheckout();
      const v = findVisitor(code);
      const open = q.openVisit.get(v.visitor_id);
      if (!open) throw new HttpError(409, 'You have no active visit. Check in first.');
      const qrCode = checkQr(body.qr, open.gym_id, 'out');
      q.closeVisit.run(nowLocal(), qrCode ? 'qr' : 'manual', open.checkin_id);
      const gym = gymStatus(open.gym_id);
      return [200, { message: `Checked out of ${gym.name}. Crowd level now: ${gym.level} (${gym.inside}).`, gym }];
    },

    // ----- staff -----
    'POST /api/login': async (req) => {
      if (!loginLimiter(clientIp(req))) throw new HttpError(429, 'Too many sign-in attempts. Wait one minute.');
      const body = await readJson(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const admin = q.adminByName.get(username);
      if (!admin || !auth.verifyPassword(password, admin.password_salt, admin.password_hash)) {
        log('login_failed', { username: username.slice(0, 40), ip: clientIp(req) });
        throw new HttpError(401, 'Invalid username or password.'); // same message: does not reveal which part is wrong
      }
      q.adminLogin.run(nowLocal(), admin.admin_id);
      const token = auth.createSession(admin);
      log('login_ok', { username: admin.username, role: admin.role });
      const cookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_MINUTES * 60}` + (isHttps(req) ? '; Secure' : '');
      return [200, { username: admin.username, role: admin.role }, { 'Set-Cookie': cookie }];
    },

    'POST /api/logout': (req) => {
      auth.destroySession(getCookie(req, 'sid'));
      return [200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }];
    },

    'GET /api/me': (req) => {
      const s = requireRole(req);
      return [200, { username: s.username, role: s.role }];
    },

    'GET /api/analytics': (req) => {
      requireRole(req, 'admin', 'analyst');
      runAutoCheckout();
      const today = nowLocal();
      return [200, {
        summary: q.summary.get(today),
        live: gymList(),
        hourly: q.hourly.all(),
        byGym: q.byGym.all(),
        duration: q.duration.all(),
        daily: q.daily.all(today),
        // the exact SQL text behind each chart, shown under the chart (repeatable analysis)
        queries: { hourly: q.hourly.sourceSQL, byGym: q.byGym.sourceSQL, duration: q.duration.sourceSQL },
      }];
    },

    'GET /api/admin/qr': (req) => {
      requireRole(req, 'admin', 'analyst');
      return [200, { codes: q.qrList.all(), ...qrBase(req) }];
    },

    'POST /api/admin/qr/rotate': async (req) => {
      const s = requireRole(req, 'admin');
      const body = await readJson(req);
      const gymId = parseGymId(body.gymId);
      if (!['in', 'out'].includes(body.type)) throw new HttpError(400, 'type must be "in" or "out".');
      if (!q.gym.get(gymId)) throw new HttpError(404, 'Gym not found.');
      const value = `${body.type.toUpperCase()}-${crypto.randomBytes(4).toString('hex')}`;
      db.exec('BEGIN');
      try {
        q.qrDeactivate.run(gymId, body.type);
        q.qrInsert.run(gymId, body.type, value, nowLocal());
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      log('qr_rotated', { by: s.username, gymId, type: body.type });
      return [200, { codeValue: value }];
    },

    'POST /api/sensor/simulate': (req) => {
      requireRole(req, 'admin');
      const time = nowLocal();
      const rows = gymList().map((g) => {
        // beam counter estimate = real check-in count +/- 2 (counting noise)
        const estimate = Math.max(0, g.inside + crypto.randomInt(-2, 3));
        q.insertReading.run(g.gymId, time, estimate);
        return { gymId: g.gymId, estimate };
      });
      return [201, { inserted: rows.length, rows }];
    },

    // Staff accounts: an admin registers a new staff member (password stored as scrypt hash + salt)
    'GET /api/admin/users': (req) => {
      requireRole(req, 'admin');
      return [200, { users: q.adminList.all() }];
    },

    'POST /api/admin/users': async (req) => {
      const s = requireRole(req, 'admin');
      const body = await readJson(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) throw new HttpError(400, 'Username: 3-20 characters, latin letters, digits or _, starting with a letter.');
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) throw new HttpError(400, 'Password: at least 8 characters with a letter and a digit.');
      if (!['admin', 'analyst'].includes(body.role)) throw new HttpError(400, 'Role must be admin or analyst.');
      if (q.adminByName.get(username)) throw new HttpError(409, 'This username is already taken.');
      const { hash, salt } = auth.hashPassword(password);
      q.insertAdmin.run(username, hash, salt, body.role);
      log('staff_created', { by: s.username, username, role: body.role });
      return [201, { username, role: body.role }];
    },

    'GET /api/sensor/readings': (req) => {
      requireRole(req, 'admin', 'analyst');
      return [200, { readings: q.readings.all() }];
    },
  };

  async function handle(req, res) {
    securityHeaders(req, res);
    const url = new URL(req.url, 'http://localhost');
    try {
      // QR code image: GET /api/admin/qr/12.svg
      const qrMatch = req.method === 'GET' && url.pathname.match(/^\/api\/admin\/qr\/(\d+)\.svg$/);
      if (qrMatch) {
        requireRole(req, 'admin', 'analyst');
        const code = q.qrById.get(Number(qrMatch[1]));
        if (!code) throw new HttpError(404, 'QR code not found.');
        const link = `${qrBase(req).base}/?gym=${code.gym_id}&qr=${code.code_value}`;
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(qr.toSvg(link));
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/export.csv') {
        requireRole(req, 'admin', 'analyst');
        const rows = q.exportRows.all();
        const cols = ['checkin_id', 'visitor_id', 'gym_name', 'check_in_at', 'check_out_at', 'minutes', 'method', 'checkout_method'];
        const cell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gym_checkins.csv"', 'Cache-Control': 'no-store' });
        return res.end(csv);
      }

      if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
        if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/admin') &&
            !['/api/login', '/api/logout', '/api/me', '/api/analytics'].includes(url.pathname) &&
            !visitorLimiter(clientIp(req))) {
          throw new HttpError(429, 'Too many requests. Please wait a minute.');
        }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) throw new HttpError(404, 'Not found.');
        const [status, body, headers] = await route(req, url);
        return sendJson(res, status, body, headers);
      }

      return serveStatic(url.pathname, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 400) log('rejected_input', { path: url.pathname, reason: err.message });
        return sendJson(res, err.status, { error: err.message });
      }
      console.error(err);
      return sendJson(res, 500, { error: 'Internal server error.' });
    }
  }

  function serveStatic(pathname, res) {
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/admin') pathname = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden.' }); // blocks ../ tricks
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'Not found.' });
      const ext = path.extname(file);
      const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(data);
    });
  }

  const server = http.createServer(handle);
  const timer = setInterval(runAutoCheckout, 60e3); // R8: auto check-out every minute
  timer.unref();
  server.on('close', () => { clearInterval(timer); db.close(); });
  return { server, db, q, runAutoCheckout };
}

module.exports = { createApp };

if (require.main === module) {
  const dbFile = process.env.DB_FILE || path.join(__dirname, 'gym_crowd_tracker.sqlite');
  if (!fs.existsSync(dbFile)) {
    console.error('Database not found. Run "npm run setup" first.');
    process.exit(1);
  }
  // "npm run phone" (= --phone) opens the server to the local Wi-Fi so phones can scan the QR codes
  if (process.argv.includes('--phone')) process.env.HOST = '0.0.0.0';
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '127.0.0.1';
  createApp(dbFile).server.listen(PORT, HOST, () => {
    console.log(`Gym Crowd Tracker running: http://localhost:${PORT}`);
    console.log(`Staff dashboard:          http://localhost:${PORT}/admin`);
    if (HOST === '0.0.0.0') {
      const ip = lanAddress();
      console.log(ip ? `Phone (same Wi-Fi):       http://${ip}:${PORT}   <- open this on the phone first to test` : 'No Wi-Fi address found: connect the laptop to Wi-Fi or a phone hotspot.');
      console.log('QR codes in the staff dashboard now point to the Wi-Fi address.');
    } else {
      console.log('Phones cannot reach this server. To scan QR codes with a phone, stop it (Ctrl+C) and run: npm run phone');
    }
  });
}
