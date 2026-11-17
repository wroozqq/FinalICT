'use strict';
// Automated system tests: start the real server on a temporary database and call the HTTP API.
// Run with: npm test
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('../scripts/setup');
const { createApp } = require('../server');
const { nowLocal } = require('../lib/db');

const dbFile = path.join(os.tmpdir(), `gct-test-${process.pid}.sqlite`);
let app; let base; let adminCookie; let analystCookie;

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
const inside = async (gymId) => (await call('GET', '/api/gyms')).body.gyms.find((g) => g.gymId === gymId).inside;
const login = async (u, p) => {
  const r = await call('POST', '/api/login', { username: u, password: p });
  return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

before(async () => {
  setup(dbFile);
  app = createApp(dbFile);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); fs.rmSync(dbFile, { force: true }); });

test('1. public gym list: 7 gyms with crowd level', async () => {
  const r = await call('GET', '/api/gyms');
  assert.equal(r.status, 200);
  assert.equal(r.body.gyms.length, 7);
  for (const g of r.body.gyms) assert.match(g.level, /^(Low|Medium|High)$/);
});

test('2. visitor journey: status -> check-in (+1) -> check-out (-1)', async () => {
  const before = await inside(1);
  let r = await call('POST', '/api/status', { code: 'V-0001' });
  assert.equal(r.status, 200); assert.equal(r.body.active, false);
  r = await call('POST', '/api/checkin', { code: 'v-0001', gymId: 1 });
  assert.equal(r.status, 200);
  assert.equal(await inside(1), before + 1);
  r = await call('POST', '/api/checkout', { code: 'V-0001' });
  assert.equal(r.status, 200);
  assert.equal(await inside(1), before);
});

test('3. double check-in and check-out without visit return 409', async () => {
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0002', gymId: 2 })).status, 200);
  const dup = await call('POST', '/api/checkin', { code: 'V-0002', gymId: 3 });
  assert.equal(dup.status, 409); assert.match(dup.body.error, /already checked in/);
  assert.equal((await call('POST', '/api/checkout', { code: 'V-0002' })).status, 200);
  assert.equal((await call('POST', '/api/checkout', { code: 'V-0002' })).status, 409);
});

test('4. SQL injection attempt and unknown code are rejected', async () => {
  const inj = await call('POST', '/api/checkin', { code: "V-0001' OR '1'='1", gymId: 1 });
  assert.equal(inj.status, 400);
  assert.equal((await call('POST', '/api/status', { code: 'V-9999' })).status, 404);
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0003', gymId: 99 })).status, 404);
});

test('5. new anonymous code requires consent', async () => {
  assert.equal((await call('POST', '/api/visitors', { gymId: 1 })).status, 400);
  const r = await call('POST', '/api/visitors', { consent: true, gymId: 1 });
  assert.equal(r.status, 201); assert.match(r.body.code, /^V-[A-Z0-9]{6}$/);
});

test('6. analytics are private: 401 without sign-in, 401 with wrong password', async () => {
  assert.equal((await call('GET', '/api/analytics')).status, 401);
  const { r } = await login('admin', 'wrong-password');
  assert.equal(r.status, 401);
});

test('7. admin sign-in sets an HttpOnly SameSite cookie and analytics returns the three datasets', async () => {
  const { r, cookie } = await login('admin', 'Admin#2026');
  assert.equal(r.status, 200); assert.equal(r.body.role, 'admin');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  adminCookie = cookie;
  const a = await call('GET', '/api/analytics', undefined, adminCookie);
  assert.equal(a.status, 200);
  assert.ok(a.body.hourly.length && a.body.byGym.length === 7 && a.body.duration.length === 7);
  assert.equal(a.body.byGym[0].gym, 'Invictus Go');
  assert.equal(a.body.duration[0].gym, 'Abyroy'); assert.equal(a.body.duration[0].average_minutes, 91.2);
});

test('8. roles: analyst can read but gets 403 on sensor simulation; admin saves 7 readings', async () => {
  const { cookie } = await login('analyst', 'Analyst#2026');
  analystCookie = cookie;
  assert.equal((await call('GET', '/api/analytics', undefined, analystCookie)).status, 200);
  assert.equal((await call('POST', '/api/sensor/simulate', {}, analystCookie)).status, 403);
  assert.equal((await call('POST', '/api/admin/qr/rotate', { gymId: 1, type: 'in' }, analystCookie)).status, 403);
  const sim = await call('POST', '/api/sensor/simulate', {}, adminCookie);
  assert.equal(sim.status, 201); assert.equal(sim.body.inserted, 7);
  const rd = await call('GET', '/api/sensor/readings', undefined, adminCookie);
  assert.equal(rd.body.readings.length, 7);
});

test('9. QR check-in: valid entrance code works, wrong type / other gym / rotated code is rejected', async () => {
  const codes = (await call('GET', '/api/admin/qr', undefined, adminCookie)).body.codes;
  const in4 = codes.find((c) => c.gym_id === 4 && c.code_type === 'in');
  const out4 = codes.find((c) => c.gym_id === 4 && c.code_type === 'out');
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0004', gymId: 4, qr: out4.code_value })).status, 400);
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0004', gymId: 5, qr: in4.code_value })).status, 400);
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0004', gymId: 4, qr: in4.code_value })).status, 200);
  assert.equal((await call('POST', '/api/checkout', { code: 'V-0004', qr: out4.code_value })).status, 200);
  const svg = await call('GET', `/api/admin/qr/${in4.code_id}.svg`, undefined, adminCookie);
  assert.equal(svg.status, 200); assert.match(svg.text, /^<svg/);
  // rotate: the old entrance code must stop working
  assert.equal((await call('POST', '/api/admin/qr/rotate', { gymId: 4, type: 'in' }, adminCookie)).status, 200);
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0005', gymId: 4, qr: in4.code_value })).status, 400);
});

test('10. R8: a visit older than 3 hours is checked out automatically', async () => {
  const v = app.db.prepare("SELECT visitor_id FROM visitor WHERE visitor_code = 'V-0006'").get();
  app.db.prepare("INSERT INTO checkin (visitor_id, gym_id, check_in_at, method) VALUES (?, 7, ?, 'manual')").run(v.visitor_id, nowLocal(-200));
  const st = await call('POST', '/api/status', { code: 'V-0006' });
  assert.equal(st.body.active, false);
  const row = app.db.prepare('SELECT checkout_method FROM checkin WHERE visitor_id = ? ORDER BY checkin_id DESC').get(v.visitor_id);
  assert.equal(row.checkout_method, 'auto');
});

test('11. R4: busy hours for a weekday are returned as averages', async () => {
  const r = await call('GET', '/api/busy-hours?gym=2&weekday=1');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.hours));
  assert.equal((await call('GET', '/api/busy-hours?gym=2&weekday=9')).status, 400);
});

test('12. security headers, path traversal blocked, health check', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.notEqual((await call('GET', '/../server.js')).status, 200);
  assert.notEqual((await call('GET', '/%2e%2e/server.js')).status, 200);
  assert.notEqual((await call('GET', '/img/..%2f..%2fserver.js')).status, 200);
  assert.equal((await call('GET', '/health')).body.status, 'ok');
});

test('13. sign out invalidates the session', async () => {
  assert.equal((await call('POST', '/api/logout', {}, adminCookie)).status, 200);
  assert.equal((await call('GET', '/api/analytics', undefined, adminCookie)).status, 401);
});

test('14. login is rate-limited (6th attempt in a minute -> 429)', async () => {
  // earlier tests used 3 attempts from this IP; keep trying until the limit is reached
  let status = 0;
  for (let i = 0; i < 6; i++) status = (await login('admin', 'bad')).r.status;
  assert.equal(status, 429);
});

test('15. admin registers a new staff member; the new account can sign in; analyst cannot register', async () => {
  // fresh sign-in: earlier tests signed out and hit the login rate limit, so call the app directly with a new session
  const auth = require('../lib/auth');
  const admin = app.q.adminByName.get('admin');
  const cookie = 'sid=' + auth.createSession(admin);
  const analyst = 'sid=' + auth.createSession(app.q.adminByName.get('analyst'));
  assert.equal((await call('POST', '/api/admin/users', { username: 'aliya', password: 'Gym12345', role: 'analyst' }, analyst)).status, 403);
  assert.equal((await call('POST', '/api/admin/users', { username: 'aliya', password: 'short', role: 'analyst' }, cookie)).status, 400);
  const r = await call('POST', '/api/admin/users', { username: 'aliya', password: 'Gym12345', role: 'analyst' }, cookie);
  assert.equal(r.status, 201);
  assert.equal((await call('POST', '/api/admin/users', { username: 'aliya', password: 'Gym12345', role: 'analyst' }, cookie)).status, 409);
  const row = app.db.prepare("SELECT password_hash, role FROM admin_user WHERE username = 'aliya'").get();
  assert.equal(row.role, 'analyst'); assert.notEqual(row.password_hash, 'Gym12345');
  assert.ok(auth.verifyPassword('Gym12345', app.db.prepare("SELECT password_salt FROM admin_user WHERE username='aliya'").get().password_salt, row.password_hash));
  const users = await call('GET', '/api/admin/users', undefined, cookie);
  assert.ok(users.body.users.some((u) => u.username === 'aliya'));
  const a = await call('GET', '/api/analytics', undefined, cookie);
  assert.match(a.body.queries.hourly, /GROUP BY hour/);
});

test('16. new features: today trend, my visits, CSV export without visitor codes', async () => {
  const auth = require('../lib/auth');
  const t = await call('GET', '/api/today?gym=1');
  assert.equal(t.status, 200); assert.ok(Array.isArray(t.body.hours));
  const expected = app.db.prepare('SELECT COUNT(*) AS n FROM checkin WHERE gym_id = 1 AND date(check_in_at) = date(?)').get(nowLocal()).n;
  assert.equal(t.body.hours.reduce((s, h) => s + h.arrivals, 0), expected); // same number as in the database
  assert.equal((await call('POST', '/api/checkin', { code: 'V-0011', gymId: 3 })).status, 200);
  assert.equal((await call('POST', '/api/checkout', { code: 'V-0011' })).status, 200);
  const m = await call('POST', '/api/my-visits', { code: 'V-0011' });
  assert.equal(m.status, 200);
  assert.ok(m.body.recent.length >= 1); assert.equal(m.body.recent[0].gym, 'Iron Club');
  assert.equal((await call('POST', '/api/my-visits', { code: 'bad' })).status, 400);
  assert.equal((await call('GET', '/api/admin/export.csv')).status, 401);
  const analyst = 'sid=' + auth.createSession(app.q.adminByName.get('analyst'));
  const csv = await call('GET', '/api/admin/export.csv', undefined, analyst);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text.split('\n')[0], /^checkin_id,visitor_id,gym_name/);
  assert.doesNotMatch(csv.text, /V-\d{4}/);
  assert.ok(csv.text.split('\n').length > 300);
});
