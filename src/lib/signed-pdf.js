'use strict';
/**
 * The signed agreement's PDF: made once, when the customer signs, and kept.
 *
 * Keeping the file rather than redrawing it on request is deliberate. A file
 * kept is what was handed to the customer, byte for byte, and its own digest
 * proves it; one redrawn later would pick up any change to the layout made
 * since. If making it fails at signing — it must never undo a signature — it
 * is made on first request instead, and kept from then on.
 */
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const agreementSnapshot = require('./agreement');
const licence = require('./licence');
const esign = require('./esign');
const { quoteRental } = require('./pricing');
const { formatMoney } = require('./money');
const { render } = require('./contract-pdf');

const KIND = 'signed_pdf';

async function build(rental) {
  const currency = rental.currency || settings.currency();
  const summary = await licence.summary(rental.id);
  const shots = {};
  for (const [side, kind] of [['front', 'licence_front'], ['back', 'licence_back']]) {
    if (!summary[side]) continue;
    const row = await licence.image(rental.id, kind);
    if (row) {
      shots[side] = {
        mime: row.mime,
        buffer: Buffer.from(row.image, 'base64'),
        digest: summary[side].digest,
        capturedAt: summary[side].captured_at
      };
    }
  }
  return render({
    rental,
    quote: quoteRental(rental),
    policy: {
      fuelChargePerEighth: rental.fuel_charge_per_eighth ?? config.fuelChargePerEighth,
      lateDayMultiplier: rental.late_day_multiplier ?? config.lateDayMultiplier
    },
    wording: agreementSnapshot.restore(rental),
    money: (v) => formatMoney(v, currency),
    shots,
    consents: esign.consentsOf(rental),
    fingerprint: esign.fingerprint(rental.sign_doc_hash),
    issuedAt: rental.handover_signed_at
  });
}

async function store(rentalId, pdf) {
  const base64 = pdf.toString('base64');
  const digest = crypto.createHash('sha256').update(pdf).digest('hex');
  await db.prepare('DELETE FROM contract_documents WHERE rental_id = ? AND kind = ?').run(rentalId, KIND);
  await db.prepare(
    `INSERT INTO contract_documents (rental_id, kind, mime, image, bytes, digest, captured_by)
     VALUES (?,?,?,?,?,?,?)`
  ).run(rentalId, KIND, 'application/pdf', base64, pdf.length, digest, 'system');
  return digest;
}

/** Makes and keeps the PDF for a just-signed rental. Never throws. */
async function createFor(rental) {
  try {
    const pdf = await build(rental);
    await store(rental.id, pdf);
    return pdf;
  } catch (err) {
    console.error('signed PDF could not be made at signing:', err && err.message);
    return null;
  }
}

/** The kept PDF, made now if signing could not make it. Null for an unsigned rental. */
async function fetchFor(rental) {
  if (!rental || !rental.signature_data) return null;
  const row = await db.prepare('SELECT image, digest FROM contract_documents WHERE rental_id = ? AND kind = ?')
    .get(rental.id, KIND);
  if (row) return { pdf: Buffer.from(row.image, 'base64'), digest: row.digest };
  const pdf = await build(rental);
  return { pdf, digest: await store(rental.id, pdf) };
}

const filename = (rental) => `${rental.contract_no}-signed-agreement.pdf`;

module.exports = { build, createFor, fetchFor, filename, KIND };
