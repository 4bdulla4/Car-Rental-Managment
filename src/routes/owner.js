'use strict';
const express = require('express');
const db = require('../db');
const owner = require('../lib/owner');
const activity = require('../lib/activity');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireOwner);

/**
 * Sign in as another account, to see exactly what they see.
 *
 * It borrows the account rather than copying its permissions onto the owner,
 * so pages and permissions behave exactly as they do for that person. The
 * owner's own identity stays in the session and is stamped on everything done
 * while borrowing — the account's history shows "the owner, as Sara", never
 * simply "Sara".
 */
router.post('/as/:id', async (req, res) => {
  if (req.impersonating) {
    req.session.flash = { type: 'error', message: 'Return to your own account first.' };
    return res.redirect('/');
  }

  const target = await db.prepare('SELECT id, email, name, role, active FROM users WHERE id = ?')
    .get(Number(req.params.id));
  if (!target) {
    req.session.flash = { type: 'error', message: 'That account does not exist.' };
    return res.redirect('/users');
  }
  if (target.id === req.realUser.id || owner.isOwner(target)) {
    req.session.flash = { type: 'error', message: 'That is your own account.' };
    return res.redirect('/users');
  }
  if (!target.active) {
    req.session.flash = { type: 'error', message: `${target.name}'s account is disabled. Enable it first.` };
    return res.redirect('/users');
  }

  await activity.record({
    account: target,
    actor: req.realUser,
    action: 'Owner signed in as this account',
    detail: `${req.realUser.name} opened ${target.name}'s account`,
    path: req.path,
    ip: activity.clientIp(req)
  });

  req.session.ownerId = req.realUser.id;
  req.session.userId = target.id;
  req.session.flash = { type: 'success', message: `You are now signed in as ${target.name}.` };
  res.redirect('/');
});

router.post('/return', async (req, res) => {
  if (!req.impersonating) return res.redirect('/');

  await activity.record({
    account: req.user,
    actor: req.realUser,
    action: 'Owner returned to their own account',
    detail: `${req.realUser.name} left ${req.user.name}'s account`,
    path: req.path,
    ip: activity.clientIp(req)
  });

  const name = req.user.name;
  req.session.userId = req.realUser.id;
  delete req.session.ownerId;
  req.session.flash = { type: 'success', message: `Back in your own account. You were signed in as ${name}.` };
  res.redirect('/users');
});

/** Everything every account did, newest first. */
router.get('/activity', async (req, res) => {
  const userId = Number(req.query.user) || null;
  const before = Number(req.query.before) || null;
  const { rows, more } = await activity.list({ userId, before });
  const users = await db.prepare('SELECT id, name, email, role, active FROM users ORDER BY name').all();

  res.render('owner/activity', {
    title: 'Activity',
    rows,
    more,
    users,
    userId,
    nextBefore: rows.length ? rows[rows.length - 1].id : null
  });
});

module.exports = router;
