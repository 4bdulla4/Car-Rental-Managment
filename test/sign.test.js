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
let rentalId;
let token;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function absorb(res) {
  const c = res.headers.getSetCookie();
  if (c.length) jar = c.map((x) => x.split(';')[0]).join('; ');
  return res;
}
async function get(path) {
  const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, body: await res.text() };
}
async function post(path, fields, formPath) {
  const page = await get(formPath || path);
  const match = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body);
  const res = absorb(await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: match ? match[1] : '', ...fields })
  }));
  return { status: res.status, body: await res.text() };
}

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run('admin@test.local', 'Admin', hashPassword('AdminPassword123'));
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('SGN-1','Toyota','Corolla',150)").run();
  await db.prepare("INSERT INTO customers (full_name, phone, email, license_number) VALUES ('Omar','123','omar@test.local','DL-1')").run();

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await post('/login', { email: 'admin@test.local', password: 'AdminPassword123', next: '/' }, '/login');
  await post('/rentals', {
    car_id: '1', customer_id: '1', start_date: '2026-03-01', end_date: '2026-03-05',
    daily_rate: '150', km_allowance_per_day: '250', excess_km_rate: '0.5',
    deposit: '500', discount: '0', pickup_odometer: '1000', pickup_fuel: '8'
  }, '/rentals/new');

  const rental = await db.prepare("SELECT id FROM rentals WHERE status = 'active'").get();
  rentalId = rental.id;
  await post(`/rentals/${rentalId}/send`, {}, `/rentals/${rentalId}`);
  token = (await db.prepare('SELECT sign_token FROM rentals WHERE id = ?').get(rentalId)).sign_token;
  jar = ''; // from here on, act as the customer with no session
});

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test('a signing token is issued and is hard to guess', () => {
  assert.match(token, /^[a-f0-9]{48}$/, 'expected a long random token');
});

test('an unknown token is refused', async () => {
  const bad = await get('/sign/' + 'a'.repeat(48));
  assert.equal(bad.status, 404);
  assert.match(bad.body, /not valid/i);

  const malformed = await get('/sign/not-a-token');
  assert.equal(malformed.status, 404);
});

test('the customer can open the agreement without signing in', async () => {
  const page = await get('/sign/' + token);
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign here/);
  const doc = await get(`/sign/${token}/document`);
  assert.equal(doc.status, 200);
  assert.match(doc.body, /Car Rental Agreement/i);
});

test('a signature is refused unless the terms are agreed to', async () => {
  const res = await post(`/sign/${token}`, { signed_name: 'Omar', signature_data: PNG }, `/sign/${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /confirm you agree/i);
});

test('anything that is not a PNG data URL is refused', async () => {
  const res = await post(`/sign/${token}`, {
    signed_name: 'Omar', agreed: '1', signature_data: 'javascript:alert(1)'
  }, `/sign/${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /draw your signature/i);

  const stored = await db.prepare('SELECT signature_data FROM rentals WHERE id = ?').get(rentalId);
  assert.equal(stored.signature_data, null, 'nothing should have been stored');
});

test('signing records the name, the image and when it happened', async () => {
  const res = await post(`/sign/${token}`, {
    signed_name: 'Omar Al-Harbi', agreed: '1', signature_data: PNG
  }, `/sign/${token}`);
  assert.equal(res.status, 302);

  const row = await db.prepare('SELECT * FROM rentals WHERE id = ?').get(rentalId);
  assert.equal(row.signed_name, 'Omar Al-Harbi');
  assert.equal(row.signature_data, PNG);
  assert.ok(row.handover_signed_at, 'the time of signing must be recorded');
});

test('a signed agreement cannot be signed again', async () => {
  // The signed page no longer renders the form, so the token comes from another
  // page in the same session — otherwise CSRF would answer before the guard does.
  const res = await post(`/sign/${token}`, {
    signed_name: 'Someone Else', agreed: '1', signature_data: PNG
  }, '/login');
  assert.equal(res.status, 400);
  // A resubmit is shown the signed confirmation rather than an error, which is
  // the right thing to tell someone whose signature is already recorded.
  assert.match(res.body, /Signed\.<\/strong>|Signed\./);

  const row = await db.prepare('SELECT signed_name FROM rentals WHERE id = ?').get(rentalId);
  assert.equal(row.signed_name, 'Omar Al-Harbi', 'the original signature must stand');
});

test('the signature is printed on the contract', async () => {
  await post('/login', { email: 'admin@test.local', password: 'AdminPassword123', next: '/' }, '/login');
  const contract = await get(`/rentals/${rentalId}/contract`);
  assert.match(contract.body, /class="signature"/);
  assert.match(contract.body, /Signed electronically by Omar Al-Harbi/);
});
