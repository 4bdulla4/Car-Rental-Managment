'use strict';
/**
 * What turns a drawing into evidence.
 *
 * A signature on its own proves very little. What makes an electronically
 * signed agreement hold up is the record around it: that the signer was sent
 * the link, that they opened it, that they were told exactly what they were
 * agreeing to, that they said so deliberately, and that the document has not
 * changed since. This module produces and checks that record.
 *
 * It is a simple electronic signature with an audit trail — the kind recognised
 * by the Saudi Electronic Transactions Law, the EU's eIDAS "simple" tier and the
 * US ESIGN Act. It is not a certificate-based (qualified) signature, and nothing
 * here should be described to a customer as one.
 */
const crypto = require('crypto');

/**
 * Each confirmation is a separate, unticked statement. One combined tick is
 * weaker evidence: it cannot show which part the signer actually turned their
 * mind to. The exact wording shown is stored with the signature, so a
 * certificate printed years later quotes what was on screen that day, even if
 * this list is reworded in the meantime.
 */
const CONSENTS = [
  {
    id: 'electronic',
    text: 'I agree to sign this agreement electronically, and I accept that my electronic signature is as binding on me as a signature in ink.'
  },
  {
    id: 'read',
    text: 'I have read the whole agreement above, including its terms and conditions, and I accept them.'
  },
  {
    id: 'identity',
    text: 'I am the Lessee named in this agreement, and the personal, licence and vehicle details shown in it are correct.'
  },
  {
    id: 'licence',
    text: 'I hold a valid driving licence that covers this vehicle for the whole of the rental period.'
  }
];

const TOKEN_BYTES = 24;

const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

/** A six-digit code, given to the customer by the branch rather than by email. */
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** The timestamp format the database writes with datetime('now'). */
function stamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function expiryFrom(days, from = new Date()) {
  const d = new Date(from.getTime() + Math.max(1, Number(days) || 14) * 86400000);
  return stamp(d);
}

const isExpired = (rental, now = new Date()) =>
  Boolean(rental.sign_expires_at) && String(rental.sign_expires_at) < stamp(now);

/** Compared in constant time, so a wrong value leaks nothing by timing. */
function sameSecret(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/**
 * Every term the signature is given for, in a fixed order, as one string.
 *
 * Hashing this binds the signature to these exact terms: change the rate, the
 * dates, the car or a clause afterwards and the hash recorded at signing no
 * longer matches, which is precisely what an argument about "that is not what I
 * signed" needs to be able to settle.
 */
function canonical(rental, { terms, agreement, company, currency }) {
  const v = (x) => (x === null || x === undefined ? '' : String(x));
  return [
    'contract=' + v(rental.contract_no),
    'lessor=' + [company.name, company.regNo, company.vatNo, company.address, company.phone, company.email].map(v).join('|'),
    'lessee=' + [rental.full_name, rental.id_number, rental.license_number, rental.license_expiry, rental.phone, rental.email, rental.address].map(v).join('|'),
    'vehicle=' + [rental.plate, rental.make, rental.model, rental.year, rental.color, rental.vin].map(v).join('|'),
    'period=' + [rental.start_date, rental.start_time, rental.end_date, rental.end_time, rental.return_location].map(v).join('|'),
    'money=' + [currency, rental.daily_rate, rental.base_charge, rental.deposit, rental.discount, rental.total_amount].map(v).join('|'),
    'mileage=' + [rental.km_allowance_per_day, rental.excess_km_rate].map(v).join('|'),
    'charges=' + [rental.fuel_charge_per_eighth, rental.late_day_multiplier, rental.deductible].map(v).join('|'),
    'handover=' + [rental.pickup_odometer, rental.pickup_fuel, rental.pickup_notes].map(v).join('|'),
    'law=' + v(agreement && agreement.governingLaw),
    'terms=' + (terms || []).map(v).join(' ~ ')
  ].join('\n');
}

const documentHash = (rental, parts) =>
  crypto.createHash('sha256').update(canonical(rental, parts), 'utf8').digest('hex');

/** The first block of the hash: short enough to read out, long enough to match on. */
const fingerprint = (hash) => String(hash || '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ').toUpperCase();

/**
 * Does the agreement still say what it said when it was signed?
 * `unknown` covers contracts signed before hashes were recorded — absence of a
 * hash is not evidence of tampering, and must not be reported as if it were.
 */
function integrity(rental, parts) {
  if (!rental.signature_data) return { state: 'unsigned' };
  if (!rental.sign_doc_hash) return { state: 'unknown' };
  const now = documentHash(rental, parts);
  return {
    state: now === rental.sign_doc_hash ? 'intact' : 'altered',
    signed: rental.sign_doc_hash,
    current: now
  };
}

/** The record of what happened, oldest first, for the certificate. */
function auditTrail(rental) {
  const events = [];
  if (rental.created_at) {
    events.push({ at: rental.created_at, what: 'Agreement drawn up', detail: rental.issued_by ? `by ${rental.issued_by}` : '' });
  }
  if (rental.sent_at) {
    events.push({ at: rental.sent_at, what: 'Signing link emailed', detail: rental.sent_to || '' });
  }
  if (rental.sign_opened_at) {
    events.push({ at: rental.sign_opened_at, what: 'Link opened by the signer', detail: rental.sign_opened_ip || '' });
  }
  if (rental.sign_code_at) {
    events.push({ at: rental.sign_code_at, what: 'Access code entered correctly', detail: 'Code issued separately by the branch' });
  }
  if (rental.handover_signed_at) {
    events.push({
      at: rental.handover_signed_at,
      what: 'Signed',
      detail: [rental.signed_name, rental.signed_ip].filter(Boolean).join(' · ')
    });
  }
  if (rental.signed_copy_at) {
    events.push({ at: rental.signed_copy_at, what: 'Signed copy emailed to the signer', detail: rental.signed_email || '' });
  }
  return events;
}

/** What the signer ticked, as it was worded on the day. */
function consentsOf(rental) {
  try {
    const stored = JSON.parse(rental.sign_consents || '[]');
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // A malformed record should not take the certificate down with it.
  }
  return [];
}

module.exports = {
  CONSENTS,
  newToken,
  newCode,
  stamp,
  expiryFrom,
  isExpired,
  sameSecret,
  canonical,
  documentHash,
  fingerprint,
  integrity,
  auditTrail,
  consentsOf
};
