'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const { ensureFirstAdmin } = require('../src/lib/bootstrap');
const { verifyPassword } = require('../src/lib/passwords');

let db;

test.before(async () => { db = await helper.reset(); });
test.after(async () => { await db.close(); });

test.beforeEach(async () => {
  await db.prepare('DELETE FROM users').run();
  delete process.env.SEED_ADMIN_EMAIL;
  delete process.env.SEED_ADMIN_PASSWORD;
  delete process.env.SEED_ADMIN_RESET;
});

test('creates the admin on an empty database', async () => {
  process.env.SEED_ADMIN_EMAIL = 'owner@example.com';
  process.env.SEED_ADMIN_PASSWORD = 'LongEnoughPassword';

  assert.equal(await ensureFirstAdmin(), true);
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get('owner@example.com');
  assert.equal(user.role, 'admin');
  assert.equal(verifyPassword('LongEnoughPassword', user.password_hash), true);
});

test('creates the seeded admin even when another account already exists', async () => {
  // Regression: a stray account from an earlier attempt used to block the seed
  // entirely, locking the owner out with no way back in.
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run('leftover@example.com', 'Leftover', 'scrypt$00$00');

  process.env.SEED_ADMIN_EMAIL = 'owner@example.com';
  process.env.SEED_ADMIN_PASSWORD = 'LongEnoughPassword';

  assert.equal(await ensureFirstAdmin(), true);
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get('owner@example.com');
  assert.ok(user, 'the seeded admin must be created alongside the existing account');
  assert.equal(verifyPassword('LongEnoughPassword', user.password_hash), true);
});

test('never overwrites an account that already uses that email', async () => {
  process.env.SEED_ADMIN_EMAIL = 'owner@example.com';
  process.env.SEED_ADMIN_PASSWORD = 'OriginalPassword';
  await ensureFirstAdmin();

  process.env.SEED_ADMIN_PASSWORD = 'DifferentPassword';
  assert.equal(await ensureFirstAdmin(), false, 'a second run must not touch the account');

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get('owner@example.com');
  assert.equal(verifyPassword('OriginalPassword', user.password_hash), true,
    'changing the variable must not silently reset a password set in the app');
});

test('refuses a password shorter than ten characters', async () => {
  process.env.SEED_ADMIN_EMAIL = 'owner@example.com';
  process.env.SEED_ADMIN_PASSWORD = 'short';

  assert.equal(await ensureFirstAdmin(), false);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM users').get().then((r) => Number(r.n)), 0);
});

test('does nothing when the variables are absent', async () => {
  assert.equal(await ensureFirstAdmin(), false);
});

test('SEED_ADMIN_RESET restores access when the password is lost', async () => {
  process.env.SEED_ADMIN_EMAIL = 'owner@example.com';
  process.env.SEED_ADMIN_PASSWORD = 'OriginalPassword';
  await ensureFirstAdmin();

  process.env.SEED_ADMIN_PASSWORD = 'ReplacementPassword';
  process.env.SEED_ADMIN_RESET = '1';
  assert.equal(await ensureFirstAdmin(), true);

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get('owner@example.com');
  assert.equal(verifyPassword('ReplacementPassword', user.password_hash), true);
  assert.equal(verifyPassword('OriginalPassword', user.password_hash), false);
  assert.equal(Number(user.active), 1, 'a disabled account is re-enabled by the reset');
});

test('SEED_ADMIN_RESET is ignored unless explicitly enabled', async () => {
  process.env.SEED_ADMIN_EMAIL = 'owner@example.com';
  process.env.SEED_ADMIN_PASSWORD = 'OriginalPassword';
  await ensureFirstAdmin();

  process.env.SEED_ADMIN_PASSWORD = 'ReplacementPassword';
  process.env.SEED_ADMIN_RESET = 'no';
  assert.equal(await ensureFirstAdmin(), false);

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get('owner@example.com');
  assert.equal(verifyPassword('OriginalPassword', user.password_hash), true);
});
