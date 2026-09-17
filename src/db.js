'use strict';
const { createClient } = require('@libsql/client');
const config = require('./config');

// One client per process, created on first use so a deployment missing its
// database configuration can render the setup page instead of crashing.
let _client = null;
function getClient() {
  if (!_client) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set. See the Deploying section of the README.');
    }
    _client = createClient({
      url: config.databaseUrl,
      authToken: config.databaseAuthToken || undefined
    });
  }
  return _client;
}

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v);

/**
 * The small statement API the routes use. libSQL is asynchronous, so every call
 * returns a promise; the SQL itself is plain SQLite with `?` placeholders.
 */
function statement(runner, sql) {
  return {
    async get(...args) {
      const { rows } = await runner.execute({ sql, args });
      return rows[0];
    },
    async all(...args) {
      const { rows } = await runner.execute({ sql, args });
      return rows;
    },
    async run(...args) {
      const result = await runner.execute({ sql, args });
      return {
        changes: toNumber(result.rowsAffected),
        // A RETURNING clause reports the id in the row rather than lastInsertRowid.
        lastInsertRowid: result.rows[0] && result.rows[0].id !== undefined
          ? toNumber(result.rows[0].id)
          : toNumber(result.lastInsertRowid)
      };
    }
  };
}

const prepare = (sql) => statement(getClient(), sql);
const exec = (sql) => getClient().executeMultiple(sql);

/** Runs fn inside a write transaction. */
async function tx(fn) {
  const transaction = await getClient().transaction('write');
  try {
    const result = await fn({ prepare: (sql) => statement(transaction, sql) });
    await transaction.commit();
    return result;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

const SCHEMA = `
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
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no            TEXT NOT NULL UNIQUE,
  car_id                 INTEGER NOT NULL REFERENCES cars(id),
  customer_id            INTEGER NOT NULL REFERENCES customers(id),
  start_date             TEXT NOT NULL,
  end_date               TEXT NOT NULL,
  daily_rate             REAL NOT NULL,
  km_allowance_per_day   INTEGER NOT NULL DEFAULT 0,
  excess_km_rate         REAL NOT NULL DEFAULT 0,
  deposit                REAL NOT NULL DEFAULT 0,
  discount               REAL NOT NULL DEFAULT 0,
  pickup_odometer        INTEGER NOT NULL DEFAULT 0,
  pickup_fuel            INTEGER NOT NULL DEFAULT 8,
  pickup_notes           TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  handover_signed_at     TEXT,
  return_date            TEXT,
  return_odometer        INTEGER,
  return_fuel            INTEGER,
  damage_charge          REAL DEFAULT 0,
  other_charges          REAL DEFAULT 0,
  return_notes           TEXT,
  late_fee               REAL DEFAULT 0,
  excess_km_fee          REAL DEFAULT 0,
  fuel_fee               REAL DEFAULT 0,
  base_charge            REAL DEFAULT 0,
  total_amount           REAL DEFAULT 0,
  balance_due            REAL DEFAULT 0,
  currency               TEXT,
  fuel_charge_per_eighth REAL,
  late_day_multiplier    REAL,
  closed_at              TEXT,
  created_by             INTEGER REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_car ON rentals(car_id);
CREATE INDEX IF NOT EXISTS idx_rentals_customer ON rentals(customer_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Created once per process and awaited before the first request is served.
let schemaReady = null;
function ready() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = getClient();
      await client.executeMultiple(SCHEMA);
      await client.execute({
        sql: 'UPDATE rentals SET currency = ? WHERE currency IS NULL',
        args: [config.currency]
      });
      await client.execute({
        sql: 'UPDATE rentals SET fuel_charge_per_eighth = ? WHERE fuel_charge_per_eighth IS NULL',
        args: [config.fuelChargePerEighth]
      });
      await client.execute({
        sql: 'UPDATE rentals SET late_day_multiplier = ? WHERE late_day_multiplier IS NULL',
        args: [config.lateDayMultiplier]
      });

      // Added later, for the fields the printed agreement asks for.
      const columns = [
        ['customers', 'emergency_name', 'TEXT'],
        ['customers', 'emergency_phone', 'TEXT'],
        ['rentals', 'start_time', 'TEXT'],
        ['rentals', 'end_time', 'TEXT'],
        ['rentals', 'deductible', 'REAL'],
        ['rentals', 'return_location', 'TEXT']
      ];
      for (const [table, column, type] of columns) {
        const info = await client.execute(`PRAGMA table_info(${table})`);
        if (!info.rows.some((r) => r.name === column)) {
          await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
      }
    })();
  }
  return schemaReady;
}

const close = async () => {
  if (_client) _client.close();
  _client = null;
  schemaReady = null;
};

module.exports = { prepare, exec, tx, ready, close };
