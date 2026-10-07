'use strict';
/**
 * A signed agreement is checked by the business before it is accepted.
 *
 * Signing online means the customer, not staff, entered the details and took
 * the licence photographs. Review is where someone on the team looks at what
 * came back — the signed PDF, the licence, any details the customer changed —
 * and approves it, or turns it back with a reason for the customer to fix.
 *
 * A rejected signature is not deleted. It is archived with its PDF and the
 * reason, because "signed, then turned back on this date for this reason" is
 * part of the contract's history; then the agreement is reopened for signing.
 */
const db = require('../db');
const esign = require('./esign');
const settings = require('./settings');
const lessee = require('./lessee');
const signedPdf = require('./signed-pdf');

const STATUSES = ['pending', 'approved', 'rejected'];

/** The customer-entered fields that differ from what was on file before signing. */
function changes(rental) {
  if (!rental.lessee_before || !rental.lessee_snapshot) return [];
  let before;
  let after;
  try {
    before = JSON.parse(rental.lessee_before);
    after = JSON.parse(rental.lessee_snapshot);
  } catch {
    return [];
  }
  // A field filled in where there was nothing is "added"; one that replaced
  // something on file is "changed" — the corrections are what a reviewer
  // most needs to see, and they should not be lost among the additions.
  return lessee.EDITABLE
    .filter((f) => String(before[f.key] ?? '').trim() !== String(after[f.key] ?? '').trim())
    .map((f) => ({
      key: f.key,
      label: f.label,
      before: before[f.key] || '',
      after: after[f.key] || '',
      kind: String(before[f.key] ?? '').trim() ? 'changed' : 'added'
    }));
}

/** "1 changed · 5 added", for the queue. */
function changeSummary(rental) {
  const all = changes(rental);
  return {
    changed: all.filter((c) => c.kind === 'changed').length,
    added: all.filter((c) => c.kind === 'added').length
  };
}

async function pendingCount() {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM rentals WHERE review_status = 'pending' AND signature_data IS NOT NULL AND status <> 'cancelled'"
  ).get();
  return Number(row.n) || 0;
}

/**
 * Approves a signed agreement. Refused if it is no longer the agreement that
 * was signed: approving an altered document would approve something nobody
 * signed.
 */
async function approve(rental, user, note, integrity) {
  if (!rental.signature_data) return { ok: false, reason: 'That agreement has not been signed.' };
  if (rental.review_status !== 'pending') return { ok: false, reason: 'That agreement is not waiting for review.' };
  if (integrity && integrity.state === 'altered') {
    return { ok: false, reason: 'The agreement has changed since it was signed, so it cannot be approved. Reject it, and have it signed again.' };
  }
  const res = await db.prepare(
    `UPDATE rentals SET review_status = 'approved', reviewed_at = ?, reviewed_by = ?, reviewed_by_name = ?, review_note = ?
     WHERE id = ? AND review_status = 'pending'`
  ).run(esign.stamp(), user.id, user.name, String(note || '').trim().slice(0, 500) || null, rental.id);
  return Number(res.changes) === 1 ? { ok: true } : { ok: false, reason: 'Someone else reviewed it first.' };
}

/**
 * Turns a signature back. The attempt is archived with its PDF, the signature
 * is cleared, and the link is reopened — with a fresh deadline — so the
 * customer can correct it and sign again.
 */
async function reject(rental, user, reason) {
  const why = String(reason || '').trim().slice(0, 500);
  if (!why) return { ok: false, reason: 'Say why it is being rejected — the customer is shown this.' };
  if (!rental.signature_data) return { ok: false, reason: 'That agreement has not been signed.' };
  if (rental.review_status !== 'pending') return { ok: false, reason: 'That agreement is not waiting for review.' };
  if (rental.status !== 'active') return { ok: false, reason: 'Only an open contract can be sent back for signing.' };

  let pdf = null;
  try {
    const kept = await signedPdf.fetchFor(rental);
    pdf = kept ? kept.pdf.toString('base64') : null;
  } catch {
    // The PDF is evidence worth keeping, but not worth blocking a rejection over.
  }

  let done = false;
  await db.tx(async (t) => {
    const cleared = await t.prepare(
      `UPDATE rentals SET signature_data = NULL, signed_name = NULL, signed_ip = NULL, signed_user_agent = NULL,
                          signed_email = NULL, sign_doc_hash = NULL, sign_consents = NULL, handover_signed_at = NULL,
                          signed_copy_at = NULL, lessee_snapshot = NULL,
                          review_status = 'rejected', reviewed_at = ?, reviewed_by = ?, reviewed_by_name = ?,
                          review_note = ?, sign_expires_at = ?
       WHERE id = ? AND review_status = 'pending' AND signature_data IS NOT NULL`
    ).run(esign.stamp(), user.id, user.name, why, esign.expiryFrom(settings.signing().linkDays), rental.id);
    if (Number(cleared.changes) !== 1) return;
    await t.prepare(
      `INSERT INTO signing_rejections (rental_id, rejected_by, rejected_by_name, reason, signed_name, signed_at,
                                       signed_ip, doc_hash, signature_data, lessee_snapshot, pdf)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(rental.id, user.id, user.name, why, rental.signed_name, rental.handover_signed_at, rental.signed_ip,
      rental.sign_doc_hash, rental.signature_data, rental.lessee_snapshot, pdf);
    await t.prepare("DELETE FROM contract_documents WHERE rental_id = ? AND kind = 'signed_pdf'").run(rental.id);
    done = true;
  });
  return done ? { ok: true } : { ok: false, reason: 'Someone else reviewed it first.' };
}

const rejections = (rentalId) =>
  db.prepare(
    `SELECT id, rejected_at, rejected_by_name, reason, signed_name, signed_at, doc_hash
     FROM signing_rejections WHERE rental_id = ? ORDER BY id DESC`
  ).all(rentalId);

module.exports = { STATUSES, changes, changeSummary, pendingCount, approve, reject, rejections };
