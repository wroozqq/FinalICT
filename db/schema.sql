-- Gym Crowd Tracker - final schema (SQLite, 3NF)
-- All times are stored as local Astana time (UTC+5) text: 'YYYY-MM-DD HH:MM:SS'.
PRAGMA foreign_keys = ON;

CREATE TABLE gym (
  gym_id              INTEGER PRIMARY KEY,
  gym_name            TEXT    NOT NULL UNIQUE,
  city                TEXT    NOT NULL DEFAULT 'Astana',
  capacity            INTEGER NOT NULL CHECK (capacity > 0),
  opens_at            TEXT    NOT NULL,
  closes_at           TEXT    NOT NULL,
  auto_checkout_hours INTEGER NOT NULL DEFAULT 3 CHECK (auto_checkout_hours BETWEEN 1 AND 6)
);

-- Pseudonymous visitor: no name, e-mail or phone number is stored.
CREATE TABLE visitor (
  visitor_id    INTEGER PRIMARY KEY,
  visitor_code  TEXT    NOT NULL UNIQUE,
  consent_given INTEGER NOT NULL DEFAULT 0 CHECK (consent_given IN (0, 1)),
  registered_at TEXT    NOT NULL,
  gym_id        INTEGER NOT NULL REFERENCES gym(gym_id) ON DELETE RESTRICT
);

-- Entrance ('in') and exit ('out') QR codes; old codes are kept but deactivated.
CREATE TABLE qr_code (
  code_id    INTEGER PRIMARY KEY,
  gym_id     INTEGER NOT NULL REFERENCES gym(gym_id),
  code_type  TEXT    NOT NULL CHECK (code_type IN ('in', 'out')),
  code_value TEXT    NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT    NOT NULL
);

CREATE TABLE checkin (
  checkin_id      INTEGER PRIMARY KEY,
  visitor_id      INTEGER NOT NULL REFERENCES visitor(visitor_id) ON DELETE RESTRICT,
  gym_id          INTEGER NOT NULL REFERENCES gym(gym_id),
  code_id         INTEGER REFERENCES qr_code(code_id),
  check_in_at     TEXT    NOT NULL,
  check_out_at    TEXT,
  method          TEXT    NOT NULL DEFAULT 'manual' CHECK (method IN ('qr', 'manual')),
  checkout_method TEXT    CHECK (checkout_method IN ('qr', 'manual', 'auto')),
  source          TEXT    NOT NULL DEFAULT 'real' CHECK (source IN ('real', 'seed')),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
-- Only ONE open visit per visitor is possible (enforced by the database itself).
CREATE UNIQUE INDEX idx_checkin_open ON checkin(visitor_id) WHERE check_out_at IS NULL;
CREATE INDEX idx_checkin_gym_open ON checkin(gym_id, check_out_at);
CREATE INDEX idx_checkin_time ON checkin(check_in_at);

-- Staff accounts. Passwords are stored only as scrypt hashes with a random salt.
CREATE TABLE admin_user (
  admin_id      INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'analyst')),
  last_login_at TEXT
);

-- Smart extension (simulated doorway beam counters). Aggregate numbers only.
CREATE TABLE sensor_reading (
  reading_id          INTEGER PRIMARY KEY,
  gym_id              INTEGER NOT NULL REFERENCES gym(gym_id),
  reading_at          TEXT    NOT NULL,
  estimated_occupancy INTEGER NOT NULL CHECK (estimated_occupancy >= 0),
  quality_flag        TEXT    NOT NULL CHECK (quality_flag IN ('ok', 'suspect', 'simulated')),
  origin              TEXT    NOT NULL CHECK (origin IN ('sensor', 'simulation'))
);
