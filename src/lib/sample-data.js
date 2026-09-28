'use strict';
/**
 * A year of made-up trading history, so a fresh installation has something to
 * report on before it has traded.
 *
 * Everything it creates is flagged `is_sample`, and nothing else is ever
 * touched: removing the sample leaves real records exactly as they were. The
 * figures are generated from a fixed seed, so loading it twice on two machines
 * produces the same history and a screenshot keeps matching the numbers.
 */
const db = require('../db');
const settings = require('./settings');
const { round2 } = require('./money');

const CARS = [
  ['SMP-4821', 'Toyota', 'Camry', 2024, 'White', 'JTNBE46K3730123SM', 'automatic', 5, 260, 250, 0.6, 38400, 8],
  ['SMP-1190', 'Hyundai', 'Elantra', 2023, 'Silver', 'KMHLM4AG6PU119SM0', 'automatic', 5, 190, 250, 0.5, 51200, 8],
  ['SMP-7734', 'Nissan', 'Patrol', 2024, 'Black', 'JN8AY2ND9R9773SM4', 'automatic', 7, 520, 200, 1.2, 22750, 8],
  ['SMP-2208', 'Kia', 'Sportage', 2023, 'Grey', 'KNDPMCAC7P7220SM8', 'automatic', 5, 300, 250, 0.7, 44100, 8],
  ['SMP-9015', 'Chevrolet', 'Tahoe', 2022, 'Blue', '1GNSKBKC9NR901SM5', 'automatic', 7, 480, 200, 1.1, 68900, 8],
  ['SMP-5567', 'Toyota', 'Yaris', 2024, 'Red', 'MR2B29F36R1556SM7', 'automatic', 5, 150, 300, 0.4, 16300, 8]
];

const CUSTOMERS = [
  ['Omar Al-Harbi', '+966 55 401 2288', 'omar.sample@example.com', '1098765432', 'SMP-DL-1001', '2029-04-30', 'Al Olaya, Riyadh'],
  ['Sara Mansour', '+966 50 118 7744', 'sara.sample@example.com', '2045567811', 'SMP-DL-1002', '2028-11-15', 'Al Khobar'],
  ['James Okoro', '+966 56 700 4411', 'james.sample@example.com', 'P8812340', 'SMP-DL-1003', '2027-06-01', 'Jeddah'],
  ['Layla Haddad', '+966 53 229 6610', 'layla.sample@example.com', '1077231189', 'SMP-DL-1004', '2030-02-20', 'Dammam'],
  ['Bilal Chaudhry', '+966 59 883 1020', 'bilal.sample@example.com', 'AB4471290', 'SMP-DL-1005', '2028-08-09', 'Al Malaz, Riyadh'],
  ['Nadia Karim', '+966 54 612 3390', 'nadia.sample@example.com', '1034889201', 'SMP-DL-1006', '2029-09-28', 'Dhahran'],
  ['Hassan Al-Otaibi', '+966 55 770 1234', 'hassan.sample@example.com', '1066720044', 'SMP-DL-1007', '2027-12-05', 'Buraydah'],
  ['Mei Lin Tan', '+966 58 004 9912', 'mei.sample@example.com', 'E7739210', 'SMP-DL-1008', '2028-03-17', 'Jubail']
];

/** A small deterministic generator, so the sample never shifts between runs. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

/**
 * Twelve months of closed contracts, two to four a month, weighted so the
 * larger vehicles earn more. Every figure is stored on the contract exactly as
 * a real settlement would store it, including the rates it was settled against.
 */
function history(cars, customers, { currency, fuelChargePerEighth, lateDayMultiplier, deposit }, today) {
  const rand = seeded(20260917);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const rentals = [];

  let turn = 0;
  for (let back = 11; back >= 0; back -= 1) {
    const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
    const daysInMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    const count = 3 + Math.floor(rand() * 3);

    for (let i = 0; i < count; i += 1) {
      // Taking the cars in turn rather than at random keeps every month a mix of
      // large and small vehicles, so one month is not twenty times another.
      const car = cars[turn++ % cars.length];
      const customer = pick(customers);
      const days = 2 + Math.floor(rand() * 8);
      const startDay = 1 + Math.floor(rand() * Math.max(1, daysInMonth - days - 2));
      const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), startDay));
      const end = addDays(start, days);
      // The current month is only part-way through, so its later contracts have
      // not been returned yet and are left out rather than dated in the future.
      if (end > today) continue;

      const lateDays = rand() < 0.22 ? 1 + Math.floor(rand() * 2) : 0;
      const returned = addDays(end, lateDays);
      const excessKm = rand() < 0.3 ? 40 + Math.floor(rand() * 260) : 0;
      const missingEighths = rand() < 0.25 ? 1 + Math.floor(rand() * 3) : 0;
      const damage = rand() < 0.08 ? 150 + Math.floor(rand() * 600) : 0;

      const base = round2(days * car.daily_rate);
      const lateFee = round2(lateDays * car.daily_rate * lateDayMultiplier);
      const excessFee = round2(excessKm * car.excess_km_rate);
      const fuelFee = round2(missingEighths * fuelChargePerEighth);
      const discount = days >= 10 ? round2(base * 0.1) : 0;
      const total = round2(base + lateFee + excessFee + fuelFee + damage - discount);
      const kmDriven = days * car.km_allowance_per_day + excessKm;

      rentals.push({
        car_id: car.id,
        customer_id: customer.id,
        start_date: iso(start),
        end_date: iso(end),
        daily_rate: car.daily_rate,
        km_allowance_per_day: car.km_allowance_per_day,
        excess_km_rate: car.excess_km_rate,
        deposit,
        discount,
        pickup_odometer: car.odometer,
        pickup_fuel: 8,
        return_date: iso(returned),
        return_odometer: car.odometer + kmDriven,
        return_fuel: 8 - missingEighths,
        damage_charge: damage,
        other_charges: 0,
        late_fee: lateFee,
        excess_km_fee: excessFee,
        fuel_fee: fuelFee,
        base_charge: base,
        total_amount: total,
        balance_due: 0,
        currency,
        fuel_charge_per_eighth: fuelChargePerEighth,
        late_day_multiplier: lateDayMultiplier,
        closed_at: iso(returned),
        handover_signed_at: iso(start)
      });

      car.odometer += kmDriven;
    }
  }

  rentals.sort((a, b) => (a.closed_at < b.closed_at ? -1 : 1));
  return rentals;
}

/** How much of the sample is currently in the database. */
async function summary() {
  const one = async (table) =>
    Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_sample = 1`).get()).n);
  return { cars: await one('cars'), customers: await one('customers'), rentals: await one('rentals') };
}

/**
 * Adds the sample if it is not already there. Existing records are never
 * altered: a plate or licence already in use is left alone and skipped.
 */
async function load() {
  const existing = await summary();
  if (existing.rentals > 0) return { ...existing, created: false };

  const policy = settings.policy();
  const terms = {
    currency: settings.currency(),
    fuelChargePerEighth: policy.fuelChargePerEighth,
    lateDayMultiplier: policy.lateDayMultiplier,
    deposit: settings.deposit()
  };

  // One transaction: a run that is cut short leaves no half-written history,
  // which matters on a serverless host where a cold start can be stopped.
  await db.tx(async (t) => {
    for (const car of CARS) {
      await t.prepare(
        `INSERT INTO cars (plate, make, model, year, color, vin, transmission, seats, daily_rate,
                           km_allowance_per_day, excess_km_rate, odometer, fuel_level, is_sample)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(plate) DO NOTHING`
      ).run(...car);
    }
    for (const c of CUSTOMERS) {
      await t.prepare(
        `INSERT INTO customers (full_name, phone, email, id_number, license_number, license_expiry,
                                address, is_sample)
         SELECT ?,?,?,?,?,?,?,1 WHERE NOT EXISTS (SELECT 1 FROM customers WHERE license_number = ?)`
      ).run(...c, c[4]);
    }
  });

  const cars = await db.prepare('SELECT * FROM cars WHERE is_sample = 1 ORDER BY id').all();
  const customers = await db.prepare('SELECT id FROM customers WHERE is_sample = 1 ORDER BY id').all();
  if (!cars.length || !customers.length) return { ...(await summary()), created: false };

  const today = new Date();
  const rows = history(
    cars.map((c) => ({
      id: Number(c.id),
      daily_rate: Number(c.daily_rate),
      km_allowance_per_day: Number(c.km_allowance_per_day),
      excess_km_rate: Number(c.excess_km_rate),
      odometer: Number(c.odometer)
    })),
    customers.map((c) => ({ id: Number(c.id) })),
    terms,
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  );

  // Contract numbers continue the real series rather than starting a parallel one.
  const used = new Set(
    (await db.prepare('SELECT contract_no FROM rentals').all()).map((r) => String(r.contract_no))
  );
  const nextNo = (year) => {
    let seq = 1;
    let no = `RC-${year}-${String(seq).padStart(4, '0')}`;
    while (used.has(no)) {
      seq += 1;
      no = `RC-${year}-${String(seq).padStart(4, '0')}`;
    }
    used.add(no);
    return no;
  };

  const columns = [
    'contract_no', 'car_id', 'customer_id', 'start_date', 'end_date', 'daily_rate',
    'km_allowance_per_day', 'excess_km_rate', 'deposit', 'discount', 'pickup_odometer',
    'pickup_fuel', 'return_date', 'return_odometer', 'return_fuel', 'damage_charge',
    'other_charges', 'late_fee', 'excess_km_fee', 'fuel_fee', 'base_charge', 'total_amount',
    'balance_due', 'currency', 'fuel_charge_per_eighth', 'late_day_multiplier', 'closed_at',
    'handover_signed_at'
  ];
  await db.tx(async (t) => {
    const insert = t.prepare(
      `INSERT INTO rentals (${columns.join(', ')}, status, is_sample)
       VALUES (${columns.map(() => '?').join(',')}, 'closed', 1)`
    );
    for (const row of rows) {
      await insert.run(nextNo(row.closed_at.slice(0, 4)), ...columns.slice(1).map((c) => row[c]));
    }
    // The sample cars are all back on the lot, since every contract is closed.
    await t.prepare("UPDATE cars SET status = 'available' WHERE is_sample = 1").run();
  });
  return { ...(await summary()), created: true };
}

/**
 * An earlier demo, put on a live site through its own forms before sample
 * rows were flagged. It cannot be told apart by a flag, so it is named here,
 * record by record, and nothing outside this list is ever treated as part of
 * it. Every contract written on these cars or customers is demo too: they
 * existed only to be shown.
 */
const EARLIER_DEMO = {
  plates: ['RUH-4412', 'RUH-7781', 'JED-2093', 'DMM-5560', 'RUH-3327', 'JED-8814'],
  licences: ['DL-778812', 'DL-440231', 'DL-991044', 'DL-663301', 'DL-220987']
};

const marks = (list) => list.map(() => '?').join(',');
// Parenthesised because these get more conditions appended with AND, and AND
// binds tighter than OR: unbracketed, every sample car counted as "kept".
const DEMO_CARS = `SELECT id FROM cars WHERE (is_sample = 1 OR plate IN (${marks(EARLIER_DEMO.plates)}))`;
const DEMO_CUSTOMERS = `SELECT id FROM customers WHERE (is_sample = 1 OR license_number IN (${marks(EARLIER_DEMO.licences)}))`;
const EARLIER_CARS = `SELECT id FROM cars WHERE plate IN (${marks(EARLIER_DEMO.plates)})`;
const EARLIER_CUSTOMERS = `SELECT id FROM customers WHERE license_number IN (${marks(EARLIER_DEMO.licences)})`;
// Flagged sample contracts, and anything written on the earlier demo's records.
const DEMO_RENTALS = `SELECT id FROM rentals WHERE is_sample = 1
                        OR car_id IN (${EARLIER_CARS}) OR customer_id IN (${EARLIER_CUSTOMERS})`;
const rentalArgs = [...EARLIER_DEMO.plates, ...EARLIER_DEMO.licences];

/**
 * What "Remove demo data" would take away, counted exactly the way remove()
 * deletes, so the number on the button is the number that goes.
 */
async function demoSummary() {
  const count = async (sql, args) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args)).n);
  const rentals = await count(DEMO_RENTALS, rentalArgs);
  // A demo car or customer on a contract that stays is kept, and said so.
  const keptCars = await count(
    `${DEMO_CARS} AND id IN (SELECT car_id FROM rentals WHERE id NOT IN (${DEMO_RENTALS}))`,
    [...EARLIER_DEMO.plates, ...rentalArgs]
  );
  const keptCustomers = await count(
    `${DEMO_CUSTOMERS} AND id IN (SELECT customer_id FROM rentals WHERE id NOT IN (${DEMO_RENTALS}))`,
    [...EARLIER_DEMO.licences, ...rentalArgs]
  );
  const cars = await count(DEMO_CARS, EARLIER_DEMO.plates) - keptCars;
  const customers = await count(DEMO_CUSTOMERS, EARLIER_DEMO.licences) - keptCustomers;
  return { cars, customers, rentals, keptCars, keptCustomers, any: cars + customers + rentals > 0 };
}

/**
 * Removes the sample and the earlier demo, and nothing else.
 * A demo car or customer later used on a contract of your own stays, with
 * that contract: a real agreement is never deleted because of what it names.
 */
async function remove() {
  const before = await demoSummary();
  await db.tx(async (t) => {
    // Attachments go with the contracts they belong to, or they are orphaned.
    await t.prepare(`DELETE FROM contract_documents WHERE rental_id IN (${DEMO_RENTALS})`).run(...rentalArgs);
    await t.prepare(`DELETE FROM rentals WHERE id IN (${DEMO_RENTALS})`).run(...rentalArgs);
    await t.prepare(`DELETE FROM customers WHERE id IN (${DEMO_CUSTOMERS}) AND id NOT IN (SELECT customer_id FROM rentals)`)
      .run(...EARLIER_DEMO.licences);
    await t.prepare(`DELETE FROM cars WHERE id IN (${DEMO_CARS}) AND id NOT IN (SELECT car_id FROM rentals)`)
      .run(...EARLIER_DEMO.plates);
  });
  return before;
}

/** Everything the business holds: the fleet, the customers, the contracts. */
async function everythingSummary() {
  const one = async (table) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
  return {
    cars: await one('cars'),
    customers: await one('customers'),
    rentals: await one('rentals'),
    documents: await one('contract_documents')
  };
}

/**
 * A clean slate: every car, customer, contract and licence photo. Accounts,
 * settings and the activity history stay — who did this, and when, is exactly
 * the kind of thing the history is for.
 */
async function clearEverything() {
  const before = await everythingSummary();
  await db.tx(async (t) => {
    await t.prepare('DELETE FROM contract_documents').run();
    await t.prepare('DELETE FROM rentals').run();
    await t.prepare('DELETE FROM customers').run();
    await t.prepare('DELETE FROM cars').run();
  });
  return before;
}

module.exports = {
  load, remove, summary, demoSummary, everythingSummary, clearEverything, CARS, CUSTOMERS, EARLIER_DEMO
};
