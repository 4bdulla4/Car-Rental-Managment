'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.CURRENCY = 'SAR';
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carrenter-set-')), 'test.db');

const db = require('../src/db');
const settings = require('../src/lib/settings');

function issueRental(contractNo) {
  const car = db
    .prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES (?, 'Toyota', 'Corolla', 150)")
    .run('P-' + contractNo);
  const customer = db
    .prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Test', '123', 'DL-1')")
    .run();
  db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate,
                          total_amount, currency, status)
     VALUES (?,?,?,'2026-03-01','2026-03-05',150,600,?,'active')`
  ).run(contractNo, car.lastInsertRowid, customer.lastInsertRowid, settings.currency());
  return db.prepare('SELECT * FROM rentals WHERE contract_no = ?').get(contractNo);
}

test('currency falls back to the environment until it is set', () => {
  assert.equal(settings.currency(), 'SAR');
  assert.equal(settings.get('nothing-here', 'fallback'), 'fallback');
});

test('a written setting is read back immediately', () => {
  settings.set('currency', 'AED');
  assert.equal(settings.currency(), 'AED');
  settings.set('currency', 'USD');
  assert.equal(settings.currency(), 'USD');
});

test('currency codes are validated', () => {
  for (const good of ['SAR', 'usd', 'KWD', 'EU', 'BTC']) {
    assert.equal(settings.isValidCurrency(good), true, `${good} should be valid`);
  }
  for (const bad of ['', 'S', 'TOOLONG', 'SA1', 'S R', '$', null, undefined]) {
    assert.equal(settings.isValidCurrency(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('changing the currency never rewrites contracts already issued', () => {
  settings.set('currency', 'SAR');
  const first = issueRental('RC-TEST-0001');
  assert.equal(first.currency, 'SAR');

  settings.set('currency', 'AED');
  const second = issueRental('RC-TEST-0002');

  const reread = db.prepare('SELECT * FROM rentals WHERE contract_no = ?').get('RC-TEST-0001');
  assert.equal(reread.currency, 'SAR', 'the existing contract must keep its original currency');
  assert.equal(second.currency, 'AED', 'the new contract uses the new currency');
  assert.equal(reread.total_amount, 600, 'amounts are untouched');
});

test('closed revenue is grouped by currency, never summed across them', () => {
  db.prepare("UPDATE rentals SET status = 'closed' WHERE contract_no IN ('RC-TEST-0001','RC-TEST-0002')").run();
  const rows = db
    .prepare("SELECT currency, SUM(total_amount) AS total FROM rentals WHERE status = 'closed' GROUP BY currency ORDER BY currency")
    .all()
    // node:sqlite returns null-prototype rows; compare as plain objects.
    .map((r) => ({ currency: r.currency, total: r.total }));
  assert.deepEqual(rows, [
    { currency: 'AED', total: 600 },
    { currency: 'SAR', total: 600 }
  ]);
});

test('company details fall back to the environment until set', () => {
  const before = settings.company();
  assert.equal(before.name, process.env.COMPANY_NAME || 'Car Renter');
});

test('company details are stored and read back', () => {
  settings.set('company_name', 'Al Nakheel Rentals');
  settings.set('company_address', 'King Abdulaziz Rd, Jeddah');
  const after = settings.company();
  assert.equal(after.name, 'Al Nakheel Rentals');
  assert.equal(after.address, 'King Abdulaziz Rd, Jeddah');
});

test('a field cleared on purpose stays empty instead of reverting to the env value', () => {
  process.env.COMPANY_PHONE = '+966 11 000 0000';
  settings.set('company_phone', '');
  assert.equal(settings.company().phone, '', 'an explicit blank must not fall back');
});
