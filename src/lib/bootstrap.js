'use strict';
const db = require('../db');
const { hashPassword } = require('./passwords');
const settings = require('./settings');
const sampleData = require('./sample-data');

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
    // Changing SEED_ADMIN_PASSWORD deliberately does not reset a live account,
    // or a stale variable would undo a password changed in the app. SEED_ADMIN_RESET
    // is the way back in when the password is genuinely lost.
    if (/^(1|true|yes)$/i.test(String(process.env.SEED_ADMIN_RESET || ''))) {
      await db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?')
        .run(hashPassword(password), existing.id);
      console.warn(
        `Reset the password for ${email} because SEED_ADMIN_RESET is set. ` +
        'Remove that variable now — while it is set, every deploy resets this password.'
      );
      return true;
    }
    console.log(`Admin ${email} already exists — leaving it untouched. Use Users → Reset password to change it, or set SEED_ADMIN_RESET=1 if the password is lost.`);
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

/**
 * Loads the demonstration records when SAMPLE_DATA is set, for the same reason
 * as ensureFirstAdmin: a hosted deployment has no shell to run a script in, and
 * a brand new installation otherwise shows empty charts. It is the startup
 * equivalent of the button in Settings → Sample data, and does nothing once the
 * sample is present, so leaving the variable set cannot duplicate it.
 */
async function ensureSampleData() {
  if (!/^(1|true|yes)$/i.test(String(process.env.SAMPLE_DATA || ''))) return false;
  await settings.load();
  const result = await sampleData.load();
  if (result.created) {
    console.log(
      `Loaded sample data because SAMPLE_DATA is set: ${result.rentals} closed contracts, ` +
      `${result.cars} cars, ${result.customers} customers. Remove it from Settings → Sample data.`
    );
  }
  return result.created;
}

module.exports = { ensureFirstAdmin, ensureSampleData };
