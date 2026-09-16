'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
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

function view(res, extra = {}) {
  const inUse = db
    .prepare('SELECT currency, COUNT(*) AS n FROM rentals GROUP BY currency ORDER BY n DESC')
    .all();
  res.render('settings/index', {
    title: 'Settings',
    currency: settings.currency(),
    common: COMMON,
    inUse,
    errors: [],
    ...extra
  });
}

router.get('/', (req, res) => view(res));

router.post('/currency', (req, res) => {
  const code = String(req.body.currency || '').trim().toUpperCase();

  if (!settings.isValidCurrency(code)) {
    return res.status(400).render('settings/index', {
      title: 'Settings',
      currency: settings.currency(),
      common: COMMON,
      inUse: db.prepare('SELECT currency, COUNT(*) AS n FROM rentals GROUP BY currency ORDER BY n DESC').all(),
      errors: ['Enter a currency code of 2 to 5 letters, such as SAR, AED or USD.']
    });
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

module.exports = router;
