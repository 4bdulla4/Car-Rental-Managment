'use strict';
/**
 * Creates the first admin account. Run: npm run seed [-- --demo]
 * The password comes from SEED_ADMIN_PASSWORD in .env, or is prompted for.
 * It is never echoed or printed back to the terminal.
 */
const readline = require('readline');
const { Writable } = require('stream');
const db = require('./db');
const { hashPassword } = require('./lib/passwords');

const DEMO_CARS = [
  ['ABC-1234', 'Toyota', 'Corolla', 2023, 'White', 'JTDBR32E430012345', 'automatic', 5, 150, 250, 0.5, 41200, 8],
  ['XYZ-5678', 'Hyundai', 'Elantra', 2024, 'Silver', 'KMHD35LE8EU098765', 'automatic', 5, 165, 250, 0.5, 18450, 8],
  ['KLM-9012', 'Nissan', 'Patrol', 2022, 'Black', 'JN8AY2NC5L9301122', 'automatic', 7, 450, 200, 1.2, 76300, 8],
  ['RST-3456', 'Kia', 'Picanto', 2023, 'Red', 'KNAB2511AMT456789', 'manual', 5, 95, 300, 0.35, 33120, 6]
];

const DEMO_CUSTOMERS = [
  ['Omar Al-Harbi', '+966 55 123 4567', 'omar@example.com', '1098765432', 'DL-778812', '2029-04-30', 'Al Olaya, Riyadh'],
  ['Sara Mansour', '+966 50 998 1122', 'sara@example.com', '2045567811', 'DL-440231', '2028-11-15', 'Al Khobar'],
  ['James Okoro', '+966 56 700 4411', 'james@example.com', 'P8812340', 'DL-991044', '2027-06-01', 'Jeddah']
];

/** Prompt without echoing the typed characters. */
function askPassword(question) {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(chunk, encoding, callback) {
        if (!muted.hidden) process.stdout.write(chunk, encoding);
        callback();
      }
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted.hidden = true;
  });
}

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const name = process.env.SEED_ADMIN_NAME || 'Fleet Admin';

  await db.ready();

  if (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    console.log('Admin ' + email + ' already exists - skipping user creation.');
  } else {
    let password = process.env.SEED_ADMIN_PASSWORD || '';
    if (!password || password.startsWith('<')) {
      password = await askPassword('Choose a password for ' + email + ' (min 10 chars): ');
    }
    if (String(password).length < 10) {
      console.error('Password must be at least 10 characters. Nothing was created.');
      process.exit(1);
    }
    await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
      .run(email, name, hashPassword(password));
    console.log('Created admin account: ' + email);
  }

  if (process.argv.includes('--demo')) {
    const carStmt = db.prepare(
      `INSERT INTO cars (plate, make, model, year, color, vin, transmission, seats,
                         daily_rate, km_allowance_per_day, excess_km_rate, odometer, fuel_level)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(plate) DO NOTHING`
    );
    for (const car of DEMO_CARS) await carStmt.run(...car);

    const customerStmt = db.prepare(
      `INSERT INTO customers (full_name, phone, email, id_number, license_number, license_expiry, address)
       SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM customers WHERE license_number = ?)`
    );
    for (const c of DEMO_CUSTOMERS) await customerStmt.run(...c, c[4]);

    console.log('Demo data loaded: ' + DEMO_CARS.length + ' cars, ' + DEMO_CUSTOMERS.length + ' customers.');
  }

  console.log('Done. Start the app with: npm start');
  process.exit(0);
}

main();
