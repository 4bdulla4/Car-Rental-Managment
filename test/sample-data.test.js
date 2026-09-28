'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

process.env.CURRENCY = 'SAR';

const sample = require('../src/lib/sample-data');
const settings = require('../src/lib/settings');

let db;

test.after(async () => { if (db) await db.close(); });

test.before(async () => {
  db = await helper.reset();
  await settings.load();
});

test('the sample is a year of closed contracts in the current currency', async () => {
  const result = await sample.load();
  assert.equal(result.created, true);
  assert.equal(result.cars, sample.CARS.length);
  assert.equal(result.customers, sample.CUSTOMERS.length);
  assert.ok(result.rentals >= 20, `expected a year of trading, got ${result.rentals}`);

  const rows = await db.prepare('SELECT * FROM rentals WHERE is_sample = 1').all();
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    assert.equal(r.status, 'closed', 'the sample is history, not open contracts');
    assert.equal(r.currency, 'SAR', 'each contract records the currency in force');
    assert.ok(r.closed_at <= today, `a contract closes in the future: ${r.closed_at}`);
    assert.ok(Number(r.total_amount) > 0, 'every contract is worth something');
    const parts = ['base_charge', 'late_fee', 'excess_km_fee', 'fuel_fee', 'damage_charge', 'other_charges']
      .reduce((sum, k) => sum + Number(r[k] || 0), 0) - Number(r.discount || 0);
    assert.ok(Math.abs(parts - Number(r.total_amount)) < 0.01, 'the total is the sum of its parts');
  }

  const months = new Set(rows.map((r) => String(r.closed_at).slice(0, 7)));
  assert.ok(months.size >= 8, `expected contracts spread over months, got ${months.size}`);
});

test('the sample cars are back on the lot, since nothing is still out', async () => {
  const out = await db.prepare("SELECT COUNT(*) AS n FROM cars WHERE is_sample = 1 AND status <> 'available'").get();
  assert.equal(Number(out.n), 0);
});

test('loading twice does not double the history', async () => {
  const before = await sample.summary();
  const again = await sample.load();
  assert.equal(again.created, false);
  assert.deepEqual(await sample.summary(), before);
});

test('contract numbers stay unique alongside real ones', async () => {
  const rows = await db.prepare('SELECT contract_no FROM rentals').all();
  assert.equal(new Set(rows.map((r) => r.contract_no)).size, rows.length);
});

test('removing the sample leaves real records untouched', async () => {
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('REAL-1','Toyota','Hilux',200)").run();
  await db.prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Real Person','999','DL-REAL')").run();
  const car = await db.prepare("SELECT id FROM cars WHERE plate = 'REAL-1'").get();
  const customer = await db.prepare("SELECT id FROM customers WHERE license_number = 'DL-REAL'").get();
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate,
                          total_amount, currency, status)
     VALUES ('RC-REAL-1',?,?,'2026-05-01','2026-05-04',200,600,'SAR','closed')`
  ).run(car.id, customer.id);

  const removed = await sample.remove();
  assert.ok(removed.rentals > 0);
  assert.deepEqual(await sample.summary(), { cars: 0, customers: 0, rentals: 0 });

  assert.ok(await db.prepare("SELECT 1 FROM cars WHERE plate = 'REAL-1'").get(), 'the real car survives');
  assert.ok(await db.prepare("SELECT 1 FROM customers WHERE license_number = 'DL-REAL'").get(), 'the real customer survives');
  assert.ok(await db.prepare("SELECT 1 FROM rentals WHERE contract_no = 'RC-REAL-1'").get(), 'the real contract survives');
});

test('a sample car kept on a real contract is not deleted with the rest', async () => {
  await sample.load();
  const car = await db.prepare('SELECT id FROM cars WHERE is_sample = 1 ORDER BY id').get();
  const customer = await db.prepare('SELECT id FROM customers WHERE is_sample = 1 ORDER BY id').get();
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate,
                          total_amount, currency, status)
     VALUES ('RC-REAL-2',?,?,'2026-06-01','2026-06-03',260,520,'SAR','active')`
  ).run(car.id, customer.id);

  await sample.remove();
  assert.ok(await db.prepare('SELECT 1 FROM cars WHERE id = ?').get(car.id), 'a car still on a contract stays');
  assert.ok(await db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customer.id), 'so does the customer');
});

test('the count shown before removing is the count of what goes', async () => {
  // Only the flagged sample: no contract of the user's own on any of it.
  await db.prepare('DELETE FROM contract_documents').run();
  await db.prepare('DELETE FROM rentals').run();
  await db.prepare('DELETE FROM customers').run();
  await db.prepare('DELETE FROM cars').run();
  await sample.load();
  const flagged = await sample.summary();
  const shown = await sample.demoSummary();
  // With only the flagged sample present, nothing is on a contract of the
  // user's own, so nothing is kept and every sample record is counted.
  assert.equal(shown.keptCars, 0, 'a sample car is not "kept" just for being a sample');
  assert.equal(shown.keptCustomers, 0);
  assert.equal(shown.cars, flagged.cars);
  assert.equal(shown.customers, flagged.customers);
  assert.equal(shown.rentals, flagged.rentals);
});

test('the earlier demo set is recognised by name, and removed with its contracts', async () => {
  await sample.remove();
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('RUH-4412','Toyota','Corolla',150)").run();
  await db.prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Omar Al-Harbi','0555','DL-778812')").run();
  const car = await db.prepare("SELECT id FROM cars WHERE plate = 'RUH-4412'").get();
  const cust = await db.prepare("SELECT id FROM customers WHERE license_number = 'DL-778812'").get();
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate, total_amount, currency, status)
     VALUES ('RC-DEMO-1',?,?,'2026-09-01','2026-09-03',150,300,'SAR','active')`
  ).run(car.id, cust.id);

  const before = await sample.demoSummary();
  assert.equal(before.cars, 1);
  assert.equal(before.customers, 1);
  assert.equal(before.rentals, 1, 'a contract on the earlier demo is demo too');

  const removed = await sample.remove();
  assert.deepEqual(
    { cars: removed.cars, customers: removed.customers, rentals: removed.rentals },
    { cars: before.cars, customers: before.customers, rentals: before.rentals },
    'the number shown before is the number that goes'
  );
  assert.equal(await db.prepare("SELECT 1 FROM cars WHERE plate = 'RUH-4412'").get(), undefined);
  assert.equal(await db.prepare("SELECT 1 FROM rentals WHERE contract_no = 'RC-DEMO-1'").get(), undefined);
});

test('removing demo data never touches a record outside it', async () => {
  // Real records, including one whose details merely look like the demo.
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('RUH-9999','Lexus','ES',400)").run();
  await db.prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Omar Al-Harbi','0555','DL-REAL-9')").run();
  const car = await db.prepare("SELECT id FROM cars WHERE plate = 'RUH-9999'").get();
  const cust = await db.prepare("SELECT id FROM customers WHERE license_number = 'DL-REAL-9'").get();
  await db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate, total_amount, currency, status)
     VALUES ('RC-REAL-9',?,?,'2026-09-01','2026-09-03',400,800,'SAR','active')`
  ).run(car.id, cust.id);
  await db.prepare('INSERT INTO contract_documents (rental_id, kind, mime, image, bytes, digest) VALUES (?,?,?,?,?,?)')
    .run((await db.prepare("SELECT id FROM rentals WHERE contract_no = 'RC-REAL-9'").get()).id,
      'licence_front', 'image/jpeg', 'AAAA', 3, 'd');

  await sample.load();
  await sample.remove();

  assert.ok(await db.prepare("SELECT 1 FROM cars WHERE plate = 'RUH-9999'").get(), 'a real car stays');
  assert.ok(await db.prepare("SELECT 1 FROM customers WHERE license_number = 'DL-REAL-9'").get(),
    'a real customer stays, even one sharing a demo name');
  assert.ok(await db.prepare("SELECT 1 FROM rentals WHERE contract_no = 'RC-REAL-9'").get(), 'a real contract stays');
  assert.equal(Number((await db.prepare('SELECT COUNT(*) AS n FROM contract_documents').get()).n), 1,
    'and so does its licence photo');
});

test('a clean slate takes the business data and leaves accounts and settings', async () => {
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('keep@test.local','Keep','x','admin')").run();
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_name','Kept Co')").run();

  const gone = await sample.clearEverything();
  assert.ok(gone.cars > 0 && gone.rentals > 0);

  const left = await sample.everythingSummary();
  assert.deepEqual(left, { cars: 0, customers: 0, rentals: 0, documents: 0 });
  assert.ok(await db.prepare("SELECT 1 FROM users WHERE email = 'keep@test.local'").get(), 'accounts stay');
  assert.ok(await db.prepare("SELECT 1 FROM settings WHERE key = 'company_name'").get(), 'settings stay');
});
