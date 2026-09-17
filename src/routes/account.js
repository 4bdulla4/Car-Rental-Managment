'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hashPassword, verifyPassword } = require('../lib/passwords');

const router = express.Router();
router.use(requireAuth);

const MIN_LENGTH = 10;

router.get('/', (req, res) => {
  res.render('account', { title: 'My account', errors: [] });
});

router.post('/password', async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');
  const errors = [];

  // The current password is required so that a borrowed session cannot be used
  // to lock the real owner out of their own account.
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !verifyPassword(current, user.password_hash)) {
    errors.push('Your current password is not correct.');
  }
  if (next.length < MIN_LENGTH) {
    errors.push(`Your new password must be at least ${MIN_LENGTH} characters.`);
  }
  if (next !== confirm) {
    errors.push('The new password and its confirmation do not match.');
  }
  if (next && current && next === current) {
    errors.push('Your new password must be different from the current one.');
  }

  if (errors.length) {
    return res.status(400).render('account', { title: 'My account', errors });
  }

  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(next), req.user.id);

  req.session.flash = { type: 'success', message: 'Your password has been changed.' };
  res.redirect('/account');
});

module.exports = router;
