'use strict';
const express = require('express');
const db = require('../db');
const { verifyPassword } = require('../lib/passwords');

const router = express.Router();

// Simple in-memory throttle: 8 failed attempts per email locks it out for 10 min.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function isLockedOut(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null, email: '', next: req.query.next || '/' });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = String(req.body.next || '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const fail = (message) =>
    res.status(401).render('login', { title: 'Sign in', error: message, email, next: safeNext });

  if (isLockedOut(email)) {
    return fail('Too many failed attempts. Try again in a few minutes.');
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordFailure(email);
    return fail('Incorrect email or password.');
  }

  attempts.delete(email);
  req.session.userId = user.id;
  res.redirect(safeNext);
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
