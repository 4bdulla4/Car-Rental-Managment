'use strict';
// Regression tests for the workflow defects found in the end-to-end QA pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const app = require('../src/app');
const { hashPassword } = require('../src/lib/passwords');

let db;
let server;
let base;
let jar = '';
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);

const absorb = (r) => { const c = r.headers.getSetCookie(); if (c.length) jar = c.map((x) => x.split(';')[0]).join('; '); return r; };
const get = async (p) => {
  const r = absorb(await fetch(base + p, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
};
async function token() {
  const pg = await get('/');
  return /name="_csrf" value="([a-f0-9]+)"/.exec(pg.body)[1];
}
async function post(p, fields = {}) {
  const r = absorb(await fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: await token(), ...fields })
  }));
  return { status: r.status, location: r.headers.get('location'), body: await r.text() };
}
const one = (sql, ...a) => db.prepare(sql).get(...a);

let carId = 0;
async function newCar(plate) {
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate, odometer, fuel_level) VALUES (?,'Toyota','Camry',200,10000,8)").run(plate);
  return (await one('SELECT id FROM cars WHERE plate = ?', plate)).id;
}
let custId = 0;
const rentalForm = (car, extra = {}) => ({
  car_id: String(car), customer_id: String(custId), start_date: day(0), end_date: day(3),
  daily_rate: '200', km_allowance_per_day: '200', excess_km_rate: '0.5', deposit: '500',
  discount: '0', pickup_odometer: '10000', pickup_fuel: '8', start_time: '09:00', end_time: '09:00', ...extra
});

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('qa@test.local','QA',?, 'admin')")
    .run(hashPassword('CorrectHorseBattery'));
  await db.prepare("INSERT INTO customers (full_name, phone, license_number, license_expiry) VALUES ('Ali','0500','DL-QA-1','2031-01-01')").run();
  custId = (await one("SELECT id FROM customers WHERE license_number = 'DL-QA-1'")).id;
  carId = await newCar('QA-1');
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await get('/login');
  const login = await get('/login');
  const t = /name="_csrf" value="([a-f0-9]+)"/.exec(login.body)[1];
  absorb(await fetch(base + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: t, email: 'qa@test.local', password: 'CorrectHorseBattery', next: '/' })
  }));
});
test.after(async () => { if (server) server.close(); if (db) await db.close(); });

test('deleting a car with contracts is refused with a message, not a crash', async () => {
  const car = await newCar('QA-DEL');
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate, status)
     VALUES ('RC-DEL-1', ?, ?, '2026-01-01', '2026-01-02', 200, 'closed')`
  ).run(car, custId);
  const res = await post(`/cars/${car}/delete`);
  assert.equal(res.status, 302, 'this was a 500: the guard read .n off an unawaited query');
  assert.ok(await one('SELECT 1 AS x FROM cars WHERE id = ?', car), 'and the car is still there');
});

test('settings states how many cars a change would apply to', async () => {
  const page = await get('/settings?tab=pricing');
  assert.doesNotMatch(page.body, /undefined existing car/);
  assert.match(page.body, /Also apply to all \d+ existing car/);
});

test('a contract cannot be issued with figures that make no sense', async () => {
  const cases = [
    [{ deposit: '-100' }, /Deposit cannot be negative/],
    [{ km_allowance_per_day: '-1' }, /allowance cannot be negative/],
    [{ excess_km_rate: '-0.5' }, /rate cannot be negative/],
    [{ start_time: 'banana' }, /Pickup time must be a time/],
    [{ pickup_odometer: '5000' }, /cannot be below QA-1(&#39;|')s last reading/]
  ];
  for (const [bad, message] of cases) {
    const res = await post('/rentals', rentalForm(carId, bad));
    assert.equal(res.status, 400, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.body, message);
  }
  assert.equal((await one("SELECT COUNT(*) AS n FROM rentals WHERE car_id = ?", carId)).n, 0, 'nothing was issued');
});

test('a car rented by someone else in the meantime is not booked again', async () => {
  // Over the network the availability check and the write are separate trips,
  // and another contract can land between them. Recreate exactly that: the
  // route's read sees the car free, while the database already has it out.
  const car = await newCar('QA-RACE');
  await db.prepare("UPDATE cars SET status = 'rented' WHERE id = ?").run(car);
  const prepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (sql === 'SELECT * FROM cars WHERE id = ?') {
      return { ...stmt, get: async (...a) => ({ ...(await stmt.get(...a)), status: 'available' }) };
    }
    return stmt;
  };
  try {
    const res = await post('/rentals', rentalForm(car));
    assert.equal(res.status, 409, 'the second booking is refused');
    assert.match(res.body, /has just been rented/);
  } finally {
    db.prepare = prepare;
  }
  const issued = await one('SELECT COUNT(*) AS n FROM rentals WHERE car_id = ?', car);
  assert.equal(Number(issued.n), 0, 'and no contract was written for it');
});
