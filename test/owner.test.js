'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

process.env.OWNER_EMAIL = 'owner@test.local';

const app = require('../src/app');
const activity = require('../src/lib/activity');
const { hashPassword } = require('../src/lib/passwords');

let db;
let server;
let base;
const ids = {};

/** One cookie jar per person, so two people can be signed in at once. */
function agent() {
  let jar = '';
  const absorb = (res) => {
    const c = res.headers.getSetCookie();
    if (c.length) jar = c.map((x) => x.split(';')[0]).join('; ');
    return res;
  };
  const get = async (path) => {
    const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };
  const post = async (path, fields = {}, formPath = '/') => {
    const page = await get(formPath);
    const m = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body);
    const res = absorb(await fetch(base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: m ? m[1] : '', ...fields })
    }));
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };
  const signIn = (email, password) => post('/login', { email, password, next: '/' }, '/login');
  return { get, post, signIn };
}

const lastLog = () => db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1').get();

test.before(async () => {
  db = await helper.reset();
  await db.prepare('DELETE FROM activity_log').run();
  const add = (email, name, role) =>
    db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
      .run(email, name, hashPassword('CorrectHorseBattery'), role);
  await add('owner@test.local', 'Abdullah', 'admin');
  await add('admin@test.local', 'Other Admin', 'admin');
  await add('sara@test.local', 'Sara', 'staff');
  for (const email of ['owner@test.local', 'admin@test.local', 'sara@test.local']) {
    ids[email] = (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)).id;
  }

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test('only the owner is offered other accounts and the activity log', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  const users = await owner.get('/users');
  assert.match(users.body, /Sign in as/);
  assert.match(users.body, /\/owner\/activity/);

  const admin = agent();
  await admin.signIn('admin@test.local', 'CorrectHorseBattery');
  const theirs = await admin.get('/users');
  assert.doesNotMatch(theirs.body, /Sign in as/, 'an ordinary admin cannot borrow accounts');
  assert.doesNotMatch(theirs.body, /\/owner\/activity/);
});

test('an ordinary admin is refused, not merely not shown the button', async () => {
  const admin = agent();
  await admin.signIn('admin@test.local', 'CorrectHorseBattery');
  assert.equal((await admin.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users')).status, 403);
  assert.equal((await admin.get('/owner/activity')).status, 403);
});

test('signing in as someone shows the app exactly as they see it', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  const res = await owner.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users');
  assert.equal(res.status, 302);

  const home = await owner.get('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /You are signed in as Sara/, 'the banner is impossible to miss');
  assert.equal((await owner.get('/users')).status, 403, 'Sara is staff, so this is what Sara gets');

  const log = await lastLog();
  assert.equal(log.action, 'Owner signed in as this account');
  assert.equal(log.user_id, ids['sara@test.local']);
  assert.equal(log.actor_id, ids['owner@test.local']);
});

test('what the owner does in a borrowed account is recorded as the owner', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  await owner.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users');

  await owner.post('/customers', {
    full_name: 'Walk In', phone: '0500', license_number: 'DL-OWN-1'
  }, '/customers/new');

  const log = await lastLog();
  assert.equal(log.action, 'Added a customer');
  assert.equal(log.user_id, ids['sara@test.local'], 'it happened in Sara\'s account');
  assert.equal(log.actor_id, ids['owner@test.local'], 'but Sara did not do it');
});

test('a borrowed account keeps its own password', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  await owner.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users');

  const res = await owner.post('/account/password', {
    current_password: 'CorrectHorseBattery', new_password: 'SomethingElse123', confirm_password: 'SomethingElse123'
  }, '/account');
  assert.equal(res.status, 403);
  assert.match(res.body, /return to your own account/i);
});

test('accounts cannot be borrowed from inside a borrowed account', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  await owner.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users');
  // Sara is staff, so the owner route is refused before it can nest.
  const res = await owner.post(`/owner/as/${ids['admin@test.local']}`, {}, '/');
  assert.notEqual(res.status, 200);
  const home = await owner.get('/');
  assert.match(home.body, /You are signed in as Sara/, 'still exactly one level deep');
});

test('returning puts the owner back in their own account', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  await owner.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users');
  await owner.post('/owner/return', {}, '/');

  const users = await owner.get('/users');
  assert.equal(users.status, 200);
  assert.doesNotMatch(users.body, /You are signed in as/);
  assert.equal((await lastLog()).action, 'Owner returned to their own account');
});

test("no one else can touch the owner's account", async () => {
  const admin = agent();
  await admin.signIn('admin@test.local', 'CorrectHorseBattery');
  const target = ids['owner@test.local'];

  await admin.post(`/users/${target}/password`, { password: 'TakenOver12345' }, '/users');
  await admin.post(`/users/${target}/toggle`, {}, '/users');
  await admin.post(`/users/${target}/role`, { role: 'staff' }, '/users');
  await admin.post(`/users/${target}/delete`, {}, '/users');

  const row = await db.prepare('SELECT role, active FROM users WHERE id = ?').get(target);
  assert.equal(row.role, 'admin');
  assert.equal(Number(row.active), 1);

  // The password is unchanged: the owner can still sign in with it.
  const owner = agent();
  const res = await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  assert.equal(res.status, 302, 'the owner was not locked out');
});

test("an admin cannot create the owner's account and choose its password", async () => {
  process.env.OWNER_EMAIL = 'unclaimed-owner@test.local';
  try {
    const admin = agent();
    await admin.signIn('admin@test.local', 'CorrectHorseBattery');
    const res = await admin.post('/users', {
      name: 'Me Now', email: 'unclaimed-owner@test.local', password: 'ChosenByAdmin123', role: 'admin'
    }, '/users');
    assert.equal(res.status, 400);
    assert.equal(await db.prepare("SELECT 1 FROM users WHERE email = 'unclaimed-owner@test.local'").get(), undefined);
  } finally {
    process.env.OWNER_EMAIL = 'owner@test.local';
  }
});

test('a borrowed session ends the moment the account stops being the owner', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  await owner.post(`/owner/as/${ids['sara@test.local']}`, {}, '/users');

  process.env.OWNER_EMAIL = 'someone-else@test.local';
  try {
    const res = await owner.get('/');
    assert.equal(res.status, 302, 'the session is dropped rather than left borrowing');
    assert.match(res.location, /\/login/);
  } finally {
    process.env.OWNER_EMAIL = 'owner@test.local';
  }
});

test('a failed sign-in on a real account is recorded, without the password', async () => {
  const stranger = agent();
  await stranger.signIn('sara@test.local', 'not-her-password-at-all');
  const log = await lastLog();
  assert.equal(log.action, 'Failed sign-in');
  assert.equal(log.outcome, 'refused');
  assert.equal(log.user_id, ids['sara@test.local']);
  assert.equal(log.actor_id, null, 'whoever it was, it is not known to be Sara');
  const everything = JSON.stringify(await db.prepare('SELECT * FROM activity_log').all());
  assert.ok(!everything.includes('not-her-password-at-all'), 'the attempted password is never stored');
});

test('signing links are not copied into the log', () => {
  const text = activity.redact('Signing link ready: https://x.test/sign/' + 'ab'.repeat(24) + ' — send it.');
  assert.ok(!/[a-f0-9]{48}/.test(text));
  assert.match(text, /\/sign\/…/);
});

test('the activity page shows who did what, and filters by person', async () => {
  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  const all = await owner.get('/owner/activity');
  assert.equal(all.status, 200);
  assert.match(all.body, /Added a customer/);
  assert.match(all.body, /as Sara/, 'borrowed actions are labelled as such');

  const sara = await owner.get(`/owner/activity?user=${ids['sara@test.local']}`);
  assert.match(sara.body, /Failed sign-in/);
});

test('only the owner can clear the business, and only by typing DELETE', async () => {
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('KEEP-1','Toyota','Yaris',120)").run();
  const cars = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM cars').get()).n);
  const start = await cars();

  const admin = agent();
  await admin.signIn('admin@test.local', 'CorrectHorseBattery');
  assert.equal((await admin.post('/settings/data/clear', { confirm: 'DELETE' }, '/settings')).status, 403);
  assert.equal(await cars(), start, 'an ordinary admin deletes nothing');

  const owner = agent();
  await owner.signIn('owner@test.local', 'CorrectHorseBattery');
  await owner.post('/settings/data/clear', { confirm: 'delete' }, '/settings');
  assert.equal(await cars(), start, 'a near miss deletes nothing');

  await owner.post('/settings/data/clear', { confirm: 'DELETE' }, '/settings');
  assert.equal(await cars(), 0);
  assert.equal((await lastLog()).action, 'Cleared business data', 'and it is on the record');
});
