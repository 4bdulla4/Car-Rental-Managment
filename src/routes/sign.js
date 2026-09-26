'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const esign = require('../lib/esign');
const agreementSnapshot = require('../lib/agreement');
const mailer = require('../lib/mailer');
const mailConfig = require('../lib/config-mail');
const { quoteRental } = require('../lib/pricing');
const { formatMoney } = require('../lib/money');
const { fuelLabel } = require('../lib/contracts');

const router = express.Router();

const MAX_CODE_TRIES = 6;

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

async function findByToken(token) {
  if (!/^[a-f0-9]{32,64}$/.test(String(token || ''))) return null;
  const rental = await db.prepare(`${SELECT} WHERE r.sign_token = ?`).get(String(token));
  if (!rental || !esign.sameSecret(rental.sign_token, token)) return null;
  return rental;
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

/** Everything the agreement template needs, for a visitor with no session. */
function agreementLocals(rental) {
  const currency = rental.currency || settings.currency();
  // The wording this contract was issued under, not whatever the settings say now.
  const wording = agreementSnapshot.restore(rental);
  return {
    rental,
    quote: quoteRental(rental),
    policy: {
      fuelChargePerEighth: rental.fuel_charge_per_eighth ?? config.fuelChargePerEighth,
      lateDayMultiplier: rental.late_day_multiplier ?? config.lateDayMultiplier
    },
    terms: wording.terms,
    agreement: wording.agreement,
    company: wording.company,
    currency,
    money: (v) => formatMoney(v, currency),
    fuelLabel,
    accent: settings.accent(),
    theme: 'dark'
  };
}

/** The parts the document hash is taken over. */
const hashParts = (locals) => ({
  terms: locals.terms,
  agreement: locals.agreement,
  company: locals.company,
  currency: locals.currency
});

const dead = (res, status, title, message) =>
  res.status(status).render('sign/invalid', {
    title,
    message,
    theme: 'dark',
    accent: settings.accent(),
    company: settings.company()
  });

/** The access code clears once per browser session, not once per request. */
const unlocked = (req, token) => Boolean(req.session && req.session.signed && req.session.signed[token]);

function unlock(req, token) {
  req.session.signed = { ...(req.session.signed || {}), [token]: true };
}

function gate(req, res, rental, errors = []) {
  return res.status(errors.length ? 400 : 200).render('sign/code', {
    title: `Sign ${rental.contract_no}`,
    theme: 'dark',
    accent: settings.accent(),
    company: settings.company(),
    rental,
    errors,
    locked: Number(rental.sign_code_tries) >= MAX_CODE_TRIES,
    csrfToken: res.locals.csrfToken
  });
}

router.get('/:token', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) return dead(res, 404, 'Link not valid', 'This signing link is not one we recognise.');

  const signed = Boolean(rental.signature_data);
  if (!signed && esign.isExpired(rental)) {
    return dead(res, 410, 'Link expired',
      'This signing link has expired. Ask us to send you a new one — it only takes a moment.');
  }

  // Opening is recorded once: the first time is the one that means anything.
  if (!rental.sign_opened_at) {
    await db.prepare('UPDATE rentals SET sign_opened_at = ?, sign_opened_ip = ? WHERE id = ? AND sign_opened_at IS NULL')
      .run(esign.stamp(), clientIp(req), rental.id);
  }

  const needsCode = !signed && settings.signing().codeRequired && rental.sign_code;
  if (needsCode && !unlocked(req, rental.sign_token)) return gate(req, res, rental);

  const locals = agreementLocals(rental);
  res.render('sign/index', {
    title: `Sign ${rental.contract_no}`,
    ...locals,
    consents: esign.CONSENTS,
    signed,
    integrity: esign.integrity(rental, hashParts(locals)),
    fingerprint: esign.fingerprint(rental.sign_doc_hash),
    signedConsents: esign.consentsOf(rental),
    errors: []
  });
});

router.post('/:token/code', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) return dead(res, 404, 'Link not valid', 'This signing link is not one we recognise.');
  if (rental.signature_data) return res.redirect(`/sign/${rental.sign_token}`);

  if (Number(rental.sign_code_tries) >= MAX_CODE_TRIES) {
    return gate(req, res, rental, ['Too many attempts. Ask us to send a new link.']);
  }

  const given = String(req.body.code || '').replace(/\D/g, '');
  if (!esign.sameSecret(rental.sign_code, given)) {
    await db.prepare('UPDATE rentals SET sign_code_tries = sign_code_tries + 1 WHERE id = ?').run(rental.id);
    const left = MAX_CODE_TRIES - Number(rental.sign_code_tries) - 1;
    return gate(req, res, { ...rental, sign_code_tries: Number(rental.sign_code_tries) + 1 }, [
      left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'That code is not right, and there are no attempts left. Ask us to send a new link.'
    ]);
  }

  await db.prepare("UPDATE rentals SET sign_code_at = ?, sign_code_tries = 0 WHERE id = ?")
    .run(esign.stamp(), rental.id);
  unlock(req, rental.sign_token);
  res.redirect(`/sign/${rental.sign_token}`);
});

router.get('/:token/document', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) return res.status(404).send('Not found');
  if (!rental.signature_data && settings.signing().codeRequired && rental.sign_code && !unlocked(req, rental.sign_token)) {
    return res.status(403).send('Enter your access code first.');
  }
  res.render('contracts/handover', {
    title: rental.contract_no,
    embedded: true,
    ...agreementLocals(rental)
  });
});

router.post('/:token', async (req, res) => {
  const rental = await findByToken(req.params.token);
  if (!rental) return dead(res, 404, 'Link not valid', 'This signing link is not one we recognise.');

  if (rental.signature_data) {
    return dead(res, 409, 'Already signed', 'This agreement has already been signed.');
  }
  if (esign.isExpired(rental)) {
    return dead(res, 410, 'Link expired', 'This signing link has expired. Ask us to send you a new one.');
  }
  if (settings.signing().codeRequired && rental.sign_code && !unlocked(req, rental.sign_token)) {
    return gate(req, res, rental, ['Enter the access code before signing.']);
  }

  const name = String(req.body.signed_name || '').trim();
  const signature = String(req.body.signature_data || '');
  const ticked = esign.CONSENTS.filter((c) => req.body['consent_' + c.id] === '1');
  const errors = [];

  if (name.length < 3) errors.push('Please type your full name as it appears on your licence.');
  if (name.length > 80) errors.push('That name is too long.');
  if (ticked.length !== esign.CONSENTS.length) {
    errors.push('Please tick every confirmation — each one is a separate statement you are making.');
  }
  // A data URL for a small PNG; anything else is refused rather than stored.
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature)) {
    errors.push('Please draw your signature in the box.');
  } else if (signature.length > 400000) {
    errors.push('That signature image is too large.');
  } else if (signature.length < 800) {
    errors.push('That signature looks empty. Please draw it again.');
  }

  const locals = agreementLocals(rental);

  if (errors.length) {
    return res.status(400).render('sign/index', {
      title: `Sign ${rental.contract_no}`,
      ...locals,
      consents: esign.CONSENTS,
      signed: false,
      integrity: { state: 'unsigned' },
      fingerprint: '',
      signedConsents: [],
      errors,
      submitted: { name, ticked: ticked.map((c) => c.id) }
    });
  }

  // The hash is taken over the terms as they stand at this moment, so what was
  // agreed to can be checked against the record for the life of the contract.
  const hash = esign.documentHash(rental, hashParts(locals));
  const result = await db.prepare(
    `UPDATE rentals SET signature_data = ?, signed_name = ?, signed_ip = ?, signed_user_agent = ?,
                        signed_email = ?, sign_doc_hash = ?, sign_consents = ?,
                        handover_signed_at = ?
     WHERE id = ? AND signature_data IS NULL`
  ).run(
    signature, name, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300),
    rental.sent_to || rental.email || null, hash, JSON.stringify(ticked), esign.stamp(), rental.id
  );

  // Two tabs, one contract: the second submission must not overwrite the first.
  if (result && result.changes === 0) {
    return dead(res, 409, 'Already signed', 'This agreement has already been signed.');
  }

  await sendSignedCopy(req, rental, { name, hash });
  res.redirect(`/sign/${rental.sign_token}`);
});

/**
 * The signer gets their own copy as soon as they sign.
 *
 * Handing the signer the record is part of what makes the signature stand up:
 * they can see what they agreed to without asking us for it, and the fingerprint
 * lets them check later that it has not moved. A mail failure must not undo a
 * valid signature, so it is recorded and swallowed rather than thrown.
 */
async function sendSignedCopy(req, rental, { name, hash }) {
  const to = rental.sent_to || rental.email;
  if (!to || !mailer.isConfigured()) return false;

  const company = settings.company();
  const base = mailConfig.baseUrl || `${req.protocol}://${req.get('host')}`;
  const url = `${base}/sign/${rental.sign_token}`;
  const print = esign.fingerprint(hash);

  const result = await mailer.send({
    to,
    subject: `Signed: rental agreement ${rental.contract_no} — ${company.name}`,
    text: `Dear ${name},\n\nThank you for signing rental agreement ${rental.contract_no} for ${rental.plate}.\n\nYou can read it again at any time here:\n${url}\n\nDocument fingerprint: ${print}\nThis is how either of us can show the agreement has not been changed since you signed it.\n\n${company.name}${company.phone ? ' · ' + company.phone : ''}`,
    html: `<p><img src="${base}/img/logo-stack-ink.png" width="176" height="80" alt="${company.name}"></p>
<p>Dear ${name},</p>
<p>Thank you for signing rental agreement <strong>${rental.contract_no}</strong> for <strong>${rental.plate}</strong>.</p>
<p><a href="${url}" style="display:inline-block;padding:11px 18px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Read your signed agreement</a></p>
<p style="color:#555;font-size:13px">Document fingerprint: <strong style="font-family:monospace">${print}</strong><br>
This is how either of us can show the agreement has not been changed since you signed it.</p>
<p style="color:#555;font-size:13px">${company.name}${company.phone ? ' · ' + company.phone : ''}</p>`
  });

  if (result.sent) {
    await db.prepare('UPDATE rentals SET signed_copy_at = ?, signed_email = ? WHERE id = ?')
      .run(esign.stamp(), to, rental.id);
  }
  return result.sent;
}

module.exports = router;
