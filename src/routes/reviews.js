'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
const esign = require('../lib/esign');
const licence = require('../lib/licence');
const review = require('../lib/review');
const mailer = require('../lib/mailer');
const mailConfig = require('../lib/config-mail');
const agreementSnapshot = require('../lib/agreement');
const { findRental } = require('../lib/rental-record');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const VIEWS = {
  pending: { label: 'Waiting for review', where: "r.review_status = 'pending'" },
  approved: { label: 'Approved', where: "r.review_status = 'approved'" },
  rejected: { label: 'Sent back', where: "r.review_status = 'rejected'" }
};

/** Signed agreements to check, oldest waiting first, so nothing sits at the bottom. */
router.get('/', async (req, res) => {
  const view = Object.prototype.hasOwnProperty.call(VIEWS, req.query.view) ? req.query.view : 'pending';
  const [rows, counts] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.contract_no, r.status, r.start_date, r.end_date, r.handover_signed_at, r.signed_name,
              r.reviewed_at, r.reviewed_by_name, r.review_note, r.lessee_before, r.lessee_snapshot,
              c.plate, c.make, c.model, cu.full_name
       FROM rentals r JOIN cars c ON c.id = r.car_id JOIN customers cu ON cu.id = r.customer_id
       WHERE ${VIEWS[view].where} AND r.status <> 'cancelled'
       ORDER BY ${view === 'pending' ? 'r.handover_signed_at ASC' : 'r.reviewed_at DESC'}
       LIMIT 200`
    ).all(),
    db.prepare(
      `SELECT review_status AS s, COUNT(*) AS n FROM rentals
       WHERE review_status IS NOT NULL AND status <> 'cancelled' GROUP BY review_status`
    ).all()
  ]);
  const count = Object.fromEntries(counts.map((c) => [c.s, Number(c.n)]));
  res.render('reviews/index', {
    title: 'Reviews',
    view,
    views: VIEWS,
    count,
    rows: rows.map((r) => ({ ...r, ...review.changeSummary(r) }))
  });
});

/** Everything a reviewer needs on one page. */
router.get('/:id', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  const shots = await licence.summary(rental.id);
  const currency = rental.currency || settings.currency();
  res.render('reviews/show', {
    title: `Review ${rental.contract_no}`,
    rental,
    shots,
    changes: review.changes(rental),
    history: await review.rejections(rental.id),
    consents: esign.consentsOf(rental),
    fingerprint: esign.fingerprint(rental.sign_doc_hash),
    integrity: esign.integrity(rental, { ...agreementSnapshot.restore(rental), currency, licence: licence.digestsOf(shots) })
  });
});

router.post('/:id/approve', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  const shots = await licence.summary(rental.id);
  const integrity = esign.integrity(rental, {
    ...agreementSnapshot.restore(rental), currency: rental.currency || settings.currency(), licence: licence.digestsOf(shots)
  });
  const result = await review.approve(rental, req.user, req.body.note, integrity);
  req.session.flash = result.ok
    ? { type: 'success', message: `${rental.contract_no} approved. The signed agreement is accepted.` }
    : { type: 'error', message: result.reason };
  res.redirect(result.ok ? '/reviews' : `/reviews/${rental.id}`);
});

router.post('/:id/reject', async (req, res) => {
  const rental = await findRental(req.params.id);
  if (!rental) return res.status(404).render('error', { title: 'Not found', message: 'Rental not found.' });
  const result = await review.reject(rental, req.user, req.body.reason);
  if (!result.ok) {
    req.session.flash = { type: 'error', message: result.reason };
    return res.redirect(`/reviews/${rental.id}`);
  }

  // The customer is told why, and where to sign again.
  let told = '';
  const to = rental.sent_to || rental.email;
  if (mailer.isConfigured() && to && rental.sign_token) {
    const base = mailConfig.baseUrl || `${req.protocol}://${req.get('host')}`;
    const url = `${base}/sign/${rental.sign_token}`;
    const company = settings.company();
    const reason = String(req.body.reason).trim();
    const sent = await mailer.send({
      to,
      subject: `Please sign again: rental agreement ${rental.contract_no} — ${company.name}`,
      text: `Dear ${rental.full_name},\n\nWe could not accept your signed agreement ${rental.contract_no}:\n\n${reason}\n\nPlease correct it and sign again here:\n${url}\n\n${company.name}${company.phone ? ' · ' + company.phone : ''}`,
      html: `<p>Dear ${rental.full_name},</p><p>We could not accept your signed agreement <strong>${rental.contract_no}</strong>:</p>
<blockquote style="border-left:3px solid #ccc;margin:0;padding:4px 12px;color:#333">${reason.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</blockquote>
<p><a href="${url}" style="display:inline-block;padding:11px 18px;border-radius:8px;background:#111;color:#fff;text-decoration:none">Correct it and sign again</a></p>
<p style="color:#555;font-size:13px">${company.name}${company.phone ? ' · ' + company.phone : ''}</p>`
    });
    told = sent.sent ? ` ${rental.full_name} has been emailed the reason and the link.` : '';
  }
  req.session.flash = {
    type: 'success',
    message: `${rental.contract_no} sent back for signing again.${told || ' Send the customer the link — it now shows them your reason.'}`
  };
  res.redirect('/reviews');
});

module.exports = router;
