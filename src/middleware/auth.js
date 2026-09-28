'use strict';
const crypto = require('crypto');
const db = require('../db');
const owner = require('../lib/owner');

const findUser = (id) =>
  db.prepare('SELECT id, email, name, role, active FROM users WHERE id = ?').get(id);

/**
 * Loads the signed-in user onto req.user for every request.
 *
 * When the owner is signed in as someone else, req.user is the account being
 * used — so every page and permission behaves exactly as it does for that
 * person — and req.realUser is the owner, so that nothing done in their name is
 * ever recorded as if they had done it themselves. The owner is re-checked on
 * every request: if the account stops being the owner, the borrowed session
 * ends there and then.
 */
async function resolveUser(req, res) {
  req.user = null;
  req.realUser = null;
  req.impersonating = false;

  // Signing someone out means forgetting who they are, not discarding the
  // session object: everything after this reads req.session, and a null one
  // turned a disabled account's next click into a 500 instead of the sign-in page.
  const signOut = () => {
    delete req.session.userId;
    delete req.session.ownerId;
  };

  // Both accounts are looked up at once: each lookup is a round trip to the
  // database, and neither depends on the other.
  const userId = req.session && req.session.userId;
  const ownerId = req.session && req.session.ownerId;
  const [user, real] = await Promise.all([
    userId ? findUser(userId) : null,
    userId && ownerId ? findUser(ownerId) : null
  ]);
  if (userId) {
    if (user && user.active) req.user = user;
    else signOut();
  }

  if (req.user && ownerId) {
    if (real && owner.isOwner(real) && real.id !== req.user.id) {
      req.realUser = real;
      req.impersonating = true;
    } else {
      // No longer the owner, or no longer anyone: drop the borrowed session.
      signOut();
      req.user = null;
    }
  }
  if (req.user && !req.realUser) req.realUser = req.user;

  res.locals.currentUser = req.user;
  res.locals.realUser = req.realUser;
  res.locals.impersonating = req.impersonating;
  res.locals.isOwner = owner.isOwner(req.realUser);
}

async function loadUser(req, res, next) {
  await resolveUser(req, res);
  next();
}

/** The owner, signed in as themselves or as anyone else. */
function requireOwner(req, res, next) {
  if (req.realUser && owner.isOwner(req.realUser)) return next();
  return res.status(403).render('error', { title: 'Forbidden', message: 'Only the owner can open this page.' });
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  const target = req.method === 'GET' ? req.originalUrl : '/';
  return res.redirect('/login?next=' + encodeURIComponent(target));
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access is required for this page.' });
}

/** Minimal synchroniser-token CSRF protection for all state-changing requests. */
function csrf(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const supplied = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const expected = String(req.session.csrfToken);
  const ok =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!ok) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Your session expired. Please go back and try again.' });
  }
  return next();
}

module.exports = { loadUser, resolveUser, requireAuth, requireAdmin, requireOwner, csrf };
