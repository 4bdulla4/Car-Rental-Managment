'use strict';
require('dotenv').config();
const path = require('path');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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
  lateDayMultiplier: num(process.env.LATE_DAY_MULTIPLIER, 1.25)
};
