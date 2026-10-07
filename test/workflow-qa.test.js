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

async function issued(plate) {
  const car = await newCar(plate);
  await post('/rentals', rentalForm(car));
  return one("SELECT * FROM rentals WHERE car_id = ? AND status = 'active'", car);
}
const returnForm = (extra = {}) => ({
  return_date: day(0), return_odometer: '10300', return_fuel: '8', damage_charge: '0', other_charges: '0', ...extra
});

test('a return cannot be dated in the future', async () => {
  const r = await issued('QA-FUT');
  const res = await post(`/rentals/${r.id}/return`, returnForm({ return_date: day(10) }));
  assert.equal(res.status, 400);
  assert.match(res.body, /cannot be in the future/);
  assert.equal((await one('SELECT status FROM rentals WHERE id = ?', r.id)).status, 'active');
});

test('a resent return does not overwrite the settlement already recorded', async () => {
  const r = await issued('QA-TWICE');
  assert.equal((await post(`/rentals/${r.id}/return`, returnForm({ return_odometer: '10300' }))).status, 302);

  // The form is sent again — a double-click, or a resend after a slow page —
  // and the route's read still sees the contract open.
  const prepare = db.prepare;
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (sql.includes('WHERE r.id = ?')) {
      return { ...stmt, get: async (...a) => ({ ...(await stmt.get(...a)), status: 'active' }) };
    }
    return stmt;
  };
  let res;
  try {
    res = await post(`/rentals/${r.id}/return`, returnForm({ return_odometer: '19999', damage_charge: '900' }));
  } finally {
    db.prepare = prepare;
  }
  assert.equal(res.status, 302);
  const after = await one('SELECT return_odometer, damage_charge FROM rentals WHERE id = ?', r.id);
  assert.equal(Number(after.return_odometer), 10300, 'the first settlement stands');
  assert.equal(Number(after.damage_charge), 0);
  assert.equal(Number((await one('SELECT odometer FROM cars WHERE id = ?', r.car_id)).odometer), 10300, 'and the car was not moved again');
});

const carForm = (plate, extra = {}) => ({
  plate, make: 'Toyota', model: 'Camry', year: '2024', seats: '5', daily_rate: '200',
  km_allowance_per_day: '200', excess_km_rate: '0.5', odometer: '10000', fuel_level: '8', status: 'available', ...extra
});

test('a car cannot be added with a negative odometer or an impossible year', async () => {
  for (const [bad, message] of [[{ odometer: '-10' }, /Odometer reading cannot be negative/], [{ year: '1066' }, /Year must be between/]]) {
    const res = await post('/cars', carForm('QA-BAD', bad));
    assert.equal(res.status, 400, `accepted ${JSON.stringify(bad)}`);
    assert.match(res.body, message);
  }
});

test('a car cannot be marked rented by hand', async () => {
  const res = await post('/cars', carForm('QA-HAND', { status: 'rented' }));
  assert.equal(res.status, 400);
  assert.equal(await one("SELECT 1 AS x FROM cars WHERE plate = 'QA-HAND'"), undefined);
});

test('a car left marked rented with no contract can be freed', async () => {
  // How the trap was sprung before: rented by hand, so it could not be
  // rented, and refused any change because it looked out on a contract.
  const car = await newCar('QA-STUCK');
  await db.prepare("UPDATE cars SET status = 'rented' WHERE id = ?").run(car);
  const res = await post(`/cars/${car}`, carForm('QA-STUCK', { status: 'available' }));
  assert.equal(res.status, 302, 'this was refused forever');
  assert.equal((await one('SELECT status FROM cars WHERE id = ?', car)).status, 'available');
});

test('a car out on a contract still cannot be changed until it is checked in', async () => {
  const r = await issued('QA-OUT');
  const res = await post(`/cars/${r.car_id}`, carForm('QA-OUT', { status: 'available' }));
  assert.equal(res.status, 400);
  assert.match(res.body, new RegExp(`out on ${r.contract_no}`));
});

const customerForm = (extra = {}) => ({
  full_name: 'New Person', phone: '0501111111', email: 'new@example.test', license_number: 'DL-NEW-1', license_expiry: '2031-01-01', ...extra
});

test('a licence already on file is not added again for someone else', async () => {
  const res = await post('/customers', customerForm({ license_number: 'dl-qa-1' }));
  assert.equal(res.status, 400);
  assert.match(res.body, /already on file for Ali/);
});

test('a customer can be saved with their own licence unchanged', async () => {
  const res = await post(`/customers/${custId}`, customerForm({ full_name: 'Ali', license_number: 'DL-QA-1' }));
  assert.equal(res.status, 302);
});

test('a malformed email address is refused', async () => {
  const res = await post('/customers', customerForm({ email: 'not-an-email', license_number: 'DL-NEW-2' }));
  assert.equal(res.status, 400);
  assert.match(res.body, /email address is not valid/);
});

test('an address with a non-numeric id is "not found", not a crash', async () => {
  for (const p of ['/rentals/abc', '/rentals/abc/contract', '/rentals/abc/receipt', '/cars/abc/edit', '/customers/abc/edit', '/rentals/1e999']) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} answered ${res.status}`);
  }
});

test('the contract says what is paid at handover and what is settled on return', async () => {
  const big = await newCar('QA-DEP');
  await post('/rentals', rentalForm(big, { deposit: '800' })); // total 600
  const r = await one("SELECT id FROM rentals WHERE car_id = ? AND status = 'active'", big);
  const doc = (await get(`/rentals/${r.id}/contract`)).body.replace(/\s+/g, ' ');
  assert.match(doc, /Payable at handover: the deposit of <strong>800\.00 SAR<\/strong>/);
  assert.match(doc, /<strong>200\.00 SAR<\/strong> of the deposit will then be refunded/);
  assert.doesNotMatch(doc, /-200\.00/, 'never a negative amount payable');

  const small = await newCar('QA-DEP2');
  await post('/rentals', rentalForm(small, { deposit: '500' }));
  const r2 = await one("SELECT id FROM rentals WHERE car_id = ? AND status = 'active'", small);
  const doc2 = (await get(`/rentals/${r2.id}/contract`)).body.replace(/\s+/g, ' ');
  assert.match(doc2, /deposit of <strong>500\.00 SAR<\/strong>/);
  assert.match(doc2, /a further <strong>100\.00 SAR<\/strong> will then be due/);
});

test('a cancelled contract cannot be signed through a link already sent', async () => {
  const r = await issued('QA-CXL');
  await post(`/rentals/${r.id}/send`);
  const { sign_token: token } = await one('SELECT sign_token FROM rentals WHERE id = ?', r.id);
  assert.ok(token, 'a link was issued');
  await post(`/rentals/${r.id}/cancel`);

  const signedIn = jar;
  jar = '';
  try {
    const page = await get(`/sign/${token}`);
    assert.equal(page.status, 410);
    assert.match(page.body, /was cancelled/);
    const t = /name="_csrf" value="([a-f0-9]+)"/.exec((await get('/login')).body)[1];
    const attempt = absorb(await fetch(`${base}/sign/${token}`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: t, signed_name: 'Ali', signature_data: 'data:image/png;base64,AAAA' })
    }));
    assert.equal(attempt.status, 410, 'and nothing can be posted to it either');
  } finally {
    jar = signedIn;
  }
  assert.equal((await one('SELECT signature_data FROM rentals WHERE id = ?', r.id)).signature_data, null);
});

test('a cancelled contract cannot be sent for signing', async () => {
  const r = await issued('QA-CXL2');
  const before = await one('SELECT sign_token FROM rentals WHERE id = ?', r.id);
  await post(`/rentals/${r.id}/cancel`);
  const res = await post(`/rentals/${r.id}/send`);
  assert.equal(res.status, 302);
  const after = await one('SELECT sign_token, sent_at FROM rentals WHERE id = ?', r.id);
  assert.equal(after.sent_at, null, 'nothing was sent');
  assert.equal(after.sign_token, before.sign_token, 'and the link was not reissued');
});

test('the customer list says what each customer has out, and when it is due', async () => {
  await db.prepare("INSERT INTO customers (full_name, phone, license_number, license_expiry) VALUES ('Out Late','0502','DL-OUT-1','2031-01-01')").run();
  await db.prepare("INSERT INTO customers (full_name, phone, license_number, license_expiry) VALUES ('Home Now','0503','DL-HOME-1','2031-01-01')").run();
  const out = (await one("SELECT id FROM customers WHERE license_number = 'DL-OUT-1'")).id;
  const car = await newCar('QA-CUST');
  await db.prepare("UPDATE cars SET status = 'rented' WHERE id = ?").run(car);
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate, status)
     VALUES ('RC-OUT-1', ?, ?, ?, ?, 200, 'active')`
  ).run(car, out, day(-5), day(-2));

  const page = (await get('/customers?q=DL-')).body.replace(/\s+/g, ' ');
  assert.match(page, /<th>Rental<\/th>/, 'a column of its own');
  const lateRow = page.slice(page.indexOf('Out Late'), page.indexOf('Out Late') + 1500);
  assert.match(lateRow, /Overdue 2 days/);
  assert.match(lateRow, /RC-OUT-1/);
  assert.match(lateRow, /QA-CUST · Toyota Camry/);
  assert.match(lateRow, new RegExp(`due ${day(-2)}`));
  const homeRow = page.slice(page.indexOf('Home Now'), page.indexOf('Home Now') + 800);
  assert.match(homeRow, /Not renting/);

  const filtered = (await get('/customers?filter=renting')).body;
  assert.match(filtered, /Out Late/);
  assert.doesNotMatch(filtered, /Home Now/, 'the "renting" filter still works');
});
