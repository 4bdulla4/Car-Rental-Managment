'use strict';
/**
 * The driving licence, photographed and kept with the contract it belongs to.
 *
 * A rental agreement turns on the renter holding a valid licence, so the
 * agreement should carry the evidence rather than a tick-box claim about it.
 * Both sides are taken: the front identifies the holder, the back carries the
 * categories and endorsements that say what they may actually drive.
 *
 * The copy belongs to the contract, not to the customer record. A licence
 * renewed or replaced next year does not change what was shown on the day, and
 * a contract must still be able to show what it was signed against.
 */
const crypto = require('crypto');
const db = require('../db');

const KINDS = ['licence_front', 'licence_back'];

const LABELS = {
  licence_front: 'Driving licence — front',
  licence_back: 'Driving licence — back'
};

/** Phone cameras produce several megabytes; the page shrinks before sending. */
const MAX_BYTES = 600 * 1024;
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const isKind = (kind) => KINDS.includes(String(kind));

/** The first bytes of a real JPEG, PNG or WebP. */
function looksLikeImage(head, mime) {
  if (mime === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/**
 * Checks a data URL from the browser and returns what should be stored.
 * Anything that is not a plain image of a sane size is refused outright rather
 * than stored and dealt with later.
 */
function parseUpload(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return { ok: false, reason: 'That is not an image we can accept. Use a photo or a scan.' };

  const [, mime, base64] = match;
  const bytes = Math.floor(base64.length * 3 / 4);
  if (bytes < 2000) return { ok: false, reason: 'That image is too small to read. Take it again, closer.' };
  if (bytes > MAX_BYTES) return { ok: false, reason: 'That image is too large. Take it again, or use a smaller file.' };

  // The label on a data URL is whatever the sender wrote; the first bytes are
  // not. Checking them keeps the store to actual pictures.
  if (!looksLikeImage(Buffer.from(base64.slice(0, 64), 'base64'), mime)) {
    return { ok: false, reason: 'That file is not the kind of image it claims to be.' };
  }

  return {
    ok: true,
    mime,
    base64,
    bytes,
    digest: crypto.createHash('sha256').update(base64, 'utf8').digest('hex')
  };
}

/** One photo per slot: taking it again replaces what was there. */
async function save(rentalId, kind, parsed, { by, ip } = {}) {
  if (!isKind(kind) || !parsed.ok) return false;
  await db.prepare('DELETE FROM contract_documents WHERE rental_id = ? AND kind = ?').run(rentalId, kind);
  await db.prepare(
    `INSERT INTO contract_documents (rental_id, kind, mime, image, bytes, digest, captured_by, captured_ip)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(rentalId, kind, parsed.mime, parsed.base64, parsed.bytes, parsed.digest, by || null, ip || null);
  return true;
}

/** What is on file, without dragging the images themselves into memory. */
async function summary(rentalId) {
  const rows = await db.prepare(
    `SELECT kind, mime, bytes, digest, captured_by, captured_ip, captured_at
     FROM contract_documents WHERE rental_id = ?`
  ).all(rentalId);

  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
  return {
    front: byKind.licence_front || null,
    back: byKind.licence_back || null,
    complete: Boolean(byKind.licence_front && byKind.licence_back)
  };
}

const image = (rentalId, kind) =>
  isKind(kind)
    ? db.prepare('SELECT mime, image FROM contract_documents WHERE rental_id = ? AND kind = ?').get(rentalId, kind)
    : Promise.resolve(null);

const remove = (rentalId, kind) =>
  db.prepare('DELETE FROM contract_documents WHERE rental_id = ? AND kind = ?').run(rentalId, kind);

const removeAll = (rentalId) =>
  db.prepare('DELETE FROM contract_documents WHERE rental_id = ?').run(rentalId);

/**
 * The digests, for the document hash. Binding them to the signature means the
 * copy on file is the copy that was shown: swap the photograph afterwards and
 * the agreement no longer verifies.
 */
async function digests(rentalId) {
  const { front, back } = await summary(rentalId);
  return { front: front ? front.digest : '', back: back ? back.digest : '' };
}

module.exports = { KINDS, LABELS, MAX_BYTES, ALLOWED, isKind, parseUpload, save, summary, image, remove, removeAll, digests };
