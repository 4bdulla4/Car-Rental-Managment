'use strict';
/**
 * Shared setup for tests that need a database.
 * TEST_DATABASE_URL is required and must point at a throwaway Postgres: reset()
 * truncates every table, so it must never be allowed to fall back to
 * DATABASE_URL and wipe a development database.
 */
require('dotenv').config();

const url = process.env.TEST_DATABASE_URL || '';
const available = Boolean(url);

if (available) process.env.DATABASE_URL = url;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-not-a-real-key';

async function reset() {
  if (!available) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Point it at a throwaway Postgres database, ' +
      'e.g. TEST_DATABASE_URL=postgresql://user@localhost:5432/carrenter_test npm test'
    );
  }
  const db = require('../../src/db');
  await db.ready();
  await db.exec('TRUNCATE rentals, cars, customers, users, settings RESTART IDENTITY CASCADE');
  return db;
}

module.exports = { available, reset };
