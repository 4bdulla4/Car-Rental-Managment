'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  let sql = 'SELECT * FROM customers';
  const params = [];
  if (q) {
    sql += ' WHERE full_name ILIKE ? OR phone ILIKE ? OR id_number ILIKE ? OR license_number ILIKE ?';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY full_name';
  res.render('customers/index', { title: 'Customers', customers: await db.prepare(sql).all(...params), q });
});

router.get('/new', async (req, res) => {
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
  const used = await db.prepare('SELECT COUNT(*) AS n FROM rentals WHERE customer_id = ?').get(id).n;
  if (used > 0) {
    req.session.flash = { type: 'error', message: 'This customer has rental history and cannot be deleted.' };
    return res.redirect('/customers');
  }
  await db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: 'Customer removed.' };
  res.redirect('/customers');
});

module.exports = router;
