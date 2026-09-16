'use strict';
const { Pool } = require('pg');
const config = require('./config');

// One pool per process, created on first use so that a deployment missing
// DATABASE_URL can render a setup page instead of crashing at import.
let _pool = null;
function getPool() {
  if (!_pool) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set. See the Deploying section of the README.');
    }
    const isLocal = /@(localhost|127\.0\.0\.1)/.test(config.databaseUrl);
    _pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.pgPoolMax,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      ssl: isLocal ? false : { rejectUnauthorized: false }
    });
    _pool.on('error', (err) => console.error('Unexpected database pool error:', err));
  }
  return _pool;
}

const pool = {
  query: (...args) => getPool().query(...args),
  connect: (...args) => getPool().connect(...args),
  end: (...args) => (_pool ? _pool.end(...args) : Promise.resolve())
};

/** Rewrites the `?` placeholders used throughout the queries into $1, $2, … */
function toPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/**
 * Mirrors the small statement API the routes use, but asynchronously.
 * `run` reports `changes`, and `lastInsertRowid` when the statement RETURNs an id.
 */
function statement(runner, sql) {
  const text = toPlaceholders(sql);
  return {
    async get(...params) {
      const { rows } = await runner.query(text, params);
      return rows[0];
    },
    async all(...params) {
      const { rows } = await runner.query(text, params);
      return rows;
    },
    async run(...params) {
      const result = await runner.query(text, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined
      };
    }
  };
}

const prepare = (sql) => statement(pool, sql);
const exec = (sql) => pool.query(sql);

/** Runs fn inside a transaction on a single dedicated connection. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({ prepare: (sql) => statement(client, sql) });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Timestamps are stored as text in the same shape the views render.
const NOW = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS cars (
  id                   SERIAL PRIMARY KEY,
  plate                TEXT NOT NULL UNIQUE,
  make                 TEXT NOT NULL,
  model                TEXT NOT NULL,
  year                 INTEGER,
  color                TEXT,
  vin                  TEXT,
  transmission         TEXT DEFAULT 'automatic',
  seats                INTEGER DEFAULT 5,
  daily_rate           DOUBLE PRECISION NOT NULL DEFAULT 0,
  km_allowance_per_day INTEGER NOT NULL DEFAULT 250,
  excess_km_rate       DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  odometer             INTEGER NOT NULL DEFAULT 0,
  fuel_level           INTEGER NOT NULL DEFAULT 8,
  status               TEXT NOT NULL DEFAULT 'available',
  notes                TEXT,
  created_at           TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS customers (
  id              SERIAL PRIMARY KEY,
  full_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  id_number       TEXT,
  license_number  TEXT,
  license_expiry  TEXT,
  address         TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);

CREATE TABLE IF NOT EXISTS rentals (
  id                     SERIAL PRIMARY KEY,
  contract_no            TEXT NOT NULL UNIQUE,
  car_id                 INTEGER NOT NULL REFERENCES cars(id),
  customer_id            INTEGER NOT NULL REFERENCES customers(id),
  start_date             TEXT NOT NULL,
  end_date               TEXT NOT NULL,
  daily_rate             DOUBLE PRECISION NOT NULL,
  km_allowance_per_day   INTEGER NOT NULL DEFAULT 0,
  excess_km_rate         DOUBLE PRECISION NOT NULL DEFAULT 0,
  deposit                DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount               DOUBLE PRECISION NOT NULL DEFAULT 0,
  pickup_odometer        INTEGER NOT NULL DEFAULT 0,
  pickup_fuel            INTEGER NOT NULL DEFAULT 8,
  pickup_notes           TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  handover_signed_at     TEXT,
  return_date            TEXT,
  return_odometer        INTEGER,
  return_fuel            INTEGER,
  damage_charge          DOUBLE PRECISION DEFAULT 0,
  other_charges          DOUBLE PRECISION DEFAULT 0,
  return_notes           TEXT,
  late_fee               DOUBLE PRECISION DEFAULT 0,
  excess_km_fee          DOUBLE PRECISION DEFAULT 0,
  fuel_fee               DOUBLE PRECISION DEFAULT 0,
  base_charge            DOUBLE PRECISION DEFAULT 0,
  total_amount           DOUBLE PRECISION DEFAULT 0,
  balance_due            DOUBLE PRECISION DEFAULT 0,
  currency               TEXT,
  fuel_charge_per_eighth DOUBLE PRECISION,
  late_day_multiplier    DOUBLE PRECISION,
  closed_at              TEXT,
  created_by             INTEGER REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT ${NOW}
);

CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_car ON rentals(car_id);
CREATE INDEX IF NOT EXISTS idx_rentals_customer ON rentals(customer_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
`;

// Created once per process and awaited before the first request is served.
let schemaReady = null;
function ready() {
  if (!schemaReady) {
    schemaReady = pool.query(SCHEMA).then(async () => {
      await pool.query('UPDATE rentals SET currency = $1 WHERE currency IS NULL', [config.currency]);
      await pool.query(
        'UPDATE rentals SET fuel_charge_per_eighth = $1 WHERE fuel_charge_per_eighth IS NULL',
        [config.fuelChargePerEighth]
      );
      await pool.query(
        'UPDATE rentals SET late_day_multiplier = $1 WHERE late_day_multiplier IS NULL',
        [config.lateDayMultiplier]
      );
    });
  }
  return schemaReady;
}

module.exports = { prepare, exec, tx, ready, pool, NOW };
