'use strict';
/**
 * One-off copy of an existing SQLite database into Postgres.
 * Usage: node scripts/migrate-sqlite-to-postgres.js [path/to/car-renter.db]
 * Safe to skip if you are starting fresh. Requires Node 24+ for node:sqlite.
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = require('../src/db');

const source = process.argv[2] || path.join(__dirname, '..', 'data', 'car-renter.db');

// Insert order matters: rentals reference cars, customers and users.
const TABLES = [
  ['users', ['email', 'name', 'password_hash', 'role', 'active', 'created_at']],
  ['cars', ['plate', 'make', 'model', 'year', 'color', 'vin', 'transmission', 'seats', 'daily_rate',
            'km_allowance_per_day', 'excess_km_rate', 'odometer', 'fuel_level', 'status', 'notes', 'created_at']],
  ['customers', ['full_name', 'phone', 'email', 'id_number', 'license_number', 'license_expiry',
                 'address', 'notes', 'created_at']],
  ['settings', ['key', 'value', 'updated_at']]
];

const RENTAL_COLUMNS = [
  'contract_no', 'start_date', 'end_date', 'daily_rate', 'km_allowance_per_day', 'excess_km_rate',
  'deposit', 'discount', 'pickup_odometer', 'pickup_fuel', 'pickup_notes', 'status',
  'handover_signed_at', 'return_date', 'return_odometer', 'return_fuel', 'damage_charge',
  'other_charges', 'return_notes', 'late_fee', 'excess_km_fee', 'fuel_fee', 'base_charge',
  'total_amount', 'balance_due', 'currency', 'fuel_charge_per_eighth', 'late_day_multiplier',
  'closed_at', 'created_at'
];

async function main() {
  if (!fs.existsSync(source)) {
    console.log(`No SQLite database at ${source} — nothing to migrate.`);
    process.exit(0);
  }

  await db.ready();
  const sqlite = new DatabaseSync(source, { readOnly: true });

  const existing = await db.prepare('SELECT COUNT(*) AS n FROM cars').get();
  if (Number(existing.n) > 0) {
    console.error('The Postgres database already has cars in it. Refusing to import on top.');
    process.exit(1);
  }

  for (const [table, columns] of TABLES) {
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    const cols = columns.join(', ');
    const holders = columns.map((_, i) => `$${i + 1}`).join(', ');
    for (const row of rows) {
      await db.pool.query(
        `INSERT INTO ${table} (${cols}) VALUES (${holders}) ON CONFLICT DO NOTHING`,
        columns.map((c) => row[c])
      );
    }
    console.log(`  ${table}: ${rows.length}`);
  }

  // Rentals are remapped onto the new car, customer and user ids.
  const rentals = sqlite.prepare('SELECT * FROM rentals').all();
  for (const r of rentals) {
    const car = sqlite.prepare('SELECT plate FROM cars WHERE id = ?').get(r.car_id);
    const customer = sqlite.prepare('SELECT license_number FROM customers WHERE id = ?').get(r.customer_id);
    const user = r.created_by
      ? sqlite.prepare('SELECT email FROM users WHERE id = ?').get(r.created_by)
      : null;

    const target = await db.prepare('SELECT id FROM cars WHERE plate = ?').get(car.plate);
    const targetCustomer = await db.prepare('SELECT id FROM customers WHERE license_number = ?')
      .get(customer.license_number);
    const targetUser = user
      ? await db.prepare('SELECT id FROM users WHERE email = ?').get(user.email)
      : null;

    const cols = ['car_id', 'customer_id', 'created_by', ...RENTAL_COLUMNS];
    const values = [target.id, targetCustomer.id, targetUser ? targetUser.id : null,
                    ...RENTAL_COLUMNS.map((c) => r[c])];
    await db.pool.query(
      `INSERT INTO rentals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (contract_no) DO NOTHING`,
      values
    );
  }
  console.log(`  rentals: ${rentals.length}`);

  sqlite.close();
  console.log('Migration complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
