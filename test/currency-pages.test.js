'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.CURRENCY = 'SAR';
process.env.SESSION_SECRET = 'test-secret-not-a-real-key';
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carrenter-cur-')), 'test.db');

const app = require('../src/app');
const db = require('../src/db');
const { hashPassword } = require('../src/lib/passwords');

db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
  .run('admin@test.local', 'Admin', hashPassword('CorrectHorseBattery'));
db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('AAA-1','Toyota','Corolla',150)").run();
db.prepare("INSERT INTO customers (full_name, phone, license_number) VALUES ('Test','123','DL-1')").run();

let base;
let jar = '';

function absorb(res) {
  const cookies = res.headers.getSetCookie();
  if (cookies.length) jar = cookies.map((c) => c.split(';')[0]).join('; ');
  return res;
}

async function get(url) {
  const res = absorb(await fetch(base + url, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, body: await res.text() };
}

async function post(url, fields) {
  const page = await get(url.startsWith('/settings') ? '/settings' : url);
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body)[1];
  const res = absorb(await fetch(base + url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, ...fields })
  }));
  return res.status;
}

let server;

test.after(() => {
  if (server) server.close();
});

test.before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

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
});

// Every page that shows a live figure or a money field label.
// /rentals is covered by the later tests, since an empty list shows no amounts.
const LIVE_PAGES = ['/', '/cars', '/cars/new', '/cars/1/edit', '/rentals/new', '/settings'];

test('changing the currency updates every page that shows a live amount', async () => {
  for (const url of LIVE_PAGES) {
    const { status, body } = await get(url);
    assert.equal(status, 200, `${url} should load`);
    assert.ok(body.includes('SAR'), `${url} should start out showing SAR`);
  }

  assert.equal(await post('/settings/currency', { currency: 'XTS' }), 302);

  for (const url of LIVE_PAGES) {
    const { status, body } = await get(url);
    assert.equal(status, 200, `${url} should load after the change`);
    assert.ok(body.includes('XTS'), `${url} still does not show the new currency`);
    // The picker legitimately offers SAR as a choice, and the help text names it
    // as an example; neither is a figure rendered in the old currency.
    const rendered = body
      .replace(/<datalist[\s\S]*?<\/datalist>/g, '')
      .replace(/such as SAR[^<]*/g, '');
    assert.ok(!/\bSAR\b/.test(rendered), `${url} still shows the old currency somewhere`);
  }
});

test('a contract issued earlier keeps its own currency after the change', async () => {
  db.prepare(
    `INSERT INTO rentals (contract_no, car_id, customer_id, start_date, end_date, daily_rate,
                          total_amount, currency, status)
     VALUES ('RC-OLD-1',1,1,'2026-03-01','2026-03-05',150,600,'SAR','closed')`
  ).run();

  const list = await get('/rentals');
  assert.ok(list.body.includes('600.00 SAR'), 'the contract keeps the currency it was issued in');

  const dash = await get('/');
  assert.ok(dash.body.includes('600.00 SAR'), 'closed revenue reports the contract currency');
  assert.ok(dash.body.includes('Yours is now XTS'), 'and the dashboard explains why it differs');
});

test('relabelling brings an old contract onto the current currency', async () => {
  assert.equal(await post('/settings/currency/relabel', { from: 'SAR' }), 302);

  const list = await get('/rentals');
  assert.ok(list.body.includes('600.00 XTS'), 'the relabelled contract now shows the current code');
  // The confirmation message names the old code on purpose; the table must not.
  const table = list.body.replace(/<div class="alert[\s\S]*?<\/div>\s*<\/div>/g, '');
  assert.ok(!/600\.00 SAR/.test(table), 'no amount is still shown in the old currency');

  const row = db.prepare("SELECT total_amount FROM rentals WHERE contract_no = 'RC-OLD-1'").get();
  assert.equal(row.total_amount, 600, 'the amount is never converted');
});
