'use strict';
/**
 * A record of what every account did, for the owner.
 *
 * Almost every change in this app is a form that ends in a redirect with a
 * one-line flash message — "Contract RC-2026-0041 issued.", "Password reset."
 * — so the redirect is where the record is written: the action is known from
 * the route, the outcome from whether the message is an error, and the detail
 * is that message, already written for a person to read.
 *
 * It is written before the redirect is sent, not after. On a serverless host
 * the process can be frozen the moment a response leaves, and a log written on
 * 'finish' would quietly lose entries.
 */
const db = require('../db');

/** Route patterns → what a person would call the action. First match wins. */
const ACTIONS = [
  [/^\/logout$/, 'Signed out'],
  [/^\/cars$/, 'Added a car'],
  [/^\/cars\/\d+\/delete$/, 'Deleted a car'],
  [/^\/cars\/\d+(\/status)?$/, 'Updated a car'],
  [/^\/customers$/, 'Added a customer'],
  [/^\/customers\/\d+\/delete$/, 'Deleted a customer'],
  [/^\/customers\/\d+$/, 'Updated a customer'],
  [/^\/rentals$/, 'Issued a contract'],
  [/^\/rentals\/\d+\/return$/, 'Checked a car back in'],
  [/^\/rentals\/\d+\/cancel$/, 'Cancelled a contract'],
  [/^\/rentals\/\d+\/send$/, 'Sent a contract for signature'],
  [/^\/rentals\/\d+\/reissue$/, 'Reissued a signing link'],
  [/^\/rentals\/\d+\/sign$/, 'Marked a handover as signed'],
  [/^\/rentals\/\d+\/licence\/[a-z_]+\/delete$/, 'Removed a licence photo'],
  [/^\/rentals\/\d+\/licence$/, 'Attached licence photos'],
  [/^\/users$/, 'Created an account'],
  [/^\/users\/\d+\/role$/, "Changed an account's role"],
  [/^\/users\/\d+\/toggle$/, 'Enabled or disabled an account'],
  [/^\/users\/\d+\/password$/, "Reset an account's password"],
  [/^\/users\/\d+\/delete$/, 'Deleted an account'],
  [/^\/settings\/sample-data\/(load|remove)$/, 'Changed the sample data'],
  [/^\/settings\/data\/[a-z-]+$/, 'Cleared business data'],
  [/^\/settings\/[a-z/-]+$/, 'Changed settings'],
  [/^\/account\/password$/, 'Changed their own password']
];

/** Routes whose effect is not worth a line in anyone's history. */
const QUIET = [/^\/theme$/, /^\/owner\//];

const actionFor = (path) => {
  for (const [pattern, label] of ACTIONS) if (pattern.test(path)) return label;
  return null;
};

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

/** Bearer links are secrets; the log is for reading, not for replaying them. */
const redact = (text) =>
  String(text || '').replace(/\/sign\/[a-f0-9]{16,}/g, '/sign/…').slice(0, 400);

/**
 * Writes one line. `account` is the account the action happened in; `actor` is
 * the person who actually did it — the owner, when signed in as someone else.
 */
async function record({ account, actor, action, detail, path, outcome = 'ok', ip }) {
  try {
    await db.prepare(
      `INSERT INTO activity_log (user_id, user_name, actor_id, actor_name, action, detail, path, outcome, ip)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      account ? account.id : null, account ? account.name : null,
      actor ? actor.id : null, actor ? actor.name : null,
      action, redact(detail) || null, path || null, outcome, ip || null
    );
    // Trim occasionally rather than on every write; a year is plenty to look back on.
    if (Math.random() < 0.02) {
      await db.prepare("DELETE FROM activity_log WHERE at < datetime('now', '-400 days')").run();
    }
  } catch (err) {
    // A failure to log must never become a failure to do the thing being logged.
    console.error('activity log write failed:', err && err.message);
  }
}

/** Convenience for the routes that record something by hand. */
const recordFor = (req, action, extra = {}) =>
  record({
    account: req.user,
    actor: req.realUser || req.user,
    action,
    path: req.originalUrl.split('?')[0],
    ip: clientIp(req),
    ...extra
  });

/**
 * Middleware: every signed-in POST that ends in a redirect is recorded, using
 * the flash message it set as the human-readable detail.
 */
function track(req, res, next) {
  if (req.method !== 'POST' || !req.user) return next();
  const path = req.path;
  if (QUIET.some((q) => q.test(path))) return next();

  const account = req.user;
  const actor = req.realUser || req.user;
  const redirect = res.redirect.bind(res);

  res.redirect = function (...args) {
    const flash = req.session && req.session.flash;
    const action = actionFor(path) || `POST ${path}`;
    record({
      account,
      actor,
      action,
      detail: flash && flash.message,
      path,
      outcome: flash && flash.type === 'error' ? 'refused' : 'ok',
      ip: clientIp(req)
    }).finally(() => redirect(...args));
  };
  next();
}

async function list({ userId, before, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (userId) {
    where.push('(user_id = ? OR actor_id = ?)');
    params.push(userId, userId);
  }
  if (before) {
    where.push('id < ?');
    params.push(before);
  }
  const rows = await db.prepare(
    `SELECT * FROM activity_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT ?`
  ).all(...params, limit + 1);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

module.exports = { ACTIONS, actionFor, redact, record, recordFor, track, list, clientIp };
