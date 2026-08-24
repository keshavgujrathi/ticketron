// db.js — SQLite (file-based) with WAL mode for safe concurrent transactions.
// SQLite serializes writers at the engine level, which we lean on heavily for
// seat-hold concurrency safety (see services/seatEngine.js for why this is
// enough, and where it would stop being enough at scale).
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbFile = process.env.DB_FILE || './data/ticketron.db';
const dir = path.dirname(dbFile);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer','organiser','admin')),
  reliability_score REAL NOT NULL DEFAULT 1.0, -- used by the waitlist smart-ordering ("Ghost Queue")
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Master seat layout for a venue (reused across every show at that venue)
CREATE TABLE IF NOT EXISTS venue_seats (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  row_label TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  category TEXT NOT NULL,
  UNIQUE(venue_id, section, row_label, seat_number)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  organiser_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('movie','concert')),
  description TEXT,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A single date/time screening or performance of an event
CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date_time TEXT NOT NULL,
  category_prices TEXT NOT NULL, -- JSON: {"Premium":500,"Standard":250}
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-show seat state — this is the row that concurrency protection revolves around.
CREATE TABLE IF NOT EXISTS show_seats (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  venue_seat_id TEXT NOT NULL REFERENCES venue_seats(id),
  category TEXT NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','held','booked')),
  held_by TEXT REFERENCES users(id),
  hold_id TEXT,
  hold_expires_at TEXT,
  UNIQUE(show_id, venue_seat_id)
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  seat_ids TEXT NOT NULL, -- JSON array of show_seats.id
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','confirmed','expired','cancelled')),
  is_waitlist_offer INTEGER NOT NULL DEFAULT 0,
  waitlist_entry_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  ref_code TEXT UNIQUE NOT NULL,
  show_id TEXT NOT NULL REFERENCES shows(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  seat_ids TEXT NOT NULL, -- JSON array of show_seats.id
  total_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
  qr_data_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);

-- One row per customer per (show, category) they're waiting for.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id),
  category TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','offered','booked','expired','cancelled')),
  offer_hold_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(show_id, category, customer_id)
);
`);

module.exports = db;
