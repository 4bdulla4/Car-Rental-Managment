'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cars (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  plate                TEXT NOT NULL UNIQUE,
  make                 TEXT NOT NULL,
  model                TEXT NOT NULL,
  year                 INTEGER,
  color                TEXT,
  vin                  TEXT,
  transmission         TEXT DEFAULT 'automatic',
  seats                INTEGER DEFAULT 5,
  daily_rate           REAL NOT NULL DEFAULT 0,
  km_allowance_per_day INTEGER NOT NULL DEFAULT 250,
  excess_km_rate       REAL NOT NULL DEFAULT 0.5,
  odometer             INTEGER NOT NULL DEFAULT 0,
  fuel_level           INTEGER NOT NULL DEFAULT 8,
  status               TEXT NOT NULL DEFAULT 'available',
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  id_number       TEXT,
  license_number  TEXT,
  license_expiry  TEXT,
  address         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rentals (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no          TEXT NOT NULL UNIQUE,
  car_id               INTEGER NOT NULL REFERENCES cars(id),
  customer_id          INTEGER NOT NULL REFERENCES customers(id),
  start_date           TEXT NOT NULL,
  end_date             TEXT NOT NULL,
  daily_rate           REAL NOT NULL,
  km_allowance_per_day INTEGER NOT NULL DEFAULT 0,
  excess_km_rate       REAL NOT NULL DEFAULT 0,
  deposit              REAL NOT NULL DEFAULT 0,
  discount             REAL NOT NULL DEFAULT 0,
  pickup_odometer      INTEGER NOT NULL DEFAULT 0,
  pickup_fuel          INTEGER NOT NULL DEFAULT 8,
  pickup_notes         TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  handover_signed_at   TEXT,
  return_date          TEXT,
  return_odometer      INTEGER,
  return_fuel          INTEGER,
  damage_charge        REAL DEFAULT 0,
  other_charges        REAL DEFAULT 0,
  return_notes         TEXT,
  late_fee             REAL DEFAULT 0,
  excess_km_fee        REAL DEFAULT 0,
  fuel_fee             REAL DEFAULT 0,
  base_charge          REAL DEFAULT 0,
  total_amount         REAL DEFAULT 0,
  balance_due          REAL DEFAULT 0,
  closed_at            TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_car ON rentals(car_id);
CREATE INDEX IF NOT EXISTS idx_rentals_customer ON rentals(customer_id);
`);

// --- migrations -------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

// Each rental records the currency it was written in, so changing the currency
// later never rewrites the amounts on contracts that are already signed.
if (!hasColumn('rentals', 'currency')) {
  db.exec('ALTER TABLE rentals ADD COLUMN currency TEXT');
  db.prepare('UPDATE rentals SET currency = ? WHERE currency IS NULL OR currency = \'\'')
    .run(config.currency);
}

// The fuel and late-return rates are terms printed on the agreement, so each
// rental keeps the rates it was issued under and is settled against those.
if (!hasColumn('rentals', 'fuel_charge_per_eighth')) {
  db.exec('ALTER TABLE rentals ADD COLUMN fuel_charge_per_eighth REAL');
  db.prepare('UPDATE rentals SET fuel_charge_per_eighth = ? WHERE fuel_charge_per_eighth IS NULL')
    .run(config.fuelChargePerEighth);
}
if (!hasColumn('rentals', 'late_day_multiplier')) {
  db.exec('ALTER TABLE rentals ADD COLUMN late_day_multiplier REAL');
  db.prepare('UPDATE rentals SET late_day_multiplier = ? WHERE late_day_multiplier IS NULL')
    .run(config.lateDayMultiplier);
}

module.exports = db;
