'use strict';
const db = require('../db');
const config = require('../config');

// Settings are read on nearly every request, so the table is cached in process
// and the cache is dropped whenever a value is written.
let cache = null;

function all() {
  if (!cache) {
    cache = {};
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      cache[row.key] = row.value;
    }
  }
  return cache;
}

function get(key, fallback) {
  const value = all()[key];
  return value === undefined ? fallback : value;
}

function set(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value));
  cache = null;
}

/** Currency for new records. Falls back to the CURRENCY env var until changed. */
function currency() {
  return get('currency', config.currency);
}

/**
 * Company details printed on contracts and shown in the UI.
 * A stored empty string is kept as-is; only an unset key falls back to the
 * environment, so a field can be deliberately cleared.
 */
function company() {
  const stored = all();
  const pick = (key, fallback) => (stored[key] === undefined ? fallback : stored[key]);
  return {
    name: pick('company_name', config.company.name),
    address: pick('company_address', config.company.address),
    phone: pick('company_phone', config.company.phone),
    email: pick('company_email', config.company.email),
    regNo: pick('company_reg_no', config.company.regNo)
  };
}

/** Return charges applied when a car is checked back in. */
function policy() {
  const stored = all();
  const num = (key, fallback) => {
    const parsed = Number(stored[key]);
    return stored[key] !== undefined && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    fuelChargePerEighth: num('fuel_charge_per_eighth', config.fuelChargePerEighth),
    lateDayMultiplier: num('late_day_multiplier', config.lateDayMultiplier)
  };
}

/** A currency code is 2-5 letters, e.g. SAR, AED, USD. */
function isValidCurrency(code) {
  return /^[A-Za-z]{2,5}$/.test(String(code || '').trim());
}

module.exports = { get, set, all, currency, company, policy, isValidCurrency, clearCache: () => { cache = null; } };
