'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rentalDays, quote, quoteRental, settlement } = require('../src/lib/pricing');
const { round2, formatMoney } = require('../src/lib/money');

const POLICY = { fuelChargePerEighth: 25, lateDayMultiplier: 1.25 };

const baseRental = {
  start_date: '2026-03-01',
  end_date: '2026-03-05',
  daily_rate: 150,
  km_allowance_per_day: 250,
  excess_km_rate: 0.5,
  pickup_odometer: 10000,
  pickup_fuel: 8,
  deposit: 500,
  discount: 0
};

const cleanReturn = {
  returnDate: '2026-03-05',
  returnOdometer: 11000,
  returnFuel: 8,
  damageCharge: 0,
  otherCharges: 0
};

test('rentalDays counts whole days and never bills less than one', () => {
  assert.equal(rentalDays('2026-03-01', '2026-03-05'), 4);
  assert.equal(rentalDays('2026-03-01', '2026-03-01'), 1);
  assert.equal(rentalDays('2026-02-27', '2026-03-01'), 2);
  assert.equal(rentalDays('2026-03-05', '2026-03-01'), 1);
});

test('quote applies the discount and reports the balance after deposit', () => {
  const q = quote({ dailyRate: 150, startDate: '2026-03-01', endDate: '2026-03-05', discount: 100, deposit: 500 });
  assert.equal(q.days, 4);
  assert.equal(q.baseCharge, 600);
  assert.equal(q.total, 500);
  assert.equal(q.balanceDue, 0);
});

test('an on-time, on-allowance, full-tank return charges only the rental', () => {
  const s = settlement(baseRental, cleanReturn, POLICY);
  assert.equal(s.baseCharge, 600);
  assert.equal(s.lateFee, 0);
  assert.equal(s.excessKmFee, 0);
  assert.equal(s.fuelFee, 0);
  assert.equal(s.total, 600);
  assert.equal(s.balanceDue, 100);
});

test('late days are billed at the daily rate times the multiplier', () => {
  const s = settlement(baseRental, { ...cleanReturn, returnDate: '2026-03-07' }, POLICY);
  assert.equal(s.actualDays, 6);
  assert.equal(s.lateDays, 2);
  assert.equal(s.lateFee, round2(2 * 150 * 1.25));
  assert.equal(s.total, 975);
});

test('excess kilometres are charged beyond the contracted allowance', () => {
  const s = settlement(baseRental, { ...cleanReturn, returnOdometer: 11250 }, POLICY);
  assert.equal(s.kmDriven, 1250);
  assert.equal(s.kmAllowed, 1000);
  assert.equal(s.excessKm, 250);
  assert.equal(s.excessKmFee, 125);
});

test('a zero allowance means unlimited kilometres', () => {
  const s = settlement({ ...baseRental, km_allowance_per_day: 0 }, { ...cleanReturn, returnOdometer: 99000 }, POLICY);
  assert.equal(s.excessKm, 0);
  assert.equal(s.excessKmFee, 0);
});

test('missing fuel is charged per eighth, and extra fuel is never refunded', () => {
  const short = settlement(baseRental, { ...cleanReturn, returnFuel: 5 }, POLICY);
  assert.equal(short.fuelMissingEighths, 3);
  assert.equal(short.fuelFee, 75);

  const over = settlement({ ...baseRental, pickup_fuel: 4 }, { ...cleanReturn, returnFuel: 8 }, POLICY);
  assert.equal(over.fuelMissingEighths, 0);
  assert.equal(over.fuelFee, 0);
});

test('a deposit larger than the total produces a refund (negative balance)', () => {
  const s = settlement({ ...baseRental, deposit: 1000 }, cleanReturn, POLICY);
  assert.equal(s.total, 600);
  assert.equal(s.balanceDue, -400);
});

test('all charges combine into one total', () => {
  const s = settlement(
    { ...baseRental, discount: 50 },
    { returnDate: '2026-03-06', returnOdometer: 11300, returnFuel: 6, damageCharge: 200, otherCharges: 80 },
    POLICY
  );
  assert.equal(s.lateFee, 187.5);
  assert.equal(s.excessKmFee, 150);
  assert.equal(s.fuelFee, 50);
  assert.equal(s.total, 1217.5);
  assert.equal(s.balanceDue, 717.5);
});

test('money helpers round and format consistently', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(formatMoney(1234.5, 'SAR'), '1,234.50 SAR');
  assert.equal(formatMoney(-400, 'SAR'), '-400.00 SAR');
});

test('quoteRental reads the database column names, not camelCase', () => {
  // Regression: quote() was once called with a snake_case row, which silently
  // produced a zero total and stored it on every active rental.
  const row = {
    start_date: '2026-03-01',
    end_date: '2026-03-05',
    daily_rate: 150,
    discount: 100,
    deposit: 500
  };
  const q = quoteRental(row);
  assert.equal(q.days, 4);
  assert.equal(q.baseCharge, 600);
  assert.equal(q.total, 500);
  assert.equal(q.balanceDue, 0);

  // The shape that caused the bug still returns zero, which is why the helper exists.
  assert.equal(quote(row).baseCharge, 0);
});
