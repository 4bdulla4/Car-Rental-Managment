'use strict';
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const termsLib = require('../lib/terms');
const { quoteRental } = require('../lib/pricing');
const { formatMoney } = require('../lib/money');
const { fuelLabel } = require('../lib/contracts');

const router = express.Router();

const SELECT = `
  SELECT r.*,
         c.plate, c.make, c.model, c.year, c.color, c.vin,
         cu.full_name, cu.phone, cu.email, cu.id_number, cu.license_number, cu.license_expiry,
         cu.address, cu.emergency_name, cu.emergency_phone,
         u.name AS issued_by
  FROM rentals r
  JOIN cars c ON c.id = r.car_id
  JOIN customers cu ON cu.id = r.customer_id
  LEFT JOIN users u ON u.id = r.created_by`;

/** Tokens are compared in constant time, so a wrong one leaks nothing by timing. */
function sameToken(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function findByToken(token) {
  if (!/^[a-f0-9]{32,64}$/.test(String(token || ''))) return null;
  const rental = await db.prepare(`${SELECT} WHERE r.sign_token = ?`).get(String(token));
  if (!rental || !sameToken(rental.sign_token, token)) return null;
  return rental;
}

/** Everything the agreement template needs, for a visitor with no session. */
async function agreementLocals(rental) {
  return {
    rental,
    quote: quoteRental(rental),
    policy: {
      fuelChargePerEighth: rental.fuel_charge_per_eighth ?? config.fuelChargePerEighth,
      lateDayMultiplier: rental.late_day_multiplier ?? config.lateDayMultiplier
    },
    terms: termsLib.forCompany(settings.termsText(), settings.company().name),
    agreement: settings.contract(),
    currency: rental.currency || settings.currency(),
    money: (v) => formatMoney(v, rental.currency || settings.currency()),
    fuelLabel,
    company: settings.company(),
    accent: settings.accent(),
    theme: 'dark'
  };
}

router.get('/:token', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) {
    return res.status(404).render('sign/invalid', {
      title: 'Link not valid',
      theme: 'dark',
      accent: settings.accent(),
      company: settings.company()
    });
  }

  res.render('sign/index', {
    title: `Sign ${rental.contract_no}`,
    ...(await agreementLocals(rental)),
    signed: Boolean(rental.signature_data),
    errors: []
  });
});

router.get('/:token/document', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) return res.status(404).send('Not found');
  res.render('contracts/handover', {
    title: rental.contract_no,
    embedded: true,
    ...(await agreementLocals(rental))
  });
});

router.post('/:token', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) {
    return res.status(404).render('sign/invalid', {
      title: 'Link not valid', theme: 'dark', accent: settings.accent(), company: settings.company()
    });
  }

  const name = String(req.body.signed_name || '').trim();
  const signature = String(req.body.signature_data || '');
  const agreed = req.body.agreed === '1';
  const errors = [];

  if (!name) errors.push('Please type your full name.');
  if (!agreed) errors.push('Please confirm you agree to the terms.');
  // A data URL for a small PNG; anything else is refused rather than stored.
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) {
    errors.push('Please draw your signature in the box.');
  } else if (signature.length > 400000) {
    errors.push('That signature image is too large.');
  }

  if (rental.signature_data) {
    errors.push('This agreement has already been signed.');
  }

  if (errors.length) {
    return res.status(400).render('sign/index', {
      title: `Sign ${rental.contract_no}`,
      ...(await agreementLocals(rental)),
      signed: Boolean(rental.signature_data),
      errors
    });
  }

  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  await db.prepare(
    `UPDATE rentals SET signature_data = ?, signed_name = ?, signed_ip = ?,
                        handover_signed_at = datetime('now')
     WHERE id = ? AND signature_data IS NULL`
  ).run(signature, name, ip, rental.id);

  res.redirect(`/sign/${req.params.token}?done=1`);
});

module.exports = router;
