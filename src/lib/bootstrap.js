'use strict';
const db = require('../db');
const { hashPassword } = require('./passwords');

/**
 * Creates the admin account named by SEED_ADMIN_* at startup, because a hosted
 * deployment has no interactive shell to run `npm run seed` in.
 *
 * It creates the account when that email is not already registered, rather than
 * only when the database is completely empty: otherwise a single stray account
 * left over from an earlier attempt silently blocks the seed and locks the owner
 * out with no way back in. Whoever can set the variables can already redeploy
 * the app, so this grants no access they did not have.
 *
 * An existing account is never modified — a password is not silently reset —
 * and the password is never logged.
 */
async function ensureFirstAdmin() {
  const email = String(process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SEED_ADMIN_PASSWORD || '');
  const name = process.env.SEED_ADMIN_NAME || 'Administrator';

  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  const userCount = Number(n);

  if (!email || !password) {
    if (userCount === 0) {
      console.warn('No users exist and SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD are not set — nobody can sign in.');
    }
    return false;
  }

  if (password.length < 10) {
    console.warn('SEED_ADMIN_PASSWORD is shorter than 10 characters — no account was created.');
    return false;
  }

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    console.log(`Admin ${email} already exists — leaving it untouched. Use Users → Reset password to change it.`);
    return false;
  }

  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run(email, name, hashPassword(password));
  console.log(
    userCount === 0
      ? `Created first admin account: ${email}`
      : `Created admin account ${email} alongside ${userCount} existing user(s).`
  );
  return true;
}

module.exports = { ensureFirstAdmin };
