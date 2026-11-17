# Gym Crowd Tracker

Shows gym visitors in Astana how busy a gym is **right now** and when it is usually quiet, using
anonymous QR check-ins. Staff get a private dashboard with attendance statistics, QR code management
and a simulated doorway-sensor extension.

ICT Project (Stage 2 End-term and Final) · Group **SE-2620** · Shokayev Daulet, Taubay Nurkanat, Irbayev Islamnur

---

## Features

* **Visitor:** live crowd level with a ring gauge (Low / Medium / High), QR check-in and check-out, anonymous code,
  usual arrivals per hour for today's weekday, "best time to go today", today's check-ins, personal visit history
  ("My visits"), all gyms at a glance, optional chime with a text twin, Low-level notification.
* **Staff:** sign-in with roles, KPIs, live levels, check-ins per day, three SQL analyses with the exact SQL shown,
  CSV export (no visitor codes), QR codes with printable door posters and rotation, simulated doorway sensors,
  staff account registration.
* **Everywhere:** light, dark and automatic theme (button in the header), works from 360 px, keyboard and
  screen-reader friendly, no external libraries or fonts.

## 1. Requirements

* **Node.js 22.13 or newer** (uses the built-in `node:sqlite` module). Check with `node --version`.
* No `npm install` is needed: the project uses only Node.js built-in modules.
* Optional: [DB Browser for SQLite](https://sqlitebrowser.org/) to look inside the database.

## 2. Run locally

```bash
npm run setup     # creates gym_crowd_tracker.sqlite with test data (run again to reset)
npm start         # http://127.0.0.1:3000  (visitor screen)
                  # http://127.0.0.1:3000/admin  (staff dashboard)
npm test          # 16 automated API tests
npm run simulate  # optional: simulated doorway sensors write 7 readings every 30 s (Ctrl+C to stop)
npm run sql -- "SELECT gym_name, capacity FROM gym"   # run any SQL query (no argument = interactive)
```

Run `npm run setup` right before a demo: the 110 "people inside now" are created relative to the
current time and are checked out automatically after 3 hours (requirement R8).

### Scanning QR codes with a real phone
Phone and laptop must be on the same Wi-Fi (or connect the laptop to the phone's hotspot).

```bash
npm run phone     # instead of npm start
```

The console prints a "Phone" address such as `http://192.168.1.25:3000`. Open it in the phone browser first:
if it loads, the QR codes in the staff dashboard (which now contain that address) will work too.
If Windows asks whether Node.js may use the network, allow it (also for public networks).

## 3. Test accounts

| Role | Username | Password | Can do |
|---|---|---|---|
| Visitor | – (no account) | – | Use test codes **V-0001 … V-0020**, or tap "Get anonymous code" |
| Admin | `admin` | `Admin#2026` | Statistics, QR code rotation, sensor simulation |
| Analyst | `analyst` | `Analyst#2026` | Statistics only (read-only, gets HTTP 403 on changes) |
| Team admins | `daulet`, `nurkanat` | `Team#2026` | Same as admin |
| Team analyst | `islamnur` | `Team#2026` | Same as analyst |

These are demo credentials for a classroom prototype. Change them before any real deployment.

## 4. Public hosting (HTTPS)

The repository contains `render.yaml`. On [render.com](https://render.com): **New → Blueprint →**
select this repository. Render installs nothing, runs `npm run setup`, starts the server and gives a
public `https://…onrender.com` link with a TLS certificate. The app detects HTTPS
(`X-Forwarded-Proto`) and then adds the `Secure` cookie flag and the HSTS header.
Note: on the free plan the database file is recreated on every deploy and the service sleeps after
15 minutes without traffic (first request then takes ~30 s).

## 5. Project structure

```
server.js              HTTP server, routing, API endpoints, security headers, static files
lib/db.js              all SQL statements (bound "?" parameters only), crowd level, local time
lib/auth.js            scrypt password hashing, sessions, rate limiting
lib/qr.js              QR code generator (SVG), no external package
lib/log.js             security log -> logs/app.log
db/schema.sql          database schema (6 tables, constraints, indexes)
scripts/setup.js       creates the database and reproducible test data
scripts/simulate.js    simulated doorway sensors (smart extension)
public/                visitor screen (index.html, app.js), staff dashboard (admin.html, admin.js),
                       QR poster (poster.html, poster.js), theme switch (theme.js), style.css,
                       logo, notification chime (MP3, 64 kbps mono)
analysis/analysis_queries.sql   the three analysis queries (Q1-Q3)
tests/api.test.js      automated tests (node:test)
scripts/sql.js         SQL query runner: npm run sql
docs/                  defense guide, external usability test form
```

## 6. API overview

| Method & path | Access | Purpose |
|---|---|---|
| `GET /api/gyms` | public | all gyms with people inside and crowd level |
| `GET /api/busy-hours?gym=1&weekday=0..6\|all` | public | average arrivals per hour for a weekday or all days (R4) |
| `GET /api/today?gym=1` | public | today's arrivals per hour |
| `POST /api/my-visits` `{code}` | holder of the code | own visit count, hours, favourite gym, last 5 visits |
| `POST /api/visitors` `{consent, gymId}` | public | issue a new anonymous code |
| `POST /api/status` `{code}` | public | is this code checked in? |
| `POST /api/checkin` `{code, gymId, qr?}` | public | check in (409 if already inside) |
| `POST /api/checkout` `{code, qr?}` | public | check out (409 if no active visit) |
| `POST /api/login` / `POST /api/logout` / `GET /api/me` | – | staff session |
| `GET /api/analytics` | admin, analyst | summary, live levels, hourly / by gym / duration / daily |
| `GET /api/admin/qr`, `GET /api/admin/qr/:id.svg` | admin, analyst | active QR codes and images |
| `POST /api/admin/qr/rotate` | admin | replace an entrance/exit code |
| `POST /api/sensor/simulate`, `GET /api/sensor/readings` | admin / admin, analyst | smart extension |
| `GET /api/admin/users`, `POST /api/admin/users` | admin | list / register staff accounts (scrypt hash + salt) |
| `GET /api/admin/export.csv` | admin, analyst | all visits as CSV, without visitor codes |
| `GET /health` | public | uptime check (R13) |

Crowd level: **Low** under 35 % of capacity, **Medium** 35–74 %, **High** 75 % and more.

## 7. Security summary

* Visitors are pseudonymous (`V-…` code only; no name, e-mail, phone). New codes are 6 random characters.
* Staff passwords: scrypt hash + 16-byte random salt per account; constant-time comparison.
* Session: 32-byte random token in an `HttpOnly; SameSite=Strict` cookie, 30-minute expiry, logout deletes it.
* Roles checked on the server for every protected endpoint (401 not signed in, 403 wrong role).
* SQL injection: all SQL in `lib/db.js` uses bound `?` parameters; input validated with regular expressions.
* XSS: dynamic text inserted with `textContent`; strict Content-Security-Policy (no inline scripts or styles).
* Rate limiting: 5 sign-in attempts / minute / IP; 60 visitor API requests / minute / IP.
* Headers: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, HSTS on HTTPS.
* Data minimisation: aggregates only in analytics; security log never stores passwords, tokens or codes.

## 8. Licence and assets

Code: MIT. Logo, icons and chime were made by the team (no third-party media).
