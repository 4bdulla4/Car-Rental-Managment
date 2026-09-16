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
const { settlement, quote } = require('../src/lib/pricing');

function issueRental(contractNo) {
  const car = db
    .prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES (?, 'Toyota', 'Corolla', 150)")
    .run('P-' + contractNo);
  const customer = db
    .prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Test', '123', 'DL-1')")
    .run();
  const p = settings.policy();
  db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate,
                          pickup_odometer, pickup_fuel, km_allowance_per_day, excess_km_rate,
                          total_amount, currency, fuel_charge_per_eighth, late_day_multiplier, status)
     VALUES (?,?,?,'2026-03-01','2026-03-05',150,10000,8,250,0.5,600,?,?,?,'active')`
  ).run(contractNo, car.lastInsertRowid, customer.lastInsertRowid,
        settings.currency(), p.fuelChargePerEighth, p.lateDayMultiplier);
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

test('return charges fall back to the environment until set', () => {
  settings.set('fuel_charge_per_eighth', '');
  settings.clearCache();
  db.prepare("DELETE FROM settings WHERE key IN ('fuel_charge_per_eighth','late_day_multiplier')").run();
  settings.clearCache();
  const p = settings.policy();
  assert.equal(p.fuelChargePerEighth, 25);
  assert.equal(p.lateDayMultiplier, 1.25);
});

test('return charges are stored and read back as numbers', () => {
  settings.set('fuel_charge_per_eighth', 40);
  settings.set('late_day_multiplier', 1.5);
  const p = settings.policy();
  assert.equal(p.fuelChargePerEighth, 40);
  assert.equal(p.lateDayMultiplier, 1.5);
  assert.equal(typeof p.fuelChargePerEighth, 'number');
});

test('a contract is settled at the rates it was issued under, not the current ones', () => {
  settings.set('fuel_charge_per_eighth', 25);
  settings.set('late_day_multiplier', 1.25);
  const issued = issueRental('RC-TEST-0010');
  assert.equal(issued.fuel_charge_per_eighth, 25);
  assert.equal(issued.late_day_multiplier, 1.25);

  // The business doubles its fuel charge and raises the late penalty afterwards.
  settings.set('fuel_charge_per_eighth', 50);
  settings.set('late_day_multiplier', 2);

  const ret = { returnDate: '2026-03-07', returnOdometer: 11000, returnFuel: 5, damageCharge: 0, otherCharges: 0 };
  const atIssuedRates = settlement(issued, ret, {
    fuelChargePerEighth: issued.fuel_charge_per_eighth,
    lateDayMultiplier: issued.late_day_multiplier
  });
  const atCurrentRates = settlement(issued, ret, settings.policy());

  assert.equal(atIssuedRates.lateFee, 375, '2 late days x 150 x 1.25');
  assert.equal(atIssuedRates.fuelFee, 75, '3 eighths x 25');
  assert.equal(atCurrentRates.lateFee, 600, 'current rates would bill 2 x 150 x 2');
  assert.equal(atCurrentRates.fuelFee, 150, 'current rates would bill 3 x 50');
  assert.notEqual(atIssuedRates.total, atCurrentRates.total,
    'the rate change must be visible, proving the snapshot is what protects the customer');
});

test('mileage defaults fall back to the environment until set', () => {
  db.prepare("DELETE FROM settings WHERE key IN ('km_allowance_per_day','excess_km_rate')").run();
  settings.clearCache();
  const m = settings.mileage();
  assert.equal(m.kmAllowancePerDay, 250);
  assert.equal(m.excessKmRate, 0.5);
});

test('mileage defaults are stored and read back as numbers', () => {
  settings.set('km_allowance_per_day', 400);
  settings.set('excess_km_rate', 0.75);
  const m = settings.mileage();
  assert.equal(m.kmAllowancePerDay, 400);
  assert.equal(m.excessKmRate, 0.75);
  assert.equal(typeof m.kmAllowancePerDay, 'number');
});

test('a zero allowance is honoured as unlimited, not treated as unset', () => {
  settings.set('km_allowance_per_day', 0);
  assert.equal(settings.mileage().kmAllowancePerDay, 0, '0 must not fall back to the default');
});

test('changing mileage defaults never re-prices an issued contract', () => {
  settings.set('km_allowance_per_day', 250);
  settings.set('excess_km_rate', 0.5);
  const issued = issueRental('RC-TEST-0020');
  assert.equal(issued.km_allowance_per_day, 250);

  settings.set('km_allowance_per_day', 100);
  settings.set('excess_km_rate', 2);

  const reread = db.prepare('SELECT * FROM rentals WHERE contract_no = ?').get('RC-TEST-0020');
  assert.equal(reread.km_allowance_per_day, 250, 'the contract keeps its own allowance');
  assert.equal(reread.excess_km_rate, 0.5, 'the contract keeps its own excess rate');

  // 4 contracted days x 250 km = 1000 included; 1400 driven leaves 400 over at 0.50
  const s = settlement(reread, {
    returnDate: '2026-03-05', returnOdometer: 11400, returnFuel: 8, damageCharge: 0, otherCharges: 0
  }, { fuelChargePerEighth: 25, lateDayMultiplier: 1.25 });
  assert.equal(s.kmAllowed, 1000);
  assert.equal(s.excessKm, 400);
  assert.equal(s.excessKmFee, 200, 'billed at the rate on the contract, not the new one');
});

test('default deposit falls back to the environment until set', () => {
  db.prepare("DELETE FROM settings WHERE key = 'default_deposit'").run();
  settings.clearCache();
  assert.equal(settings.deposit(), 0);
});

test('default deposit is stored and read back as a number', () => {
  settings.set('default_deposit', 500);
  assert.equal(settings.deposit(), 500);
  assert.equal(typeof settings.deposit(), 'number');
});

test('a zero default deposit is honoured, not treated as unset', () => {
  settings.set('default_deposit', 0);
  assert.equal(settings.deposit(), 0);
});

test('changing the default deposit never alters an existing contract', () => {
  settings.set('default_deposit', 500);
  db.prepare("UPDATE rentals SET deposit = 500 WHERE contract_no = 'RC-TEST-0020'").run();

  settings.set('default_deposit', 2000);

  const reread = db.prepare('SELECT deposit FROM rentals WHERE contract_no = ?').get('RC-TEST-0020');
  assert.equal(reread.deposit, 500, 'the contract keeps the deposit it was issued with');
});

test('discount default falls back to the environment until set', () => {
  db.prepare("DELETE FROM settings WHERE key LIKE 'default_discount%'").run();
  settings.clearCache();
  assert.deepEqual({ ...settings.discount() }, { value: 0, mode: 'amount' });
});

test('discount stores both the figure and the mode', () => {
  settings.set('default_discount', 10);
  settings.set('default_discount_mode', 'percent');
  const d = settings.discount();
  assert.equal(d.value, 10);
  assert.equal(d.mode, 'percent');

  settings.set('default_discount_mode', 'amount');
  assert.equal(settings.discount().mode, 'amount');
});

test('an unrecognised discount mode falls back to a fixed amount', () => {
  settings.set('default_discount_mode', 'nonsense');
  assert.equal(settings.discount().mode, 'amount');
});

test('a percentage resolves to the amount recorded on the contract', () => {
  // 10% of a 4-day rental at 150/day is 60, leaving a total of 540.
  const q = quote({ dailyRate: 150, startDate: '2026-03-01', endDate: '2026-03-05', discount: 60 });
  assert.equal(q.baseCharge, 600);
  assert.equal(q.total, 540);
});
