'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const SOON_DAYS = 30;
const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

router.get('/', requireAuth, async (req, res) => {
  const today = day();
  const soon = day(SOON_DAYS);
  const monthStart = today.slice(0, 8) + '01';

  const fleet = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
              SUM(CASE WHEN status = 'rented' THEN 1 ELSE 0 END) AS rented,
              SUM(CASE WHEN status IN ('maintenance','retired') THEN 1 ELSE 0 END) AS off_road
       FROM cars`
    )
    .get();

  const contracts = await db
    .prepare(
      `SELECT SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'active' AND end_date < ? THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN status = 'active' AND end_date = ? THEN 1 ELSE 0 END) AS due_today
       FROM rentals`
    )
    .get(today, today);

  const customers = await db.prepare('SELECT COUNT(*) AS n FROM customers').get();

  // Revenue is grouped by currency, because totals in different currencies
  // must never be added together.
  const revenueMonth = await db
    .prepare(
      `SELECT currency, SUM(total_amount) AS total FROM rentals
       WHERE status = 'closed' AND closed_at >= ? GROUP BY currency ORDER BY total DESC`
    )
    .all(monthStart);
  const revenueAll = await db
    .prepare(
      `SELECT currency, SUM(total_amount) AS total FROM rentals
       WHERE status = 'closed' GROUP BY currency ORDER BY total DESC`
    )
    .all();

  // The day's work: everything still out, soonest due first.
  const open = await db
    .prepare(
      `SELECT r.id, r.contract_no, r.end_date, r.total_amount, r.currency,
              c.plate, c.make, c.model, cu.full_name, cu.phone
       FROM rentals r
       JOIN cars c ON c.id = r.car_id
       JOIN customers cu ON cu.id = r.customer_id
       WHERE r.status = 'active'
       ORDER BY r.end_date
       LIMIT 8`
    )
    .all();

  const closed = await db
    .prepare(
      `SELECT r.id, r.contract_no, r.return_date, r.total_amount, r.balance_due, r.currency,
              c.plate, cu.full_name
       FROM rentals r
       JOIN cars c ON c.id = r.car_id
       JOIN customers cu ON cu.id = r.customer_id
       WHERE r.status = 'closed'
       ORDER BY r.closed_at DESC
       LIMIT 5`
    )
    .all();

  // Licences worth chasing before they block a booking.
  const licences = await db
    .prepare(
      `SELECT id, full_name, phone, license_number, license_expiry
       FROM customers
       WHERE license_expiry <> '' AND license_expiry IS NOT NULL AND license_expiry <= ?
       ORDER BY license_expiry
       LIMIT 5`
    )
    .all(soon);

  res.render('dashboard', {
    title: 'Dashboard',
    today,
    stats: {
      cars: Number(fleet.total) || 0,
      available: Number(fleet.available) || 0,
      rented: Number(fleet.rented) || 0,
      offRoad: Number(fleet.off_road) || 0,
      active: Number(contracts.active) || 0,
      overdue: Number(contracts.overdue) || 0,
      dueToday: Number(contracts.due_today) || 0,
      customers: Number(customers.n) || 0
    },
    revenueMonth,
    revenueAll,
    open,
    closed,
    licences
  });
});

module.exports = router;
