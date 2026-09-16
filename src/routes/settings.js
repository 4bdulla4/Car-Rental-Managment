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
    mileage: settings.mileage(),
    deposit: settings.deposit(),
    discount: settings.discount(),
    dailyRate: settings.dailyRate(),
    fleetRates: db
      .prepare('SELECT MIN(daily_rate) AS low, MAX(daily_rate) AS high FROM cars WHERE daily_rate > 0')
      .get(),
    carCount: db.prepare('SELECT COUNT(*) AS n FROM cars').get().n,
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

router.post('/mileage', (req, res) => {
  const allowance = Number(req.body.km_allowance_per_day);
  const rate = Number(req.body.excess_km_rate);
  const applyToFleet = req.body.apply_to_fleet === '1';
  const errors = [];

  if (!Number.isInteger(allowance) || allowance < 0 || allowance > 10000) {
    errors.push('Km included per day must be a whole number between 0 and 10,000 (0 means unlimited).');
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) {
    errors.push('Excess km rate must be a number between 0 and 1,000.');
  }

  if (errors.length) {
    return render(res, 400, {
      errors,
      mileage: { kmAllowancePerDay: req.body.km_allowance_per_day, excessKmRate: req.body.excess_km_rate }
    });
  }

  settings.set('km_allowance_per_day', allowance);
  settings.set('excess_km_rate', round2(rate));

  let message = 'Mileage defaults saved. They apply to cars you add from now on.';
  if (applyToFleet) {
    // Only the fleet is rewritten. Rentals keep the terms they were issued with.
    const updated = db
      .prepare('UPDATE cars SET km_allowance_per_day = ?, excess_km_rate = ?')
      .run(allowance, round2(rate)).changes;
    message = `Mileage defaults saved and applied to ${updated} car${updated === 1 ? '' : 's'}. Contracts already issued are unchanged.`;
  }

  req.session.flash = { type: 'success', message };
  res.redirect('/settings');
});

router.post('/deposit', (req, res) => {
  const amount = Number(req.body.default_deposit);

  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) {
    return render(res, 400, {
      errors: ['Default deposit must be a number between 0 and 1,000,000.'],
      deposit: req.body.default_deposit
    });
  }

  settings.set('default_deposit', round2(amount));
  req.session.flash = {
    type: 'success',
    message: 'Default deposit saved. It pre-fills new rentals and can still be changed on each one.'
  };
  res.redirect('/settings');
});

router.post('/discount', (req, res) => {
  const mode = req.body.default_discount_mode === 'percent' ? 'percent' : 'amount';
  const value = Number(req.body.default_discount);
  const limit = mode === 'percent' ? 100 : 1000000;

  if (!Number.isFinite(value) || value < 0 || value > limit) {
    return render(res, 400, {
      errors: [
        mode === 'percent'
          ? 'Default discount must be a percentage between 0 and 100.'
          : 'Default discount must be an amount between 0 and 1,000,000.'
      ],
      discount: { value: req.body.default_discount, mode }
    });
  }

  settings.set('default_discount', round2(value));
  settings.set('default_discount_mode', mode);
  req.session.flash = {
    type: 'success',
    message: mode === 'percent'
      ? `New rentals are pre-filled with a ${round2(value)}% discount, which staff can still change.`
      : 'Default discount saved. It pre-fills new rentals and can still be changed on each one.'
  };
  res.redirect('/settings');
});

router.post('/daily-rate', (req, res) => {
  const rate = Number(req.body.default_daily_rate);

  if (!Number.isFinite(rate) || rate < 0 || rate > 1000000) {
    return render(res, 400, {
      errors: ['Default daily rate must be a number between 0 and 1,000,000.'],
      dailyRate: req.body.default_daily_rate
    });
  }

  settings.set('default_daily_rate', round2(rate));
  req.session.flash = {
    type: 'success',
    message: 'Default daily rate saved. It pre-fills the form when you add a car; existing cars keep their own rates.'
  };
  res.redirect('/settings');
});

/**
 * One-off correction for a setup mistake: relabel contracts recorded in an old
 * currency to the active one. It changes the code only and never the amounts,
 * because there is no exchange rate involved.
 */
router.post('/currency/relabel', (req, res) => {
  const from = String(req.body.from || '').trim().toUpperCase();
  const to = settings.currency();

  if (!settings.isValidCurrency(from) || from === to) {
    req.session.flash = { type: 'error', message: 'Nothing to relabel.' };
    return res.redirect('/settings');
  }

  const changed = db
    .prepare('UPDATE rentals SET currency = ? WHERE currency = ?')
    .run(to, from).changes;

  req.session.flash = {
    type: 'success',
    message: `${changed} contract${changed === 1 ? '' : 's'} relabelled from ${from} to ${to}. Amounts were not converted.`
  };
  res.redirect('/settings');
});

module.exports = router;
