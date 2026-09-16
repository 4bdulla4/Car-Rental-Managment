'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const settings = require('../lib/settings');

const router = express.Router();
router.use(requireAuth);

const CAR_STATUSES = ['available', 'rented', 'maintenance', 'retired'];

function readCarForm(body) {
  return {
    plate: String(body.plate || '').trim().toUpperCase(),
    make: String(body.make || '').trim(),
    model: String(body.model || '').trim(),
    year: Number(body.year) || null,
    color: String(body.color || '').trim(),
    vin: String(body.vin || '').trim(),
    transmission: body.transmission === 'manual' ? 'manual' : 'automatic',
    seats: Number(body.seats) || 5,
    daily_rate: Number(body.daily_rate) || 0,
    km_allowance_per_day: Number(body.km_allowance_per_day) || 0,
    excess_km_rate: Number(body.excess_km_rate) || 0,
    odometer: Number(body.odometer) || 0,
    fuel_level: Math.max(0, Math.min(8, Number(body.fuel_level) || 0)),
    status: CAR_STATUSES.includes(body.status) ? body.status : 'available',
    notes: String(body.notes || '').trim()
  };
}

function validate(car) {
  const errors = [];
  if (!car.plate) errors.push('Plate number is required.');
  if (!car.make) errors.push('Make is required.');
  if (!car.model) errors.push('Model is required.');
  if (car.daily_rate <= 0) errors.push('Daily rate must be greater than zero.');
  return errors;
}

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = CAR_STATUSES.includes(req.query.status) ? req.query.status : '';
  const params = [];
  let sql = 'SELECT * FROM cars WHERE 1 = 1';
  if (q) {
    sql += ' AND (plate LIKE ? OR make LIKE ? OR model LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY plate';
  res.render('cars/index', {
    title: 'Fleet',
    cars: await db.prepare(sql).all(...params),
    q,
    status,
    statuses: CAR_STATUSES
  });
});

router.get('/new', async (req, res) => {
  const defaults = settings.mileage();
  res.render('cars/form', {
    title: 'Add car',
    car: {
      transmission: 'automatic',
      seats: 5,
      fuel_level: 8,
      status: 'available',
      daily_rate: settings.dailyRate() || '',
      km_allowance_per_day: defaults.kmAllowancePerDay,
      excess_km_rate: defaults.excessKmRate
    },
    errors: [],
    statuses: CAR_STATUSES,
    action: '/cars'
  });
});

router.post('/', async (req, res) => {
  const car = readCarForm(req.body);
  const errors = validate(car);
  if (await db.prepare('SELECT 1 FROM cars WHERE plate = ?').get(car.plate)) {
    errors.push('A car with that plate already exists.');
  }
  if (errors.length) {
    return res.status(400).render('cars/form', { title: 'Add car', car, errors, statuses: CAR_STATUSES, action: '/cars' });
  }
  await db.prepare(
    `INSERT INTO cars (plate, make, model, year, color, vin, transmission, seats, daily_rate,
                       km_allowance_per_day, excess_km_rate, odometer, fuel_level, status, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    car.plate, car.make, car.model, car.year, car.color, car.vin, car.transmission, car.seats,
    car.daily_rate, car.km_allowance_per_day, car.excess_km_rate, car.odometer, car.fuel_level,
    car.status, car.notes
  );
  req.session.flash = { type: 'success', message: `${car.plate} added to the fleet.` };
  res.redirect('/cars');
});

router.get('/:id/edit', async (req, res) => {
  const car = await db.prepare('SELECT * FROM cars WHERE id = ?').get(Number(req.params.id));
  if (!car) return res.status(404).render('error', { title: 'Not found', message: 'Car not found.' });
  res.render('cars/form', { title: `Edit ${car.plate}`, car, errors: [], statuses: CAR_STATUSES, action: `/cars/${car.id}` });
});

router.post('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM cars WHERE id = ?').get(id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', message: 'Car not found.' });

  const car = readCarForm(req.body);
  const errors = validate(car);
  const clash = await db.prepare('SELECT 1 FROM cars WHERE plate = ? AND id <> ?').get(car.plate, id);
  if (clash) errors.push('Another car already uses that plate.');
  if (existing.status === 'rented' && car.status !== 'rented') {
    errors.push('This car is on an active rental — close the rental before changing its status.');
  }
  if (errors.length) {
    return res.status(400).render('cars/form', { title: `Edit ${existing.plate}`, car: { ...car, id }, errors, statuses: CAR_STATUSES, action: `/cars/${id}` });
  }

  await db.prepare(
    `UPDATE cars SET plate=?, make=?, model=?, year=?, color=?, vin=?, transmission=?, seats=?,
                     daily_rate=?, km_allowance_per_day=?, excess_km_rate=?, odometer=?, fuel_level=?,
                     status=?, notes=?
     WHERE id = ?`
  ).run(
    car.plate, car.make, car.model, car.year, car.color, car.vin, car.transmission, car.seats,
    car.daily_rate, car.km_allowance_per_day, car.excess_km_rate, car.odometer, car.fuel_level,
    car.status, car.notes, id
  );
  req.session.flash = { type: 'success', message: `${car.plate} updated.` };
  res.redirect('/cars');
});

router.post('/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const used = await db.prepare('SELECT COUNT(*) AS n FROM rentals WHERE car_id = ?').get(id).n;
  if (used > 0) {
    req.session.flash = { type: 'error', message: 'This car has rental history and cannot be deleted. Set it to "retired" instead.' };
    return res.redirect('/cars');
  }
  await db.prepare('DELETE FROM cars WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: 'Car removed.' };
  res.redirect('/cars');
});

module.exports = router;
