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
  if (car.odometer < 0) errors.push('Odometer reading cannot be negative.');
  if (car.km_allowance_per_day < 0) errors.push('Kilometre allowance cannot be negative.');
  if (car.excess_km_rate < 0) errors.push('Excess kilometre rate cannot be negative.');
  const nextYear = new Date().getFullYear() + 1;
  if (car.year !== null && (car.year < 1950 || car.year > nextYear)) errors.push(`Year must be between 1950 and ${nextYear}.`);
  if (car.seats < 1 || car.seats > 60) errors.push('Seats must be between 1 and 60.');
  return errors;
}

/**
 * The statuses a person may choose. "Rented" is not one of them: it means a
 * contract has the car, and only issuing one should say so. A car marked
 * rented by hand could not be rented — it was not available — and could not
 * be changed back either, because it looked as if it were out on a contract.
 */
const CHOOSABLE = CAR_STATUSES.filter((st) => st !== 'rented');

const activeContract = (carId) =>
  db.prepare("SELECT contract_no FROM rentals WHERE car_id = ? AND status = 'active' LIMIT 1").get(carId);

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = CAR_STATUSES.includes(req.query.status) ? req.query.status : '';

  const params = [];
  // Each car carries its rental history and, while out, the contract it is on.
  let sql = `
    SELECT c.*,
           (SELECT COUNT(*) FROM rentals r WHERE r.car_id = c.id) AS rentals_count,
           (SELECT r.contract_no FROM rentals r WHERE r.car_id = c.id AND r.status = 'active' LIMIT 1) AS active_contract,
           (SELECT r.end_date FROM rentals r WHERE r.car_id = c.id AND r.status = 'active' LIMIT 1) AS due_back
    FROM cars c
    WHERE 1 = 1`;
  if (q) {
    sql += ' AND (c.plate LIKE ? OR c.make LIKE ? OR c.model LIKE ? OR c.vin LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) {
    sql += ' AND c.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY c.plate';

  const [rows, counts] = await Promise.all([
    db.prepare(sql).all(...params),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
              SUM(CASE WHEN status = 'rented' THEN 1 ELSE 0 END) AS rented,
              SUM(CASE WHEN status IN ('maintenance','retired') THEN 1 ELSE 0 END) AS off_road
       FROM cars`
    ).get()
  ]);
  const cars = rows.map((c) => ({ ...c, rentals_count: Number(c.rentals_count) || 0 }));

  res.render('cars/index', {
    title: 'Fleet',
    cars,
    q,
    status,
    statuses: CAR_STATUSES,
    today: new Date().toISOString().slice(0, 10),
    stats: {
      total: Number(counts.total) || 0,
      available: Number(counts.available) || 0,
      rented: Number(counts.rented) || 0,
      offRoad: Number(counts.off_road) || 0
    }
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
    statuses: CHOOSABLE,
    action: '/cars'
  });
});

router.post('/', async (req, res) => {
  const car = readCarForm(req.body);
  const errors = validate(car);
  if (await db.prepare('SELECT 1 FROM cars WHERE plate = ?').get(car.plate)) {
    errors.push('A car with that plate already exists.');
  }
  if (car.status === 'rented') errors.push('A car becomes "rented" when a contract is issued for it, not by hand.');
  if (errors.length) {
    return res.status(400).render('cars/form', { title: 'Add car', car, errors, statuses: CHOOSABLE, action: '/cars' });
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
  const out = await activeContract(car.id);
  res.render('cars/form', {
    title: `Edit ${car.plate}`, car: out ? car : { ...car, status: car.status === 'rented' ? 'available' : car.status },
    errors: [], statuses: out ? CAR_STATUSES : CHOOSABLE, action: `/cars/${car.id}`
  });
});

router.post('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM cars WHERE id = ?').get(id);
  if (!existing) return res.status(404).render('error', { title: 'Not found', message: 'Car not found.' });

  const car = readCarForm(req.body);
  const errors = validate(car);
  const clash = await db.prepare('SELECT 1 FROM cars WHERE plate = ? AND id <> ?').get(car.plate, id);
  if (clash) errors.push('Another car already uses that plate.');
  // Whether the car is out is decided by its contracts, not by the status
  // field: a car left marked rented with no contract must be freeable.
  const out = await activeContract(id);
  if (out && car.status !== 'rented') {
    errors.push(`This car is out on ${out.contract_no} — check it in before changing its status.`);
  } else if (!out && car.status === 'rented') {
    errors.push('A car becomes "rented" when a contract is issued for it, not by hand.');
  }
  if (out && car.odometer < Number(existing.odometer)) {
    errors.push('The odometer cannot be wound back while the car is out on a contract.');
  }
  if (errors.length) {
    return res.status(400).render('cars/form', {
      title: `Edit ${existing.plate}`, car: { ...car, id }, errors,
      statuses: out ? CAR_STATUSES : CHOOSABLE, action: `/cars/${id}`
    });
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
  // Awaited before reading .n: reading it off the pending query gave undefined,
  // so the guard never fired and the delete fell through to the database.
  const { n: used } = await db.prepare('SELECT COUNT(*) AS n FROM rentals WHERE car_id = ?').get(id);
  if (Number(used) > 0) {
    req.session.flash = { type: 'error', message: 'This car has rental history and cannot be deleted. Set it to "retired" instead.' };
    return res.redirect('/cars');
  }
  await db.prepare('DELETE FROM cars WHERE id = ?').run(id);
  req.session.flash = { type: 'success', message: 'Car removed.' };
  res.redirect('/cars');
});

module.exports = router;
