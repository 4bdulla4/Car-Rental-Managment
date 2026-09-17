'use strict';
require('dotenv').config();

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isProduction = process.env.NODE_ENV === 'production';

const settings = {
  port: num(process.env.PORT, 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  databaseUrl: process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || '',
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '',
  company: {
    name: process.env.COMPANY_NAME || 'Car Rental',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    email: process.env.COMPANY_EMAIL || '',
    regNo: process.env.COMPANY_REG_NO || '',
    vatNo: process.env.COMPANY_VAT_NO || '',
    website: process.env.COMPANY_WEBSITE || '',
    bank: process.env.COMPANY_BANK || ''
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

/**
 * Configuration the app cannot run without. Reported on a setup page rather than
 * thrown at import, so a misconfigured deployment explains itself instead of
 * failing with an opaque 500.
 */
settings.missingConfig = function missingConfig() {
  const missing = [];
  if (!settings.databaseUrl) {
    missing.push({
      name: 'DATABASE_URL',
      hint: 'Turso database URL, e.g. libsql://your-db.turso.io (with DATABASE_AUTH_TOKEN).'
    });
  }
  if (isProduction && !process.env.SESSION_SECRET) {
    missing.push({
      name: 'SESSION_SECRET',
      hint: 'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    });
  }
  return missing;
};

module.exports = settings;
