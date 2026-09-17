'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const app = require('../src/app');
const { hashPassword, verifyPassword } = require('../src/lib/passwords');

let db;
let server;
let base;
let jar = '';

const ORIGINAL = 'OriginalPassword1';

function absorb(res) {
  const cookies = res.headers.getSetCookie();
  if (cookies.length) jar = cookies.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function get(path) {
  const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, body: await res.text() };
}

async function post(path, fields, formPath) {
  const page = await get(formPath || path);
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body)[1];
  const res = absorb(await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, ...fields })
  }));
  return { status: res.status, body: await res.text() };
}

const currentHash = () =>
  db.prepare('SELECT password_hash FROM users WHERE email = ?').get('staff@test.local');

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'staff')")
    .run('staff@test.local', 'Staff', hashPassword(ORIGINAL));

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await post('/login', { email: 'staff@test.local', password: ORIGINAL, next: '/' }, '/login');
});

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test('a staff user can reach their own account page', async () => {
  const page = await get('/account');
  assert.equal(page.status, 200);
  assert.match(page.body, /Change my password/);
});

test('the current password must be correct', async () => {
  const res = await post('/account/password', {
    current_password: 'NotTheRightOne',
    new_password: 'BrandNewPassword',
    confirm_password: 'BrandNewPassword'
  }, '/account');
  assert.equal(res.status, 400);
  assert.match(res.body, /current password is not correct/);
  assert.equal(verifyPassword(ORIGINAL, (await currentHash()).password_hash), true);
});

test('the confirmation must match', async () => {
  const res = await post('/account/password', {
    current_password: ORIGINAL,
    new_password: 'BrandNewPassword',
    confirm_password: 'SomethingElse12'
  }, '/account');
  assert.equal(res.status, 400);
  assert.match(res.body, /do not match/);
});

test('a short password is refused', async () => {
  const res = await post('/account/password', {
    current_password: ORIGINAL,
    new_password: 'short',
    confirm_password: 'short'
  }, '/account');
  assert.equal(res.status, 400);
  assert.match(res.body, /at least 10 characters/);
});

test('a correct request changes the password', async () => {
  const res = await post('/account/password', {
    current_password: ORIGINAL,
    new_password: 'BrandNewPassword',
    confirm_password: 'BrandNewPassword'
  }, '/account');
  assert.equal(res.status, 302);

  const hash = (await currentHash()).password_hash;
  assert.equal(verifyPassword('BrandNewPassword', hash), true);
  assert.equal(verifyPassword(ORIGINAL, hash), false, 'the old password must stop working');
});

test('the account page needs a signed-in user', async () => {
  jar = '';
  const page = await get('/account');
  assert.equal(page.status, 302, 'a signed-out visitor is sent to the login page');
});
