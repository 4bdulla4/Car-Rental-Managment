'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const app = require('../src/app');
const esign = require('../src/lib/esign');
const { hashPassword } = require('../src/lib/passwords');

let db;
let server;
let base;
let staff = '';
let customer = '';

const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAZACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDraKKKsQUUUUAFFFFABRRRQAUUUUAFFFFAH//Z';
const PHOTO = 'data:image/jpeg;base64,' + JPEG + 'A'.repeat(2800);
const PNG = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ'.repeat(12) + '==';
const day = (o) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);

function client(getJar, setJar) {
  const absorb = (r) => { const c = r.headers.getSetCookie(); if (c.length) setJar(c.map((x) => x.split(';')[0]).join('; ')); return r; };
  const get = async (p) => {
    const r = absorb(await fetch(base + p, { headers: { cookie: getJar() }, redirect: 'manual' }));
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  };
  const post = async (p, fields, from) => {
    const t = /name="_csrf" value="([a-f0-9]+)"/.exec((await get(from)).body)[1];
    const r = absorb(await fetch(base + p, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: getJar(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: t, ...fields })
    }));
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  };
  return { get, post };
}
const S = client(() => staff, (j) => { staff = j; });
const C = client(() => customer, (j) => { customer = j; });
const one = (sql, ...a) => db.prepare(sql).get(...a);

const details = (extra = {}) => ({
  phone: '+966 55 123 4567', email: 'omar@test.local', id_number: '1098765432', license_number: 'DL-REV-1',
  license_expiry: '2031-01-01', address: 'Al Olaya, Riyadh', emergency_name: 'Sara', emergency_phone: '+966 50 000 0000', ...extra
});
const consents = () => Object.fromEntries(esign.CONSENTS.map((c) => ['consent_' + c.id, '1']));

let n = 0;
async function issue() {
  n += 1;
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate, odometer) VALUES (?,'Toyota','Camry',200,1000)").run(`REV-${n}`);
  const car = (await one('SELECT id FROM cars WHERE plate = ?', `REV-${n}`)).id;
  const res = await S.post('/rentals', {
    car_id: String(car), customer_id: '1', start_date: day(0), end_date: day(3), daily_rate: '200',
    km_allowance_per_day: '200', excess_km_rate: '0.5', deposit: '500', discount: '0', pickup_odometer: '1000', pickup_fuel: '8'
  }, '/rentals/new');
  return one('SELECT * FROM rentals WHERE id = ?', Number(res.location.split('/').pop()));
}
async function sign(r, extra = {}) {
  customer = '';
  const link = `/sign/${r.sign_token}`;
  await C.post(`${link}/code`, { code: r.sign_code }, link);
  await C.post(`${link}/licence`, { licence_front: PHOTO, licence_back: PHOTO }, link);
  return C.post(link, { signed_name: 'Omar Al-Harbi', signature_data: PNG, ...details(extra), ...consents() }, link);
}

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('rev@test.local','Reviewer',?,'staff')")
    .run(hashPassword('CorrectHorseBattery'));
  await db.prepare("INSERT INTO customers (full_name, phone, license_number, license_expiry, address) VALUES ('Omar Al-Harbi','0500','DL-REV-1','2031-01-01','Old Street 1')").run();
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  await S.post('/login', { email: 'rev@test.local', password: 'CorrectHorseBattery', next: '/' }, '/login');
});
test.after(async () => { if (server) server.close(); if (db) await db.close(); });

test('a signed agreement waits for review, and the team is told how many', async () => {
  const r = await issue();
  assert.equal((await sign(r, { address: 'New Road 9' })).status, 302);
  assert.equal((await one('SELECT review_status FROM rentals WHERE id = ?', r.id)).review_status, 'pending');

  const home = await S.get('/');
  assert.match(home.body, /class="nav-count"[^>]*>1</, 'the nav counts what is waiting');
  const queue = await S.get('/reviews');
  assert.match(queue.body, new RegExp(r.contract_no));
  assert.match(queue.body, /2 changed/, 'corrections — phone and address — are flagged as changes');
  assert.match(queue.body, /4 added/, 'and fields filled in where there was nothing are counted apart');
});

test('the review page shows what the customer changed, was and now', async () => {
  const r = await one("SELECT id FROM rentals WHERE review_status = 'pending'");
  const page = (await S.get(`/reviews/${r.id}`)).body.replace(/\s+/g, ' ');
  assert.match(page, /Home address <span class="badge maintenance">changed<\/span><\/td> <td class="muted">Old Street 1<\/td><td><strong>New Road 9<\/strong>/);
  assert.match(page, /Emergency contact name<\/td> <td class="muted">—<\/td><td><strong>Sara<\/strong>/, 'an addition shows as such');
  assert.match(page, /Unchanged since signing/);
});

test('approving accepts it, records who, and cannot be done twice', async () => {
  const r = await one("SELECT id, sign_token FROM rentals WHERE review_status = 'pending'");
  assert.equal((await S.post(`/reviews/${r.id}/approve`, { note: 'Licence checked' }, `/reviews/${r.id}`)).status, 302);
  const after = await one('SELECT review_status, reviewed_by_name, review_note FROM rentals WHERE id = ?', r.id);
  assert.deepEqual({ ...after }, { review_status: 'approved', reviewed_by_name: 'Reviewer', review_note: 'Licence checked' });

  await S.post(`/reviews/${r.id}/approve`, {}, `/reviews/${r.id}`);
  assert.equal((await one('SELECT reviewed_at FROM rentals WHERE id = ?', r.id)).reviewed_at !== null, true);
  const log = await one("SELECT action FROM activity_log WHERE action LIKE 'Approved%' ORDER BY id DESC");
  assert.ok(log, 'the approval is in the activity history');

  customer = '';
  assert.match((await C.get(`/sign/${r.sign_token}`)).body, /checked and approved it/, 'and the customer sees it');
});

test('sending back needs a reason, keeps the old signature, and reopens the link', async () => {
  const r = await issue();
  await sign(r);
  const noReason = await S.post(`/reviews/${r.id}/reject`, { reason: '  ' }, `/reviews/${r.id}`);
  assert.equal((await one('SELECT review_status FROM rentals WHERE id = ?', r.id)).review_status, 'pending', 'no reason, no rejection');

  await S.post(`/reviews/${r.id}/reject`, { reason: 'The licence photo is blurred.' }, `/reviews/${r.id}`);
  const after = await one('SELECT * FROM rentals WHERE id = ?', r.id);
  assert.equal(after.review_status, 'rejected');
  assert.equal(after.signature_data, null, 'the signature is set aside');
  const archived = await one('SELECT * FROM signing_rejections WHERE rental_id = ?', r.id);
  assert.equal(archived.reason, 'The licence photo is blurred.');
  assert.equal(archived.signature_data, PNG, 'but kept on record');
  assert.equal(Buffer.from(archived.pdf, 'base64').subarray(0, 5).toString(), '%PDF-', 'with the PDF that was signed');
  assert.equal(await one("SELECT 1 AS x FROM contract_documents WHERE rental_id = ? AND kind = 'signed_pdf'", r.id), undefined);

  customer = '';
  const link = `/sign/${r.sign_token}`;
  await C.post(`${link}/code`, { code: r.sign_code }, link);
  const page = await C.get(link);
  assert.match(page.body, /could not accept your earlier signature/);
  assert.match(page.body, /The licence photo is blurred\./);

  assert.equal((await C.post(link, { signed_name: 'Omar Al-Harbi', signature_data: PNG, ...details(), ...consents() }, link)).status, 302);
  assert.equal((await one('SELECT review_status FROM rentals WHERE id = ?', r.id)).review_status, 'pending', 'signed again, back in the queue');
});

test('an agreement changed since signing cannot be approved', async () => {
  const r = await issue();
  await sign(r);
  await db.prepare('UPDATE rentals SET daily_rate = 999 WHERE id = ?').run(r.id);
  const res = await S.post(`/reviews/${r.id}/approve`, {}, `/reviews/${r.id}`);
  assert.equal(res.location, `/reviews/${r.id}`);
  assert.equal((await one('SELECT review_status FROM rentals WHERE id = ?', r.id)).review_status, 'pending');
});
