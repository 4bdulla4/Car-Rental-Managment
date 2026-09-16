'use strict';
const db = require('../db');
const config = require('../config');

// Settings are read on nearly every request, so the table is cached in process
// and the cache is dropped whenever a value is written.
let cache = null;

/**
 * Reads the whole settings table, once per request.
 * It is deliberately not cached between requests: on serverless each instance
 * holds its own memory, so a cached copy would keep serving the old currency
 * after another instance changed it.
 */
async function load() {
  const next = {};
  for (const row of await db.prepare('SELECT key, value FROM settings').all()) {
    next[row.key] = row.value;
  }
  cache = next;
  return cache;
}

/** Synchronous view of what load() last read. */
function all() {
  return cache || {};
}

function get(key, fallback) {
  const value = all()[key];
  return value === undefined ? fallback : value;
}

async function set(key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value));
  // Keep the in-request view consistent with what was just written.
  if (cache) cache[key] = String(value);
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

/** Mileage terms a newly added car starts with. */
function mileage() {
  const stored = all();
  const num = (key, fallback) => {
    const parsed = Number(stored[key]);
    return stored[key] !== undefined && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    kmAllowancePerDay: num('km_allowance_per_day', config.defaultKmAllowance),
    excessKmRate: num('excess_km_rate', config.defaultExcessKmRate)
  };
}

/** Security deposit pre-filled on a new rental; staff can still override it. */
function deposit() {
  const stored = all();
  const parsed = Number(stored.default_deposit);
  return stored.default_deposit !== undefined && Number.isFinite(parsed)
    ? parsed
    : config.defaultDeposit;
}

/**
 * Standing discount pre-filled on a new rental.
 * In percent mode the rate is only a convenience for computing the figure: the
 * contract always stores a concrete amount, so the agreement stays unambiguous.
 */
function discount() {
  const stored = all();
  const parsed = Number(stored.default_discount);
  const value = stored.default_discount !== undefined && Number.isFinite(parsed)
    ? parsed
    : config.defaultDiscount;
  const mode = stored.default_discount_mode === undefined
    ? config.defaultDiscountMode
    : (stored.default_discount_mode === 'percent' ? 'percent' : 'amount');
  return { value, mode };
}

/**
 * Daily rate pre-filled when a car is added. It is only a starting point: the
 * rate that matters lives on each car, and is copied onto a rental when issued.
 */
function dailyRate() {
  const stored = all();
  const parsed = Number(stored.default_daily_rate);
  return stored.default_daily_rate !== undefined && Number.isFinite(parsed)
    ? parsed
    : config.defaultDailyRate;
}

/** A currency code is 2-5 letters, e.g. SAR, AED, USD. */
function isValidCurrency(code) {
  return /^[A-Za-z]{2,5}$/.test(String(code || '').trim());
}

module.exports = {
  load, get, set, all, currency, company, policy, mileage, deposit, discount, dailyRate,
  isValidCurrency, clearCache: () => { cache = null; }
};
