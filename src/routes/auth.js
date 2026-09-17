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

async function noAccountsYet() {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return Number(n) === 0;
}

router.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', {
    title: 'Sign in',
    error: null,
    email: '',
    next: req.query.next || '/',
    noAccounts: await noAccountsYet()
  });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = String(req.body.next || '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const fail = async (message) =>
    res.status(401).render('login', {
      title: 'Sign in',
      error: message,
      email,
      next: safeNext,
      noAccounts: await noAccountsYet()
    });

  if (isLockedOut(email)) {
    return await fail('Too many failed attempts. Try again in a few minutes.');
  }

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordFailure(email);
    return await fail('Incorrect email or password.');
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
