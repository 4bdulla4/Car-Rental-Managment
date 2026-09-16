'use strict';
/**
 * Shared setup for tests that need a database.
 * libSQL runs against a local file, so each test file gets its own throwaway
 * database and no external service is needed.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrenter-test-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.DATABASE_AUTH_TOKEN = '';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-not-a-real-key';

async function reset() {
  const db = require('../../src/db');
  await db.ready();
  for (const table of ['rentals', 'cars', 'customers', 'users', 'settings']) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  return db;
}

module.exports = { available: true, reset, dir };
