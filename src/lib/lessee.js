'use strict';
/**
 * The Lessee as they confirmed themselves when signing.
 *
 * Until signing, a contract shows the customer record as it stands. At the
 * moment of signing those details are frozen onto the contract, the same way
 * its wording and prices already are: the customer record may be edited
 * later — a new phone, a renewed licence — but the agreement must keep
 * naming the person, and the licence, it was signed with.
 */
const FIELDS = [
  'full_name', 'phone', 'email', 'id_number', 'license_number', 'license_expiry',
  'address', 'emergency_name', 'emergency_phone'
];

/** What the customer may fill in or correct on the signing page. Name is not one: it identifies them. */
const EDITABLE = [
  { key: 'phone', label: 'Mobile number', required: true, autocomplete: 'tel', type: 'tel' },
  { key: 'email', label: 'Email', autocomplete: 'email', type: 'email' },
  { key: 'id_number', label: 'National ID or passport number', required: true },
  { key: 'license_number', label: 'Driving licence number', required: true },
  { key: 'license_expiry', label: 'Licence expiry date', required: true, type: 'date' },
  { key: 'address', label: 'Home address', required: true, autocomplete: 'street-address', wide: true },
  { key: 'emergency_name', label: 'Emergency contact name', required: true },
  { key: 'emergency_phone', label: 'Emergency contact number', required: true, type: 'tel' }
];

const capture = (rental) => JSON.stringify(Object.fromEntries(FIELDS.map((k) => [k, rental[k] ?? null])));

/** A rental row with its frozen Lessee laid over the live customer columns. */
function overlay(rental) {
  if (!rental || !rental.lessee_snapshot) return rental;
  try {
    const saved = JSON.parse(rental.lessee_snapshot);
    return { ...rental, ...Object.fromEntries(FIELDS.filter((k) => k in saved).map((k) => [k, saved[k]])) };
  } catch {
    return rental;
  }
}

/**
 * Reads and checks what the customer entered. The licence must still be valid
 * when the car is due back, not merely today.
 */
function readDetails(body, rental) {
  const values = Object.fromEntries(EDITABLE.map((f) => [f.key, String(body[f.key] ?? '').trim().slice(0, 200)]));
  const errors = [];
  for (const f of EDITABLE) {
    if (f.required && !values[f.key]) errors.push(`Please enter your ${f.label.toLowerCase()}.`);
  }
  if (values.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) errors.push('That email address is not valid.');
  if (values.license_expiry) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.license_expiry)) errors.push('Please enter your licence expiry as a date.');
    else if (values.license_expiry < rental.end_date) {
      errors.push(`Your licence must still be valid on ${rental.end_date}, when the car is due back.`);
    }
  }
  if (values.phone && values.phone.replace(/\D/g, '').length < 7) errors.push('That mobile number looks too short.');
  return { values, errors };
}

module.exports = { FIELDS, EDITABLE, capture, overlay, readDetails };
