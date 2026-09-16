'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../lib/passwords');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  const users = await db.prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY name').all();
  res.render('users/index', { title: 'Users', users, errors: [] });
});

router.post('/', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'staff';

  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('A valid email is required.');
  if (password.length < 10) errors.push('Password must be at least 10 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) errors.push('That email is already registered.');

  if (errors.length) {
    const users = await db.prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY name').all();
    return res.status(400).render('users/index', { title: 'Users', users, errors });
  }

  await db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
    .run(email, name, hashPassword(password), role);
  req.session.flash = { type: 'success', message: `${name} can now sign in.` };
  res.redirect('/users');
});

router.post('/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    req.session.flash = { type: 'error', message: 'You cannot deactivate your own account.' };
    return res.redirect('/users');
  }
  await db.prepare('UPDATE users SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: 'Account updated.' };
  res.redirect('/users');
});

router.post('/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body.password || '');
  if (password.length < 10) {
    req.session.flash = { type: 'error', message: 'Password must be at least 10 characters.' };
    return res.redirect('/users');
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  req.session.flash = { type: 'success', message: 'Password reset.' };
  res.redirect('/users');
});

module.exports = router;
