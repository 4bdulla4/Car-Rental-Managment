'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const { nextContractNo } = require('../lib/contracts');
const { quote, quoteRental, settlement, rentalDays } = require('../lib/pricing');
const { round2, formatMoney } = require('../lib/money');
const crypto = require('crypto');
const mailer = require('../lib/mailer');
const mailConfig = require('../lib/config-mail');
const settings = require('../lib/settings');
const esign = require('../lib/esign');
const agreementSnapshot = require('../lib/agreement');
const licence = require('../lib/licence');

const router = express.Router();

/** Photographs do not fit in the default body limit. */
const photoBody = express.urlencoded({ extended: false, limit: '1800kb' });
router.use(requireAuth);

const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
/**
 * Rates a rental is settled against: the ones recorded when it was issued, which
 * are the rates printed on the signed agreement. Older rows fall back to config.
 */
function rentalPolicy(rental) {
  return {
    fuelChargePerEighth: rental.fuel_charge_per_eighth ?? config.fuelChargePerEighth,
    lateDayMultiplier: rental.late_day_multiplier ?? config.lateDayMultiplier
  };
}

const RENTAL_SELECT = `
  SELECT r.*,
         c.plate, c.make, c.model, c.year, c.color, c.vin, c.transmission, c.seats,
         cu.full_name, cu.phone, cu.email, cu.id_number, cu.license_number, cu.license_expiry, cu.address,
         cu.emergency_name, cu.emergency_phone,
         u.name AS issued_by
  FROM rentals r
  JOIN cars c ON c.id = r.car_id
  JOIN customers cu ON cu.id = r.customer_id
  LEFT JOIN users u ON u.id = r.created_by`;

/** Render locals so a single rental always displays in the currency it was issued in. */
function inCurrency(rental) {
  const code = rental.currency || settings.currency();
  return { currency: code, money: (v) => formatMoney(v, code) };
}

async function findRental(id) {
  return db.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).get(Number(id));
}

/** Counts across the whole table, used for the cards and their filters. */
async function rentalStats(now) {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'active' AND end_date < ? THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN status = 'active' AND end_date = ? THEN 1 ELSE 0 END) AS due_today,
              SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
       FROM rentals`
    )
    .get(now, now);
  return {
    active: Number(row.active) || 0,
    overdue: Number(row.overdue) || 0,
    dueToday: Number(row.due_today) || 0,
    closed: Number(row.closed) || 0
  };
}

router.get('/', async (req, res) => {
  const now = today();
  const view = ['active', 'overdue', 'due', 'closed', 'cancelled'].includes(req.query.view)
    ? req.query.view
    : '';
  const q = String(req.query.q || '').trim();

  const params = [];
  let sql = `${RENTAL_SELECT} WHERE 1 = 1`;
  if (view === 'overdue') {
    sql += " AND r.status = 'active' AND r.end_date < ?";
    params.push(now);
  } else if (view === 'due') {
    sql += " AND r.status = 'active' AND r.end_date = ?";
    params.push(now);
  } else if (view) {
    sql += ' AND r.status = ?';
    params.push(view);
  }
  if (q) {
    sql += ' AND (r.contract_no LIKE ? OR c.plate LIKE ? OR cu.full_name LIKE ? OR cu.phone LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  // Open contracts first, soonest due at the top.
  sql += " ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END, r.end_date, r.created_at DESC";

  res.render('rentals/index', {
    title: 'Rentals',
    rentals: await db.prepare(sql).all(...params),
    stats: await rentalStats(now),
    view,
    q,
    today: now
  });
});

router.get('/new', async (req, res) => {
  const cars = await db.prepare("SELECT * FROM cars WHERE status = 'available' ORDER BY plate").all();
  const customers = await db.prepare('SELECT * FROM customers ORDER BY full_name').all();
  const standingDiscount = settings.discount();
  const agreement = settings.contract();
  res.render('rentals/new', {
    title: 'New rental',
    cars,
    customers,
    errors: [],
    standingDiscount,
    agreement,
    form: {
      car_id: Number(req.query.car_id) || '',
      customer_id: Number(req.query.customer_id) || '',
      start_date: today(),
      end_date: today(),
      deposit: settings.deposit(),
      discount: standingDiscount.mode === 'amount' ? standingDiscount.value : 0,
      start_time: '09:00',
      end_time: '09:00',
      deductible: agreement.deductible,
      return_location: agreement.returnLocation
    }
  });
});

router.post('/', async (req, res) => {
  const form = {
    car_id: Number(req.body.car_id) || 0,
    customer_id: Number(req.body.customer_id) || 0,
    start_date: String(req.body.start_date || ''),
    end_date: String(req.body.end_date || ''),
    daily_rate: Number(req.body.daily_rate) || 0,
    km_allowance_per_day: Number(req.body.km_allowance_per_day) || 0,
    excess_km_rate: Number(req.body.excess_km_rate) || 0,
    deposit: Number(req.body.deposit) || 0,
    discount: Number(req.body.discount) || 0,
    pickup_odometer: Number(req.body.pickup_odometer) || 0,
    pickup_fuel: Math.max(0, Math.min(8, Number(req.body.pickup_fuel) || 0)),
    pickup_notes: String(req.body.pickup_notes || '').trim(),
    start_time: String(req.body.start_time || '').trim(),
    end_time: String(req.body.end_time || '').trim(),
    deductible: Number(req.body.deductible) || 0,
    return_location: String(req.body.return_location || '').trim()
  };

  const errors = [];
  const car = await db.prepare('SELECT * FROM cars WHERE id = ?').get(form.car_id);
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(form.customer_id);

  if (!car) errors.push('Select a car.');
  else if (car.status !== 'available') errors.push(`${car.plate} is not available (${car.status}).`);
  if (!customer) errors.push('Select a customer.');
  if (!isDate(form.start_date) || !isDate(form.end_date)) errors.push('Start and end dates are required.');
  else if (form.end_date < form.start_date) errors.push('End date cannot be before the start date.');
  if (form.daily_rate <= 0) errors.push('Daily rate must be greater than zero.');
  if (form.discount < 0) errors.push('Discount cannot be negative.');
  if (isDate(form.start_date) && isDate(form.end_date) && form.daily_rate > 0) {
    const gross = quoteRental({ ...form, discount: 0 }).baseCharge;
    if (form.discount > gross) {
      errors.push(`Discount cannot be more than the rental charge of ${formatMoney(gross, settings.currency())}.`);
    }
  }
  if (car && form.pickup_odometer < 0) errors.push('Odometer reading cannot be negative.');
  if (customer && customer.license_expiry && customer.license_expiry < form.end_date) {
    errors.push(`${customer.full_name}'s licence expires on ${customer.license_expiry}, before the rental ends.`);
  }

  if (errors.length) {
    const cars = await db.prepare("SELECT * FROM cars WHERE status = 'available' ORDER BY plate").all();
    const customers = await db.prepare('SELECT * FROM customers ORDER BY full_name').all();
    return res.status(400).render('rentals/new', {
      title: 'New rental', cars, customers, errors, form,
      standingDiscount: settings.discount(), agreement: settings.contract()
    });
  }

  const q = quoteRental(form);
  const issuePolicy = settings.policy();
  const contractNo = await db.tx(async (t) => {
    const contract_no = await nextContractNo(t);
    await t.prepare(
      `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate,
                            km_allowance_per_day, excess_km_rate, deposit, discount, pickup_odometer,
                            pickup_fuel, pickup_notes, base_charge, total_amount, balance_due,
                            currency, fuel_charge_per_eighth, late_day_multiplier,
                            start_time, end_time, deductible, return_location,
                            contract_snapshot, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)`
    ).run(
      contract_no, form.car_id, form.customer_id, form.start_date, form.end_date, form.daily_rate,
      form.km_allowance_per_day, form.excess_km_rate, form.deposit, form.discount, form.pickup_odometer,
      form.pickup_fuel, form.pickup_notes, q.baseCharge, q.total, q.balanceDue,
      settings.currency(), issuePolicy.fuelChargePerEighth, issuePolicy.lateDayMultiplier,
      form.start_time, form.end_time, form.deductible, form.return_location,
      agreementSnapshot.serialise(),
      req.user.id
    );
    await t.prepare("UPDATE cars SET status = 'rented', odometer = ?, fuel_level = ? WHERE id = ?")
      .run(form.pickup_odometer, form.pickup_fuel, form.car_id);
    return contract_no;
  });

  const created = await db.prepare('SELECT id FROM rentals WHERE contract_no = ?').get(contractNo);
  req.session.flash = { type: 'success', message: `Contract ${contractNo} issued.` };
  res.redirect(`/rentals/${created.id}/contract`);
});

router.get('/:id', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  const q = quoteRental(rental);
  const currency = rental.currency || settings.currency();
  res.render('rentals/show', {
    title: rental.contract_no,
    rental,
    quote: q,
    today: today(),
    signUrl: rental.sign_token ? signUrl(req, rental.sign_token) : null,
    mailReady: mailer.isConfigured(),
    signing: settings.signing(),
    trail: esign.auditTrail(rental),
    fingerprint: esign.fingerprint(rental.sign_doc_hash),
    integrity: esign.integrity(rental, {
      ...agreementSnapshot.restore(rental),
      currency,
      licence: await licence.digests(rental.id)
    }),
    linkExpired: esign.isExpired(rental),
    shots: await licence.summary(rental.id),
    ...inCurrency(rental)
  });
});

/**
 * The licence taken at the counter, for a rental that never goes out by email.
 * Same slots, same contract: whoever captured it is recorded either way.
 */
router.post('/:id/licence', photoBody, async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });

  const problems = [];
  for (const kind of licence.KINDS) {
    const given = req.body[kind];
    if (!given) continue;
    const parsed = licence.parseUpload(given);
    if (!parsed.ok) {
      problems.push(`${licence.LABELS[kind]}: ${parsed.reason}`);
      continue;
    }
    await licence.save(rental.id, kind, parsed, {
      by: `staff:${req.user.name}`,
      ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
    });
  }

  req.session.flash = problems.length
    ? { type: 'error', message: problems.join(' ') }
    : { type: 'success', message: 'Licence photos saved to this contract.' };
  res.redirect(`/rentals/${rental.id}`);
});

router.get('/:id/licence/:kind', async (req, res) => {
  const row = await licence.image(req.params.id, req.params.kind);
  if (!row) return res.status(404).send('Not found');
  res.type(row.mime)
    .set('Cache-Control', 'private, no-store')
    .set('X-Content-Type-Options', 'nosniff')
    .send(Buffer.from(row.image, 'base64'));
});

/**
 * Removing a photograph. Allowed while the contract is unsigned — a bad photo
 * should be retaken — but never afterwards: the signature was given against
 * that copy, and the hash recorded with it would no longer verify.
 */
router.post('/:id/licence/:kind/delete', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });

  if (rental.signature_data) {
    req.session.flash = {
      type: 'error',
      message: 'That agreement is signed. The licence copy is part of what was signed and cannot be removed.'
    };
  } else if (!licence.isKind(req.params.kind)) {
    req.session.flash = { type: 'error', message: 'There is nothing of that kind on this contract.' };
  } else {
    await licence.remove(rental.id, req.params.kind);
    req.session.flash = { type: 'success', message: 'Photo removed. Take it again when you can.' };
  }
  res.redirect(`/rentals/${rental.id}`);
});

/**
 * The certificate of completion: the evidence, on one printable page.
 *
 * It exists to be produced if the signature is ever challenged, so it states
 * what kind of signature this is rather than overclaiming, quotes the
 * confirmations in the words the signer saw, and recomputes the document hash
 * at the moment of printing so the page says whether the agreement still
 * matches what was signed.
 */
router.get('/:id/certificate', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  if (!rental.signature_data) {
    req.session.flash = { type: 'error', message: 'That agreement has not been signed yet.' };
    return res.redirect(`/rentals/${rental.id}`);
  }

  const currency = rental.currency || settings.currency();
  const wording = agreementSnapshot.restore(rental);
  const shots = await licence.summary(rental.id);

  res.render('contracts/certificate', {
    title: `Certificate ${rental.contract_no}`,
    rental,
    company: wording.company,
    trail: esign.auditTrail(rental),
    consents: esign.consentsOf(rental),
    integrity: esign.integrity(rental, { ...wording, currency, licence: await licence.digests(rental.id) }),
    fingerprint: esign.fingerprint(rental.sign_doc_hash),
    shots,
    licenceBase: `/rentals/${rental.id}/licence`,
    ...inCurrency(rental)
  });
});

// Printable handover contract, generated straight from the rental record.
router.get('/:id/contract', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  const q = quoteRental(rental);
  res.render('contracts/handover', {
    layout: false,
    title: `Contract ${rental.contract_no}`,
    rental,
    quote: q,
    policy: rentalPolicy(rental),
    shots: await licence.summary(rental.id),
    licenceBase: `/rentals/${rental.id}/licence`,
    ...agreementSnapshot.restore(rental),
    ...inCurrency(rental)
  });
});

/** The absolute address of the signing page, which email needs. */
/** Where this deployment answers, for links and images sent out by email. */
function origin(req) {
  return mailConfig.baseUrl || `${req.protocol}://${req.get('host')}`;
}

function signUrl(req, token) {
  return `${origin(req)}/sign/${token}`;
}

/**
 * The link, the access code and the deadline are issued together.
 *
 * The code deliberately never travels in the email: a link and a code in the
 * same message prove the same single thing, that someone reached the mailbox.
 * Staff read the code out instead, which puts a second channel between the two.
 */
async function ensureToken(rental) {
  if (rental.sign_token && rental.sign_code && rental.sign_expires_at) return rental.sign_token;
  const token = rental.sign_token || esign.newToken();
  const code = rental.sign_code || esign.newCode();
  const expires = rental.sign_expires_at || esign.expiryFrom(settings.signing().linkDays);
  await db.prepare('UPDATE rentals SET sign_token = ?, sign_code = ?, sign_expires_at = ? WHERE id = ?')
    .run(token, code, expires, rental.id);
  rental.sign_token = token;
  rental.sign_code = code;
  rental.sign_expires_at = expires;
  return token;
}

/** A fresh link, code and deadline — after too many wrong codes, or a lapse. */
router.post('/:id/reissue', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  if (rental.signature_data) {
    req.session.flash = { type: 'error', message: 'That agreement is already signed, so its link cannot be reissued.' };
    return res.redirect(`/rentals/${rental.id}`);
  }

  await db.prepare(
    `UPDATE rentals SET sign_token = ?, sign_code = ?, sign_expires_at = ?, sign_code_tries = 0,
                        sign_code_at = NULL, sign_opened_at = NULL, sign_opened_ip = NULL,
                        sent_at = NULL, sent_to = NULL
     WHERE id = ?`
  ).run(esign.newToken(), esign.newCode(), esign.expiryFrom(settings.signing().linkDays), rental.id);

  req.session.flash = { type: 'success', message: 'New signing link and access code issued. The old link no longer works.' };
  res.redirect(`/rentals/${rental.id}`);
});

router.post('/:id/send', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });

  const token = await ensureToken(rental);
  const url = signUrl(req, token);
  const company = settings.company();

  const code = settings.signing().codeRequired ? rental.sign_code : null;

  if (!mailer.isConfigured()) {
    req.session.flash = {
      type: 'success',
      message: `Signing link ready: ${url} — email is not configured, so send this to the customer yourself.`
        + (code ? ' Read the access code out to them; it is on this page.' : '')
    };
    return res.redirect(`/rentals/${rental.id}`);
  }

  if (!rental.email) {
    req.session.flash = {
      type: 'error',
      message: `${rental.full_name} has no email address on file. Add one, or send the link yourself: ${url}`
    };
    return res.redirect(`/rentals/${rental.id}`);
  }

  const result = await mailer.send({
    to: rental.email,
    subject: `Your rental agreement ${rental.contract_no} — ${company.name}`,
    text: `Dear ${rental.full_name},\n\nYour rental agreement for ${rental.plate} (${rental.make} ${rental.model}) is ready to sign:\n\n${url}\n\nRental period: ${rental.start_date} to ${rental.end_date}.\n${code ? '\nYou will be asked for the six-digit access code we gave you. For your protection it is not in this email' + (company.phone ? `; call ${company.phone} if you do not have it` : '') + '.\n' : ''}\nThis link expires on ${String(rental.sign_expires_at).slice(0, 10)}.\n\n${company.name}${company.phone ? ' · ' + company.phone : ''}`,
    html: `<p><img src="${origin(req)}/img/logo-stack-ink.png" width="176" height="80" alt="${company.name}"></p>
<p>Dear ${rental.full_name},</p>
<p>Your rental agreement for <strong>${rental.plate}</strong> (${rental.make} ${rental.model}) is ready to sign.</p>
<p><a href="${url}" style="display:inline-block;padding:11px 18px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Read and sign the agreement</a></p>
${code ? `<p style="color:#555;font-size:13px">You will be asked for the <strong>six-digit access code</strong> we gave you.
For your protection it is not in this email${company.phone ? ` — call ${company.phone} if you do not have it` : ''}.</p>` : ''}
<p style="color:#555;font-size:13px">Rental period: ${rental.start_date} to ${rental.end_date}.<br>
This link expires on ${String(rental.sign_expires_at).slice(0, 10)}.<br>
If the button does not work, open this link:<br>${url}</p>
<p style="color:#555;font-size:13px">${company.name}${company.phone ? ' · ' + company.phone : ''}</p>`
  });

  if (!result.sent) {
    req.session.flash = { type: 'error', message: `${result.reason} The link is ${url}` };
    return res.redirect(`/rentals/${rental.id}`);
  }

  await db.prepare("UPDATE rentals SET sent_at = datetime('now'), sent_to = ? WHERE id = ?")
    .run(rental.email, rental.id);
  req.session.flash = { type: 'success', message: `Agreement sent to ${rental.email} to sign.` };
  res.redirect(`/rentals/${rental.id}`);
});

router.post('/:id/sign', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  await db.prepare("UPDATE rentals SET handover_signed_at = datetime('now') WHERE id = ? AND handover_signed_at IS NULL")
    .run(rental.id);
  req.session.flash = { type: 'success', message: 'Handover recorded as signed.' };
  res.redirect(`/rentals/${rental.id}`);
});

router.get('/:id/return', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  if (rental.status !== 'active') {
    req.session.flash = { type: 'error', message: 'This rental is already closed.' };
    return res.redirect(`/rentals/${rental.id}`);
  }
  const form = {
    returnDate: today(),
    returnOdometer: rental.pickup_odometer,
    returnFuel: rental.pickup_fuel,
    damageCharge: 0,
    otherCharges: 0,
    returnNotes: ''
  };
  res.render('rentals/return', {
    title: `Return ${rental.contract_no}`,
    rental,
    form,
    errors: [],
    preview: settlement(rental, form, rentalPolicy(rental)),
    policy: rentalPolicy(rental),
    ...inCurrency(rental)
  });
});

router.post('/:id/return', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  if (rental.status !== 'active') {
    req.session.flash = { type: 'error', message: 'This rental is already closed.' };
    return res.redirect(`/rentals/${rental.id}`);
  }

  const form = {
    returnDate: String(req.body.return_date || ''),
    returnOdometer: Number(req.body.return_odometer) || 0,
    returnFuel: Math.max(0, Math.min(8, Number(req.body.return_fuel) || 0)),
    damageCharge: Number(req.body.damage_charge) || 0,
    otherCharges: Number(req.body.other_charges) || 0,
    returnNotes: String(req.body.return_notes || '').trim()
  };

  const errors = [];
  if (!isDate(form.returnDate)) errors.push('Return date is required.');
  else if (form.returnDate < rental.start_date) errors.push('Return date cannot be before the rental started.');
  if (form.returnOdometer < rental.pickup_odometer) {
    errors.push(`Return odometer cannot be lower than the pickup reading (${rental.pickup_odometer} km).`);
  }
  if (form.damageCharge < 0 || form.otherCharges < 0) errors.push('Charges cannot be negative.');

  if (errors.length) {
    return res.status(400).render('rentals/return', {
      title: `Return ${rental.contract_no}`,
      rental,
      form,
      errors,
      preview: settlement(rental, { ...form, returnOdometer: Math.max(form.returnOdometer, rental.pickup_odometer) }, rentalPolicy(rental)),
      policy: rentalPolicy(rental),
      ...inCurrency(rental)
    });
  }

  const s = settlement(rental, form, rentalPolicy(rental));
  await db.tx(async (t) => {
    await t.prepare(
      `UPDATE rentals SET status = 'closed', return_date = ?, return_odometer = ?, return_fuel = ?,
                          damage_charge = ?, other_charges = ?, return_notes = ?, late_fee = ?,
                          excess_km_fee = ?, fuel_fee = ?, base_charge = ?, total_amount = ?,
                          balance_due = ?, closed_at = datetime('now')
       WHERE id = ?`
    ).run(
      form.returnDate, form.returnOdometer, form.returnFuel, s.damageCharge, s.otherCharges,
      form.returnNotes, s.lateFee, s.excessKmFee, s.fuelFee, s.baseCharge, s.total, s.balanceDue,
      rental.id
    );
    await t.prepare("UPDATE cars SET status = 'available', odometer = ?, fuel_level = ? WHERE id = ?")
      .run(form.returnOdometer, form.returnFuel, rental.car_id);
  });

  req.session.flash = { type: 'success', message: `${rental.contract_no} closed. Balance due ${round2(s.balanceDue)} ${rental.currency || settings.currency()}.` };
  res.redirect(`/rentals/${rental.id}/receipt`);
});

// Printable return / settlement sheet.
router.get('/:id/receipt', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  if (rental.status !== 'closed') {
    req.session.flash = { type: 'error', message: 'This rental has not been returned yet.' };
    return res.redirect(`/rentals/${rental.id}`);
  }
  const s = settlement(
    rental,
    {
      returnDate: rental.return_date,
      returnOdometer: rental.return_odometer,
      returnFuel: rental.return_fuel,
      damageCharge: rental.damage_charge,
      otherCharges: rental.other_charges
    },
    rentalPolicy(rental)
  );
  res.render('contracts/receipt', {
    title: `Return ${rental.contract_no}`,
    rental,
    s,
    policy: rentalPolicy(rental),
    company: agreementSnapshot.restore(rental).company,
    ...inCurrency(rental)
  });
});

router.post('/:id/cancel', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  if (rental.status !== 'active') {
    req.session.flash = { type: 'error', message: 'Only active rentals can be cancelled.' };
    return res.redirect(`/rentals/${rental.id}`);
  }
  await db.tx(async (t) => {
    await t.prepare("UPDATE rentals SET status = 'cancelled', closed_at = datetime('now'), total_amount = 0, balance_due = 0 WHERE id = ?")
      .run(rental.id);
    await t.prepare("UPDATE cars SET status = 'available' WHERE id = ?").run(rental.car_id);
  });
  req.session.flash = { type: 'success', message: `${rental.contract_no} cancelled and ${rental.plate} released.` };
  res.redirect('/rentals');
});

module.exports = router;
