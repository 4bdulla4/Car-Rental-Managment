'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
const { round2 } = require('../lib/money');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// Offered in the picker; any 2-5 letter code is accepted.
const COMMON = [
  ['SAR', 'Saudi riyal'], ['AED', 'UAE dirham'], ['KWD', 'Kuwaiti dinar'],
  ['QAR', 'Qatari riyal'], ['BHD', 'Bahraini dinar'], ['OMR', 'Omani rial'],
  ['EGP', 'Egyptian pound'], ['JOD', 'Jordanian dinar'], ['USD', 'US dollar'],
  ['EUR', 'Euro'], ['GBP', 'Pound sterling'], ['TRY', 'Turkish lira'],
  ['INR', 'Indian rupee'], ['PKR', 'Pakistani rupee']
];

function render(res, status, extra = {}) {
  const inUse = db
    .prepare('SELECT currency, COUNT(*) AS n FROM rentals GROUP BY currency ORDER BY n DESC')
    .all();
  return res.status(status).render('settings/index', {
    title: 'Settings',
    currency: settings.currency(),
    details: settings.company(),
    policy: settings.policy(),
    common: COMMON,
    inUse,
    errors: [],
    ...extra
  });
}

router.get('/', (req, res) => render(res, 200));

router.post('/currency', (req, res) => {
  const code = String(req.body.currency || '').trim().toUpperCase();

  if (!settings.isValidCurrency(code)) {
    return render(res, 400, { errors: ['Enter a currency code of 2 to 5 letters, such as SAR, AED or USD.'] });
  }
  if (code === settings.currency()) {
    req.session.flash = { type: 'success', message: `Currency is already ${code}.` };
    return res.redirect('/settings');
  }

  settings.set('currency', code);
  req.session.flash = {
    type: 'success',
    message: `Currency changed to ${code}. Contracts already issued keep the currency they were written in.`
  };
  res.redirect('/settings');
});

const FIELDS = [
  { key: 'company_name', label: 'Company name', max: 80, required: true },
  { key: 'company_address', label: 'Address', max: 160 },
  { key: 'company_phone', label: 'Phone', max: 40 },
  { key: 'company_email', label: 'Email', max: 120, email: true },
  { key: 'company_reg_no', label: 'Registration number', max: 40 }
];

router.post('/company', (req, res) => {
  const values = {};
  const errors = [];

  for (const field of FIELDS) {
    const value = String(req.body[field.key] || '').trim().replace(/\s+/g, ' ');
    if (field.required && !value) errors.push(`${field.label} is required.`);
    if (value.length > field.max) errors.push(`${field.label} must be ${field.max} characters or fewer.`);
    if (field.email && value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      errors.push(`${field.label} must be a valid email address, or left blank.`);
    }
    values[field.key] = value;
  }

  if (errors.length) {
    // Keep what was typed on screen rather than discarding it.
    return render(res, 400, {
      errors,
      details: {
        name: values.company_name,
        address: values.company_address,
        phone: values.company_phone,
        email: values.company_email,
        regNo: values.company_reg_no
      }
    });
  }

  for (const field of FIELDS) settings.set(field.key, values[field.key]);
  req.session.flash = { type: 'success', message: 'Company details updated. They appear on contracts issued from now on.' };
  res.redirect('/settings');
});

router.post('/policy', (req, res) => {
  const fuel = Number(req.body.fuel_charge_per_eighth);
  const late = Number(req.body.late_day_multiplier);
  const errors = [];

  if (!Number.isFinite(fuel) || fuel < 0 || fuel > 10000) {
    errors.push('Fuel charge must be a number between 0 and 10,000.');
  }
  if (!Number.isFinite(late) || late < 0 || late > 10) {
    errors.push('Late day multiplier must be a number between 0 and 10.');
  }

  if (errors.length) {
    return render(res, 400, {
      errors,
      policy: {
        fuelChargePerEighth: req.body.fuel_charge_per_eighth,
        lateDayMultiplier: req.body.late_day_multiplier
      }
    });
  }

  settings.set('fuel_charge_per_eighth', round2(fuel));
  settings.set('late_day_multiplier', round2(late));
  req.session.flash = {
    type: 'success',
    message: 'Return charges updated. Contracts already issued are still settled at the rates printed on them.'
  };
  res.redirect('/settings');
});

module.exports = router;
