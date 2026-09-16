'use strict';
const db = require('../db');
const { hashPassword } = require('./passwords');

/**
 * Creates the first admin account on a fresh database from SEED_ADMIN_* env vars.
 * Hosted deployments have no interactive shell to run `npm run seed` in, so this
 * runs at startup. It is a no-op once any user exists, and never logs the password.
 */
function ensureFirstAdmin() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const email = String(process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || '');
  const name = process.env.SEED_ADMIN_NAME || 'Administrator';

  if (!email || !password) {
    console.warn('No users exist and SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD are not set — nobody can sign in.');
    return false;
  }
  if (password.length < 10) {
    console.warn('SEED_ADMIN_PASSWORD is shorter than 10 characters — no account was created.');
    return false;
  }

  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run(email, name, hashPassword(password));
  console.log(`Created first admin account: ${email}`);
  return true;
}

module.exports = { ensureFirstAdmin };
