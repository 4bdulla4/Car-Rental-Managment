'use strict';
const crypto = require('crypto');
const db = require('../db');

/** Loads the signed-in user onto req.user for every request. */
async function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session && req.session.userId;
  if (userId) {
    const user = await db
      .prepare('SELECT id, email, name, role, active FROM users WHERE id = ?')
      .get(userId);
    if (user && user.active) req.user = user;
    else req.session = null;
  }
  res.locals.currentUser = req.user;
  next();
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

module.exports = { loadUser, requireAuth, requireAdmin, csrf };
