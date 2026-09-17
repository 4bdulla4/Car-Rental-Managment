'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const app = require('../src/app');
const { hashPassword } = require('../src/lib/passwords');

let db;
let server;
let base;
let jar = '';
let adminId;
let staffId;

const PASSWORD = 'AdminPassword123';

function absorb(res) {
  const cookies = res.headers.getSetCookie();
  if (cookies.length) jar = cookies.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function get(path) {
  const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, body: await res.text() };
}

async function post(path, fields, formPath = '/users') {
  const page = await get(formPath);
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body)[1];
  const res = absorb(await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, ...fields })
  }));
  return { status: res.status, body: await res.text() };
}

const roleOf = async (id) => (await db.prepare('SELECT role FROM users WHERE id = ?').get(id)).role;

test.before(async () => {
  db = await helper.reset();
  const admin = await db
    .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin') RETURNING id")
    .run('admin@test.local', 'The Admin', hashPassword(PASSWORD));
  adminId = admin.lastInsertRowid;
  const staff = await db
    .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'staff') RETURNING id")
    .run('staff@test.local', 'The Staff', hashPassword(PASSWORD));
  staffId = staff.lastInsertRowid;

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await post('/login', { email: 'admin@test.local', password: PASSWORD, next: '/' }, '/login');
});

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test('an admin can change another account\'s role', async () => {
  await post(`/users/${staffId}/role`, { role: 'admin' });
  assert.equal(await roleOf(staffId), 'admin');
  await post(`/users/${staffId}/role`, { role: 'staff' });
  assert.equal(await roleOf(staffId), 'staff');
});

test('an admin cannot change their own role', async () => {
  await post(`/users/${adminId}/role`, { role: 'staff' });
  assert.equal(await roleOf(adminId), 'admin', 'the role must be unchanged');
  const page = await get('/users');
  assert.match(page.body, /cannot change your own role/);
});

test('an admin cannot demote, disable or delete themselves', async () => {
  // The actor is always an admin, so these self-guards are what actually keeps
  // at least one admin in place; the last-admin checks behind them are belt and braces.
  await post(`/users/${adminId}/role`, { role: 'staff' });
  assert.equal(await roleOf(adminId), 'admin');

  await post(`/users/${adminId}/toggle`, {});
  const self = await db.prepare('SELECT active FROM users WHERE id = ?').get(adminId);
  assert.equal(Number(self.active), 1, 'the account must stay enabled');

  await post(`/users/${adminId}/delete`, {});
  const still = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(adminId);
  assert.equal(Number(still.n), 1, 'the account must still exist');

  const admins = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get();
  assert.ok(Number(admins.n) >= 1, 'an active admin always remains');
});

test('an account that issued contracts cannot be deleted', async () => {
  // A separate author, because deleting the signed-in account is blocked earlier.
  const author = await db
    .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'staff') RETURNING id")
    .run('author@test.local', 'The Author', hashPassword(PASSWORD));
  const authorId = author.lastInsertRowid;

  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('ZZZ-1','Toyota','Corolla',150)").run();
  await db.prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('C','1','DL-9')").run();
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate, created_by, status)
     VALUES ('RC-USR-1', 1, 1, '2026-03-01', '2026-03-02', 150, ?, 'active')`
  ).run(authorId);

  await post(`/users/${authorId}/delete`, {});
  const still = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(authorId);
  assert.equal(Number(still.n), 1, 'the account must survive');

  const page = await get('/users');
  assert.match(page.body, /issued 1 contract/);
});

test('an account with no history can be deleted', async () => {
  const spare = await db
    .prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'staff') RETURNING id")
    .run('spare@test.local', 'The Spare', hashPassword(PASSWORD));

  await post(`/users/${spare.lastInsertRowid}/delete`, {});
  const gone = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(spare.lastInsertRowid);
  assert.equal(Number(gone.n), 0);
});

test('search narrows the list', async () => {
  const all = await get('/users');
  assert.match(all.body, /staff@test\.local/);
  assert.match(all.body, /admin@test\.local/);

  // Scoped to the table: the sidebar always shows the signed-in user's own name.
  const filtered = await get('/users?q=staff@test');
  const table = filtered.body.slice(filtered.body.indexOf('<tbody>'), filtered.body.indexOf('</tbody>'));
  assert.match(table, /staff@test\.local/);
  assert.doesNotMatch(table, /admin@test\.local/);
});
