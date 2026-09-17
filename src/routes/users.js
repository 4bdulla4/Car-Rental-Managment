'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../lib/passwords');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const LIST_COLUMNS = 'id, email, name, role, active, created_at';

async function page(req, extra = {}) {
  const q = String(req.query.q || '').trim();
  const params = [];
  let sql = `SELECT ${LIST_COLUMNS} FROM users`;
  if (q) {
    sql += ' WHERE name LIKE ? OR email LIKE ?';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY role = 'admin' DESC, name";

  const users = await db.prepare(sql).all(...params);
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
              SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) AS staff,
              SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) AS disabled
       FROM users`
    )
    .get();

  return {
    title: 'Users',
    users,
    q,
    stats: {
      total: Number(totals.total) || 0,
      admins: Number(totals.admins) || 0,
      staff: Number(totals.staff) || 0,
      disabled: Number(totals.disabled) || 0
    },
    errors: [],
    openForm: false,
    form: {},
    ...extra
  };
}

router.get('/', async (req, res) => res.render('users/index', await page(req)));

router.post('/', async (req, res) => {
  const form = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    role: req.body.role === 'admin' ? 'admin' : 'staff'
  };
  const password = String(req.body.password || '');

  const errors = [];
  if (!form.name) errors.push('Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errors.push('A valid email is required.');
  if (password.length < 10) errors.push('Password must be at least 10 characters.');
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(form.email)) {
    errors.push('That email is already registered.');
  }

  if (errors.length) {
    // Keep the form open with what was typed, rather than discarding it.
    return res.status(400).render('users/index', await page(req, { errors, openForm: true, form }));
  }

  await db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
    .run(form.email, form.name, hashPassword(password), form.role);
  req.session.flash = { type: 'success', message: `${form.name} can now sign in.` };
  res.redirect('/users');
});

router.post('/:id/role', async (req, res) => {
  const id = Number(req.params.id);
  const role = req.body.role === 'admin' ? 'admin' : 'staff';

  if (id === req.user.id) {
    req.session.flash = { type: 'error', message: 'You cannot change your own role — ask another admin.' };
    return res.redirect('/users');
  }
  // Losing the last admin would leave nobody able to manage users or settings.
  if (role === 'staff') {
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id <> ?").get(id);
    if (Number(n) === 0) {
      req.session.flash = { type: 'error', message: 'That is the only admin — promote someone else first.' };
      return res.redirect('/users');
    }
  }

  const user = await db.prepare('SELECT name FROM users WHERE id = ?').get(id);
  await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  req.session.flash = { type: 'success', message: `${user ? user.name : 'Account'} is now ${role}.` };
  res.redirect('/users');
});

router.post('/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    req.session.flash = { type: 'error', message: 'You cannot disable your own account.' };
    return res.redirect('/users');
  }

  const user = await db.prepare('SELECT name, role, active FROM users WHERE id = ?').get(id);
  if (user && user.active && user.role === 'admin') {
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(id);
    if (Number(n) === 0) {
      req.session.flash = { type: 'error', message: 'That is the only active admin — promote someone else first.' };
      return res.redirect('/users');
    }
  }

  await db.prepare('UPDATE users SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: `${user ? user.name : 'Account'} ${user && user.active ? 'disabled' : 'enabled'}.` };
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

router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    req.session.flash = { type: 'error', message: 'You cannot delete your own account.' };
    return res.redirect('/users');
  }

  const user = await db.prepare('SELECT name, role, active FROM users WHERE id = ?').get(id);
  if (!user) return res.redirect('/users');

  // Contracts record who issued them, so an account with history is disabled
  // rather than deleted — otherwise the contract loses its author.
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM rentals WHERE created_by = ?').get(id);
  if (Number(n) > 0) {
    req.session.flash = {
      type: 'error',
      message: `${user.name} issued ${n} contract(s), so the account cannot be deleted. Disable it instead.`
    };
    return res.redirect('/users');
  }
  if (user.role === 'admin') {
    const { n: admins } = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id <> ?").get(id);
    if (Number(admins) === 0) {
      req.session.flash = { type: 'error', message: 'That is the only admin — promote someone else first.' };
      return res.redirect('/users');
    }
  }

  await db.prepare('DELETE FROM users WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: `${user.name} deleted.` };
  res.redirect('/users');
});

module.exports = router;
