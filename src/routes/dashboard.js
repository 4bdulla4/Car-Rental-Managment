'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const fleet = db
    .prepare('SELECT status, COUNT(*) AS n FROM cars GROUP BY status')
    .all()
    .reduce((acc, row) => ({ ...acc, [row.status]: row.n }), {});

  const stats = {
    cars: db.prepare('SELECT COUNT(*) AS n FROM cars').get().n,
    available: fleet.available || 0,
    rented: fleet.rented || 0,
    maintenance: fleet.maintenance || 0,
    customers: db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,
    activeRentals: db.prepare("SELECT COUNT(*) AS n FROM rentals WHERE status = 'active'").get().n,
    overdue: db
      .prepare("SELECT COUNT(*) AS n FROM rentals WHERE status = 'active' AND end_date < ?")
      .get(today).n,
    // Grouped, because totals in different currencies must never be added together.
    revenue: db
      .prepare(
        `SELECT currency, SUM(total_amount) AS total FROM rentals
         WHERE status = 'closed' GROUP BY currency ORDER BY total DESC`
      )
      .all()
  };

  const active = db
    .prepare(
      `SELECT r.*, c.plate, c.make, c.model, cu.full_name, cu.phone
       FROM rentals r
       JOIN cars c ON c.id = r.car_id
       JOIN customers cu ON cu.id = r.customer_id
       WHERE r.status = 'active'
       ORDER BY r.end_date ASC
       LIMIT 10`
    )
    .all();

  res.render('dashboard', { title: 'Dashboard', stats, active, today });
});

module.exports = router;
