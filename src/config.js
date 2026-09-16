'use strict';
require('dotenv').config();
const path = require('path');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production — sessions would otherwise be forgeable.');
}

module.exports = {
  port: num(process.env.PORT, 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'car-renter.db'),
  company: {
    name: process.env.COMPANY_NAME || 'Car Renter',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || '',
    regNo: process.env.COMPANY_REG_NO || ''
  },
  currency: process.env.CURRENCY || 'SAR',
  // Charge applied per missing 1/8 of a tank at return.
  fuelChargePerEighth: num(process.env.FUEL_CHARGE_PER_EIGHTH, 25),
  // Each late day is billed at daily rate x this multiplier.
  lateDayMultiplier: num(process.env.LATE_DAY_MULTIPLIER, 1.25),
  // Mileage terms a newly added car starts with. 0 allowance means unlimited.
  defaultKmAllowance: num(process.env.DEFAULT_KM_ALLOWANCE, 250),
  defaultExcessKmRate: num(process.env.DEFAULT_EXCESS_KM_RATE, 0.5),
  // Security deposit pre-filled on a new rental.
  defaultDeposit: num(process.env.DEFAULT_DEPOSIT, 0),
  // Standing discount pre-filled on a new rental: a flat amount or a percentage.
  defaultDiscount: num(process.env.DEFAULT_DISCOUNT, 0),
  defaultDiscountMode: process.env.DEFAULT_DISCOUNT_MODE === 'percent' ? 'percent' : 'amount',
  // Daily rate pre-filled when a car is added. Real rates live on each car.
  defaultDailyRate: num(process.env.DEFAULT_DAILY_RATE, 0)
};
