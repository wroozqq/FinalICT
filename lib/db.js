'use strict';
// Data layer: every SQL statement of the application lives in this file.
// All user values are passed through "?" placeholders (bound parameters),
// never glued into the SQL text, so SQL injection is not possible.
const { DatabaseSync } = require('node:sqlite');

const TZ_OFFSET_HOURS = 5; // Astana, UTC+5

// Current local time as 'YYYY-MM-DD HH:MM:SS' (the format SQLite date functions understand)
function nowLocal(offsetMinutes = 0) {
  const ms = Date.now() + TZ_OFFSET_HOURS * 3600e3 + offsetMinutes * 60e3;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Crowd level from the share of capacity that is used (requirement R3)
function crowdLevel(inside, capacity) {
  const percent = Math.round((inside / capacity) * 100);
  const level = percent < 35 ? 'Low' : percent < 75 ? 'Medium' : 'High';
  return { percent, level };
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');

  const q = {
    gyms: db.prepare(`
      SELECT g.gym_id, g.gym_name, g.capacity, g.opens_at, g.closes_at,
             (SELECT COUNT(*) FROM checkin c WHERE c.gym_id = g.gym_id AND c.check_out_at IS NULL) AS inside
      FROM gym g ORDER BY g.gym_id`),
    gym: db.prepare('SELECT * FROM gym WHERE gym_id = ?'),
    visitorByCode: db.prepare(`
      SELECT v.visitor_id, v.visitor_code, v.gym_id, g.gym_name
      FROM visitor v JOIN gym g ON g.gym_id = v.gym_id
      WHERE v.visitor_code = ?`),
    insertVisitor: db.prepare(
      'INSERT INTO visitor (visitor_code, consent_given, registered_at, gym_id) VALUES (?, 1, ?, ?)'),
    openVisit: db.prepare(`
      SELECT c.checkin_id, c.gym_id, c.check_in_at, g.gym_name
      FROM checkin c JOIN gym g ON g.gym_id = c.gym_id
      WHERE c.visitor_id = ? AND c.check_out_at IS NULL`),
    insertCheckin: db.prepare(`
      INSERT INTO checkin (visitor_id, gym_id, code_id, check_in_at, method, source)
      VALUES (?, ?, ?, ?, ?, 'real')`),
    closeVisit: db.prepare(`
      UPDATE checkin SET check_out_at = ?, checkout_method = ?
      WHERE checkin_id = ? AND check_out_at IS NULL`),
    // R8: close every visit that is older than the gym's auto_checkout_hours (default 3)
    autoCheckout: db.prepare(`
      UPDATE checkin
      SET check_out_at = datetime(check_in_at,
            '+' || (SELECT g.auto_checkout_hours FROM gym g WHERE g.gym_id = checkin.gym_id) || ' hours'),
          checkout_method = 'auto'
      WHERE check_out_at IS NULL
        AND datetime(check_in_at,
            '+' || (SELECT g.auto_checkout_hours FROM gym g WHERE g.gym_id = checkin.gym_id) || ' hours') <= ?`),
    qrByValue: db.prepare('SELECT * FROM qr_code WHERE code_value = ?'),
    qrList: db.prepare(`
      SELECT q.code_id, q.gym_id, g.gym_name, q.code_type, q.code_value, q.created_at
      FROM qr_code q JOIN gym g ON g.gym_id = q.gym_id
      WHERE q.active = 1 ORDER BY q.gym_id, q.code_type`),
    qrById: db.prepare('SELECT * FROM qr_code WHERE code_id = ? AND active = 1'),
    qrDeactivate: db.prepare('UPDATE qr_code SET active = 0 WHERE gym_id = ? AND code_type = ? AND active = 1'),
    qrInsert: db.prepare('INSERT INTO qr_code (gym_id, code_type, code_value, active, created_at) VALUES (?, ?, ?, 1, ?)'),
    adminByName: db.prepare('SELECT * FROM admin_user WHERE username = ?'),
    adminLogin: db.prepare('UPDATE admin_user SET last_login_at = ? WHERE admin_id = ?'),
    adminList: db.prepare('SELECT admin_id, username, role, last_login_at FROM admin_user ORDER BY admin_id'),
    insertAdmin: db.prepare('INSERT INTO admin_user (username, password_hash, password_salt, role) VALUES (?, ?, ?, ?)'),
    // R4: average number of arrivals per hour for one gym on one weekday (0 = Sunday), completed visits only
    busyHours: db.prepare(`
      SELECT CAST(strftime('%H', check_in_at) AS INTEGER) AS hour,
             ROUND(COUNT(*) * 1.0 / MAX(1, (SELECT COUNT(DISTINCT date(check_in_at)) FROM checkin
                    WHERE gym_id = ?1 AND check_out_at IS NOT NULL AND CAST(strftime('%w', check_in_at) AS INTEGER) = ?2)), 1) AS avg_arrivals,
             COUNT(*) AS visits
      FROM checkin
      WHERE gym_id = ?1 AND check_out_at IS NOT NULL AND CAST(strftime('%w', check_in_at) AS INTEGER) = ?2
      GROUP BY hour ORDER BY hour`),
    // Part C analysis: the same three queries as analysis/analysis_queries.sql (completed visits)
    hourly: db.prepare(`
      SELECT CAST(strftime('%H', check_in_at) AS INTEGER) AS hour, COUNT(*) AS visits
      FROM checkin WHERE check_out_at IS NOT NULL
      GROUP BY hour ORDER BY hour`),
    byGym: db.prepare(`
      SELECT g.gym_name AS gym, COUNT(c.checkin_id) AS visits
      FROM gym g LEFT JOIN checkin c ON c.gym_id = g.gym_id AND c.check_out_at IS NOT NULL
      GROUP BY g.gym_id ORDER BY visits DESC, g.gym_name`),
    duration: db.prepare(`
      SELECT g.gym_name AS gym,
             ROUND(AVG((julianday(c.check_out_at) - julianday(c.check_in_at)) * 1440), 1) AS average_minutes
      FROM gym g JOIN checkin c ON c.gym_id = g.gym_id
      WHERE c.check_out_at IS NOT NULL
      GROUP BY g.gym_id ORDER BY average_minutes DESC`),
    daily: db.prepare(`
      SELECT date(check_in_at) AS day, COUNT(*) AS visits
      FROM checkin WHERE date(check_in_at) >= date(?, '-13 days')
      GROUP BY day ORDER BY day`),
    summary: db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(check_out_at IS NOT NULL) AS completed,
             SUM(check_out_at IS NULL) AS open,
             SUM(date(check_in_at) = date(?)) AS today,
             SUM(checkout_method = 'auto') AS auto_closed
      FROM checkin`),
    insertReading: db.prepare(`
      INSERT INTO sensor_reading (gym_id, reading_at, estimated_occupancy, quality_flag, origin)
      VALUES (?, ?, ?, 'simulated', 'simulation')`),
    // Same profile over all days of the week (used when one weekday has too few visits)
    busyHoursAll: db.prepare(`
      SELECT CAST(strftime('%H', check_in_at) AS INTEGER) AS hour,
             ROUND(COUNT(*) * 1.0 / MAX(1, (SELECT COUNT(DISTINCT date(check_in_at)) FROM checkin
                    WHERE gym_id = ?1 AND check_out_at IS NOT NULL)), 1) AS avg_arrivals,
             COUNT(*) AS visits
      FROM checkin WHERE gym_id = ?1 AND check_out_at IS NOT NULL
      GROUP BY hour ORDER BY hour`),
    // Today's arrivals per hour for one gym (live trend on the visitor screen)
    today: db.prepare(`
      SELECT CAST(strftime('%H', check_in_at) AS INTEGER) AS hour, COUNT(*) AS arrivals
      FROM checkin WHERE gym_id = ? AND date(check_in_at) = date(?)
      GROUP BY hour ORDER BY hour`),
    // A visitor's own history (only for the holder of the code)
    myStats: db.prepare(`
      SELECT COUNT(*) AS visits,
             COALESCE(ROUND(SUM((julianday(check_out_at) - julianday(check_in_at)) * 1440)), 0) AS minutes,
             SUM(date(check_in_at) >= date(?, '-6 days')) AS last7
      FROM checkin WHERE visitor_id = ? AND check_out_at IS NOT NULL`),
    myFavourite: db.prepare(`
      SELECT g.gym_name AS gym, COUNT(*) AS visits FROM checkin c JOIN gym g ON g.gym_id = c.gym_id
      WHERE c.visitor_id = ? GROUP BY c.gym_id ORDER BY visits DESC LIMIT 1`),
    myRecent: db.prepare(`
      SELECT g.gym_name AS gym, c.check_in_at, c.check_out_at, c.checkout_method,
             ROUND((julianday(c.check_out_at) - julianday(c.check_in_at)) * 1440) AS minutes
      FROM checkin c JOIN gym g ON g.gym_id = c.gym_id
      WHERE c.visitor_id = ? ORDER BY c.check_in_at DESC LIMIT 5`),
    // CSV export for staff: no visitor codes, only the internal pseudonymous id
    exportRows: db.prepare(`
      SELECT c.checkin_id, c.visitor_id, g.gym_name, c.check_in_at, c.check_out_at,
             ROUND((julianday(c.check_out_at) - julianday(c.check_in_at)) * 1440, 1) AS minutes,
             c.method, c.checkout_method
      FROM checkin c JOIN gym g ON g.gym_id = c.gym_id ORDER BY c.check_in_at`),
    readings: db.prepare(`
      SELECT r.reading_id, g.gym_name, r.reading_at, r.estimated_occupancy, r.quality_flag, r.origin
      FROM sensor_reading r JOIN gym g ON g.gym_id = r.gym_id
      ORDER BY r.reading_id DESC LIMIT 21`),
  };
  return { db, q };
}

module.exports = { openDb, nowLocal, crowdLevel, TZ_OFFSET_HOURS };
