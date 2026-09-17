'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const SOON_DAYS = 30;

function readCustomerForm(body) {
  return {
    full_name: String(body.full_name || '').trim(),
    phone: String(body.phone || '').trim(),
    email: String(body.email || '').trim(),
    id_number: String(body.id_number || '').trim(),
    license_number: String(body.license_number || '').trim(),
    license_expiry: String(body.license_expiry || '').trim(),
    address: String(body.address || '').trim(),
    notes: String(body.notes || '').trim()
  };
}

function validate(c) {
  const errors = [];
  if (!c.full_name) errors.push('Full name is required.');
  if (!c.phone) errors.push('Phone number is required.');
  if (!c.license_number) errors.push('Driving licence number is required.');
  if (c.license_expiry && !/^\d{4}-\d{2}-\d{2}$/.test(c.license_expiry)) {
    errors.push('Licence expiry must be a valid date.');
  }
  return errors;
}

/** Each customer with their rental counts and licence standing. */
async function listCustomers(q, filter) {
  const now = today();
  const soon = inDays(SOON_DAYS);
  const params = [];
  let sql = `
    SELECT c.*,
           (SELECT COUNT(*) FROM rentals r WHERE r.customer_id = c.id) AS rentals_count,
           (SELECT COUNT(*) FROM rentals r WHERE r.customer_id = c.id AND r.status = 'active') AS active_count
    FROM customers c
    WHERE 1 = 1`;

  if (q) {
    sql += ' AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.id_number LIKE ? OR c.license_number LIKE ? OR c.email LIKE ?)';
    for (let i = 0; i < 5; i += 1) params.push(`%${q}%`);
  }
  if (filter === 'expired') {
    sql += " AND c.license_expiry <> '' AND c.license_expiry IS NOT NULL AND c.license_expiry < ?";
    params.push(now);
  } else if (filter === 'expiring') {
    sql += " AND c.license_expiry <> '' AND c.license_expiry IS NOT NULL AND c.license_expiry >= ? AND c.license_expiry <= ?";
    params.push(now, soon);
  } else if (filter === 'renting') {
    sql += ' AND active_count > 0';
  }
  sql += ' ORDER BY c.full_name';

  const rows = await db.prepare(sql).all(...params);
  return rows.map((c) => ({
    ...c,
    rentals_count: Number(c.rentals_count) || 0,
    active_count: Number(c.active_count) || 0,
    licence: !c.license_expiry ? 'unknown' : c.license_expiry < now ? 'expired' : c.license_expiry <= soon ? 'expiring' : 'valid'
  }));
}

async function stats() {
  const now = today();
  const soon = inDays(SOON_DAYS);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN license_expiry <> '' AND license_expiry IS NOT NULL AND license_expiry < ? THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN license_expiry <> '' AND license_expiry IS NOT NULL AND license_expiry >= ? AND license_expiry <= ? THEN 1 ELSE 0 END) AS expiring
       FROM customers`
    )
    .get(now, now, soon);
  const renting = await db
    .prepare("SELECT COUNT(DISTINCT customer_id) AS n FROM rentals WHERE status = 'active'")
    .get();
  return {
    total: Number(row.total) || 0,
    expired: Number(row.expired) || 0,
    expiring: Number(row.expiring) || 0,
    renting: Number(renting.n) || 0
  };
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = ['expired', 'expiring', 'renting'].includes(req.query.filter) ? req.query.filter : '';
  res.render('customers/index', {
    title: 'Customers',
    customers: await listCustomers(q, filter),
    stats: await stats(),
    q,
    filter,
    soonDays: SOON_DAYS
  });
});

router.get('/new', (req, res) => {
  res.render('customers/form', { title: 'Add customer', customer: {}, errors: [], action: '/customers' });
});

router.post('/', async (req, res) => {
  const customer = readCustomerForm(req.body);
  const errors = validate(customer);
  if (errors.length) {
    return res.status(400).render('customers/form', { title: 'Add customer', customer, errors, action: '/customers' });
  }
  const info = await db.prepare(
    `INSERT INTO customers (full_name, phone, email, id_number, license_number, license_expiry, address, notes)
     VALUES (?,?,?,?,?,?,?,?) RETURNING id`
  ).run(
    customer.full_name, customer.phone, customer.email, customer.id_number,
    customer.license_number, customer.license_expiry, customer.address, customer.notes
  );
  req.session.flash = { type: 'success', message: `${customer.full_name} added.` };
  res.redirect(req.body.then_rent ? `/rentals/new?customer_id=${info.lastInsertRowid}` : '/customers');
});

router.get('/:id/edit', async (req, res) => {
  const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
  if (!customer) return res.status(404).render('error', { title: 'Not found', message: 'Customer not found.' });
  res.render('customers/form', { title: `Edit ${customer.full_name}`, customer, errors: [], action: `/customers/${customer.id}` });
});

router.post('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const customer = readCustomerForm(req.body);
  const errors = validate(customer);
  if (errors.length) {
    return res.status(400).render('customers/form', { title: 'Edit customer', customer: { ...customer, id }, errors, action: `/customers/${id}` });
  }
  await db.prepare(
    `UPDATE customers SET full_name=?, phone=?, email=?, id_number=?, license_number=?,
                          license_expiry=?, address=?, notes=? WHERE id = ?`
  ).run(
    customer.full_name, customer.phone, customer.email, customer.id_number,
    customer.license_number, customer.license_expiry, customer.address, customer.notes, id
  );
  req.session.flash = { type: 'success', message: 'Customer updated.' };
  res.redirect('/customers');
});

router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM rentals WHERE customer_id = ?').get(id);
  if (Number(n) > 0) {
    req.session.flash = {
      type: 'error',
      message: `This customer has ${n} contract(s) on file, so the record cannot be deleted.`
    };
    return res.redirect('/customers');
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: 'Customer removed.' };
  res.redirect('/customers');
});

module.exports = router;
