'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

process.env.CURRENCY = 'SAR';

const charts = require('../src/lib/charts');
const app = require('../src/app');
const { hashPassword } = require('../src/lib/passwords');

test('an axis top is rounded up to a figure a person can read', () => {
  assert.equal(charts.niceMax(1475), 2000);
  assert.equal(charts.niceMax(820), 1000);
  assert.equal(charts.niceMax(2100), 2500);
  assert.equal(charts.niceMax(0), 1, 'an empty chart still needs a scale');
  assert.deepEqual(charts.ticks(1475), [0, 500, 1000, 1500, 2000]);
});

test('columns are measured from the baseline, never from the top', () => {
  const c = charts.columns([{ value: 0 }, { value: 500 }, { value: 1000 }], { width: 720, height: 210 });
  assert.equal(c.top, 1000);
  // Half the value is half the height, and every bar sits on the same line.
  assert.ok(Math.abs(c.bars[1].h * 2 - c.bars[2].h) < 0.01);
  c.bars.forEach((b) => assert.ok(Math.abs(b.y + b.h - c.baseline) < 0.01, 'bar leaves the baseline'));
  assert.equal(c.bars[0].h, 0, 'nothing earned draws nothing');
});

test('a stacked bar reports shares, not amounts', () => {
  const s = charts.stack(
    [{ key: 'a', value: 600 }, { key: 'b', value: 300 }, { key: 'c', value: 100 }],
    { width: 1000 }
  );
  assert.equal(s.total, 1000);
  assert.deepEqual(s.segments.map((p) => p.share), [0.6, 0.3, 0.1]);
  assert.equal(s.segments[0].x, 0);
  assert.equal(s.segments[1].x, 600, 'segments follow each other without a hole');
  assert.deepEqual(charts.stack([{ key: 'a', value: 0 }], { width: 720 }), { total: 0, segments: [] });
});

test('a zero-value part is left out rather than drawn as a sliver', () => {
  const s = charts.stack([{ key: 'a', value: 50 }, { key: 'b', value: 0 }], { width: 100 });
  assert.deepEqual(s.segments.map((p) => p.key), ['a']);
});

let db;
let server;
let base;
let jar = '';

function absorb(res) {
  const cookies = res.headers.getSetCookie();
  if (cookies.length) jar = cookies.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function get(url) {
  const res = absorb(await fetch(base + url, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

async function closedRental(fields) {
  const cols = Object.keys(fields);
  await db.prepare(
    `INSERT INTO rentals (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => fields[c]));
}

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run('admin@test.local', 'Admin', hashPassword('CorrectHorseBattery'));
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('AAA-1','Toyota','Corolla',150)").run();
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('BBB-2','Nissan','Sunny',120)").run();
  await db.prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Test','123','DL-1')").run();

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test('reports are not readable without signing in', async () => {
  const res = await get('/reports');
  assert.equal(res.status, 302);
  assert.ok(res.location.startsWith('/login'), 'an anonymous visitor is sent to sign in');
});

test('an empty period says so instead of drawing an empty chart', async () => {
  const login = await get('/login');
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(login.body)[1];
  absorb(await fetch(base + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: token, email: 'admin@test.local', password: 'CorrectHorseBattery', next: '/'
    })
  }));

  const res = await get('/reports');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('nothing to chart'), 'an empty report explains itself');
});

test('closed contracts are totalled, charted and broken down', async () => {
  const year = new Date().getFullYear();
  await closedRental({
    contract_no: 'RC-1', car_id: 1, customer_id: 1,
    start_date: `${year}-02-01`, end_date: `${year}-02-05`, daily_rate: 150,
    base_charge: 600, late_fee: 150, excess_km_fee: 0, fuel_fee: 50,
    damage_charge: 0, other_charges: 0, discount: 0,
    total_amount: 800, currency: 'SAR', status: 'closed', closed_at: `${year}-02-05`
  });
  await closedRental({
    contract_no: 'RC-2', car_id: 2, customer_id: 1,
    start_date: `${year}-03-01`, end_date: `${year}-03-03`, daily_rate: 120,
    base_charge: 240, late_fee: 0, excess_km_fee: 60, fuel_fee: 0,
    damage_charge: 0, other_charges: 0, discount: 0,
    total_amount: 300, currency: 'SAR', status: 'closed', closed_at: `${year}-03-03`
  });
  // Still running, so it is not revenue yet.
  await closedRental({
    contract_no: 'RC-3', car_id: 1, customer_id: 1,
    start_date: `${year}-04-01`, end_date: `${year}-04-10`, daily_rate: 150,
    base_charge: 1350, total_amount: 1350, currency: 'SAR', status: 'active'
  });

  const { status, body } = await get('/reports?period=year');
  assert.equal(status, 200);
  assert.ok(body.includes('1,100.00 SAR'), 'revenue is the sum of the closed contracts only');
  assert.ok(body.includes('550.00 SAR'), 'the average contract is shown');
  assert.ok(body.includes('AAA-1') && body.includes('BBB-2'), 'each car appears in the by-car chart');
  assert.ok(body.includes('Late returns'), 'the breakdown names each kind of charge');
  assert.ok(/class="seg seg-late"/.test(body), 'and gives it a segment of its own');
  // Identity is never carried by colour alone.
  assert.ok(body.includes('class="legend"'), 'the composition bar carries a legend');
  assert.ok(body.includes('Show the numbers'), 'the chart has a table view behind it');
});

test('a period filter narrows what is counted', async () => {
  const { body } = await get('/reports?period=month');
  assert.ok(body.includes('nothing to chart'), 'nothing closed this month');
  const all = await get('/reports?period=all');
  assert.ok(all.body.includes('1,100.00 SAR'), 'all time still sees both contracts');
});

test('an unknown period falls back rather than failing', async () => {
  const { status, body } = await get('/reports?period=__proto__');
  assert.equal(status, 200);
  assert.ok(body.includes('This year'), 'the default period is used');
});

test('contracts in another currency are reported apart, never added in', async () => {
  await closedRental({
    contract_no: 'RC-EUR', car_id: 1, customer_id: 1,
    start_date: '2026-01-01', end_date: '2026-01-03', daily_rate: 100,
    base_charge: 200, total_amount: 200, currency: 'EUR', status: 'closed', closed_at: '2026-01-03'
  });

  const { body } = await get('/reports?period=all');
  assert.ok(body.includes('1,100.00 SAR'), 'the total is unchanged by a contract in another currency');
  assert.ok(body.includes('Left out of these totals'), 'and the omission is stated');
  assert.ok(body.includes('in EUR'), 'naming the currency that was left out');
});
