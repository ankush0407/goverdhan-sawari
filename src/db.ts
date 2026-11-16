import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  lang TEXT,
  name TEXT,
  state TEXT DEFAULT 'new',
  ctx TEXT DEFAULT '{}',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS drivers (
  phone TEXT PRIMARY KEY,
  name TEXT,
  vehicle_no TEXT,
  seats INTEGER,
  photo_media_id TEXT,
  rc_media_id TEXT,
  status TEXT DEFAULT 'draft',          -- draft | pending | approved | rejected
  on_duty INTEGER DEFAULT 0,
  lat REAL, lng REAL, loc_at INTEGER,
  rating_sum REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  rides_done INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_phone TEXT,
  rider_name TEXT,
  pickup_lat REAL, pickup_lng REAL, pickup_text TEXT,
  drop_key TEXT, drop_text TEXT,
  group_size INTEGER,
  when_text TEXT,
  kind TEXT,                             -- fixed | quote
  status TEXT,                           -- quoting | choosing | matched | arrived | started | completed | cancelled | no_quotes | expired
  driver_phone TEXT,
  fixed_fare INTEGER,
  agreed_fare INTEGER,
  final_fare INTEGER,
  pay_mode TEXT,
  otp TEXT,
  radius_km REAL,
  widened INTEGER DEFAULT 0,
  deadline INTEGER,
  feedback_due INTEGER,
  feedback_sent INTEGER DEFAULT 0,
  cancelled_by TEXT,
  cancel_reason TEXT,
  rider_confirmed TEXT,                  -- yes | no
  t_requested INTEGER, t_accepted INTEGER, t_arrived INTEGER,
  t_started INTEGER, t_completed INTEGER, t_cancelled INTEGER
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER,
  driver_phone TEXT,
  price INTEGER,
  eta_min INTEGER,
  status TEXT DEFAULT 'pinged',          -- pinged | sent | won | lost | skipped
  created_at INTEGER,
  quoted_at INTEGER
);
CREATE INDEX IF NOT EXISTS quotes_ride ON quotes(ride_id);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER,
  from_role TEXT,                        -- rider | driver
  rating INTEGER,
  tag TEXT,
  note TEXT,
  note_media_id TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id INTEGER,
  at INTEGER,
  kind TEXT,
  data TEXT
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
