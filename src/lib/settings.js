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

/** A currency code is 2-5 letters, e.g. SAR, AED, USD. */
function isValidCurrency(code) {
  return /^[A-Za-z]{2,5}$/.test(String(code || '').trim());
}

module.exports = { get, set, all, currency, isValidCurrency, clearCache: () => { cache = null; } };
