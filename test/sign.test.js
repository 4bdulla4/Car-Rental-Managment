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
let jar = '';
let rentalId;
let token;
let code;

const PNG = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQ'.repeat(12) + '==';

/** Every confirmation ticked, as the form posts them. */
const allConsents = () =>
  Object.fromEntries(esign.CONSENTS.map((c) => ['consent_' + c.id, '1']));

function absorb(res) {
  const c = res.headers.getSetCookie();
  if (c.length) jar = c.map((x) => x.split(';')[0]).join('; ');
  return res;
}
async function get(path) {
  const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, body: await res.text() };
}
async function post(path, fields, formPath) {
  const page = await get(formPath || path);
  const match = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body);
  const res = absorb(await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: match ? match[1] : '', ...fields })
  }));
  return { status: res.status, body: await res.text() };
}
const row = async (id) => db.prepare('SELECT * FROM rentals WHERE id = ?').get(id || rentalId);

async function signIn() {
  await post('/login', { email: 'admin@test.local', password: 'AdminPassword123', next: '/' }, '/login');
}

// A car goes off the lot once it is rented, so each contract needs its own.
let nextCar = 1;
async function newRental(start, end) {
  const car = String(nextCar++);
  await post('/rentals', {
    car_id: car, customer_id: '1', start_date: start, end_date: end,
    daily_rate: '150', km_allowance_per_day: '250', excess_km_rate: '0.5',
    deposit: '500', discount: '0', pickup_odometer: '1000', pickup_fuel: '8'
  }, '/rentals/new');
  const r = await db.prepare('SELECT id FROM rentals ORDER BY id DESC LIMIT 1').get();
  await post(`/rentals/${r.id}/send`, {}, `/rentals/${r.id}`);
  return db.prepare('SELECT * FROM rentals WHERE id = ?').get(r.id);
}

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run('admin@test.local', 'Admin', hashPassword('AdminPassword123'));
  for (const plate of ['SGN-1', 'SGN-2', 'SGN-3', 'SGN-4', 'SGN-5']) {
    await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES (?,'Toyota','Corolla',150)").run(plate);
  }
  await db.prepare("INSERT INTO customers (full_name, phone, email, license_number) VALUES ('Omar Al-Harbi','123','omar@test.local','DL-1')").run();

  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await signIn();
  const rental = await newRental('2026-03-01', '2026-03-05');
  rentalId = rental.id;
  token = rental.sign_token;
  code = rental.sign_code;
  jar = ''; // from here on, act as the customer with no session
});

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test('a link, an access code and a deadline are issued together', async () => {
  assert.match(token, /^[a-f0-9]{48}$/, 'expected a long random token');
  assert.match(code, /^\d{6}$/, 'expected a six-digit access code');
  const r = await row();
  assert.ok(r.sign_expires_at > esign.stamp(), 'the link must expire in the future');
});

test('an unknown token is refused', async () => {
  const bad = await get('/sign/' + 'a'.repeat(48));
  assert.equal(bad.status, 404);
  const malformed = await get('/sign/not-a-token');
  assert.equal(malformed.status, 404);
});

test('the link alone does not open the agreement', async () => {
  const page = await get('/sign/' + token);
  assert.equal(page.status, 200);
  assert.match(page.body, /access code/i, 'the code is asked for first');
  assert.doesNotMatch(page.body, /Sign here/, 'the signing form must not be reachable yet');

  const doc = await get(`/sign/${token}/document`);
  assert.equal(doc.status, 403, 'nor may the document be read around the gate');
});

test('opening the link is recorded, once', async () => {
  const first = await row();
  assert.ok(first.sign_opened_at, 'the first opening is recorded');
  await get('/sign/' + token);
  const second = await row();
  assert.equal(second.sign_opened_at, first.sign_opened_at, 'later visits do not overwrite it');
});

test('a wrong code is counted and does not open the agreement', async () => {
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  const res = await post(`/sign/${token}/code`, { code: wrong }, `/sign/${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /not right/i);
  assert.match(res.body, /attempts? left/i, 'the signer is told where they stand');
  assert.equal(Number((await row()).sign_code_tries), 1);
});

test('the right code opens the agreement and is recorded', async () => {
  const res = await post(`/sign/${token}/code`, { code }, `/sign/${token}`);
  assert.equal(res.status, 302);

  const page = await get('/sign/' + token);
  assert.match(page.body, /Sign here/);
  esign.CONSENTS.forEach((c) => {
    assert.ok(page.body.includes(c.text.slice(0, 40)), `the page must state: ${c.id}`);
  });

  const r = await row();
  assert.ok(r.sign_code_at, 'clearing the code is part of the record');
  assert.equal(Number(r.sign_code_tries), 0, 'a success clears the failures');
});

test('every confirmation must be ticked, not just one', async () => {
  const partial = { ...allConsents() };
  delete partial['consent_' + esign.CONSENTS[1].id];
  const res = await post(`/sign/${token}`, {
    signed_name: 'Omar Al-Harbi', signature_data: PNG, ...partial
  }, `/sign/${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /tick every confirmation/i);
  assert.equal((await row()).signature_data, null, 'nothing is stored');
});

test('anything that is not a PNG data URL is refused', async () => {
  const res = await post(`/sign/${token}`, {
    signed_name: 'Omar Al-Harbi', signature_data: 'javascript:alert(1)', ...allConsents()
  }, `/sign/${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /draw your signature/i);
  assert.equal((await row()).signature_data, null, 'nothing should have been stored');
});

test('an empty pad is refused even though it is a valid PNG', async () => {
  const res = await post(`/sign/${token}`, {
    signed_name: 'Omar Al-Harbi', ...allConsents(),
    signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  }, `/sign/${token}`);
  assert.equal(res.status, 400);
  assert.match(res.body, /looks empty/i);
});

test('signing records the signature and the evidence around it', async () => {
  const res = await post(`/sign/${token}`, {
    signed_name: 'Omar Al-Harbi', signature_data: PNG, ...allConsents()
  }, `/sign/${token}`);
  assert.equal(res.status, 302);

  const r = await row();
  assert.equal(r.signed_name, 'Omar Al-Harbi');
  assert.equal(r.signature_data, PNG);
  assert.ok(r.handover_signed_at, 'the time of signing');
  assert.ok(r.signed_ip !== null, 'where it came from');
  assert.match(String(r.sign_doc_hash), /^[a-f0-9]{64}$/, 'a hash of the terms signed');

  const stored = JSON.parse(r.sign_consents);
  assert.equal(stored.length, esign.CONSENTS.length);
  assert.deepEqual(
    stored.map((c) => c.text),
    esign.CONSENTS.map((c) => c.text),
    'the wording shown is kept, so a certificate can quote it years later'
  );
});

test('a signed agreement cannot be signed again', async () => {
  const res = await post(`/sign/${token}`, {
    signed_name: 'Someone Else', signature_data: PNG, ...allConsents()
  }, '/login');
  assert.equal(res.status, 409);
  assert.equal((await row()).signed_name, 'Omar Al-Harbi', 'the original signature must stand');
});

test('the signer is shown their own record afterwards', async () => {
  const page = await get('/sign/' + token);
  assert.match(page.body, /Your signing record/);
  assert.match(page.body, /Document fingerprint/);
  assert.match(page.body, /word for word/, 'and told it still matches');
});

test('changing a term after signing is detected', async () => {
  const before = await row();
  const parts = {
    terms: ['A term'], agreement: { governingLaw: 'KSA' },
    company: { name: 'Co' }, currency: 'SAR'
  };
  const hash = esign.documentHash(before, parts);
  assert.equal(esign.integrity({ ...before, sign_doc_hash: hash }, parts).state, 'intact');

  const moved = { ...before, daily_rate: Number(before.daily_rate) + 50 };
  assert.equal(esign.integrity({ ...moved, sign_doc_hash: hash }, parts).state, 'altered');

  // A contract signed before hashes were kept is not accused of being tampered with.
  assert.equal(esign.integrity({ ...before, sign_doc_hash: null }, parts).state, 'unknown');
});

test('editing the standard terms does not rewrite a signed agreement', async () => {
  jar = '';
  await signIn();

  const before = await get(`/rentals/${rentalId}/contract`);
  assert.match(before.body, /fuel/i, 'the issued agreement has its clauses');

  await post('/settings/terms', { company_terms: 'The Lessee agrees to absolutely anything at all.' }, '/settings');

  const after = await get(`/rentals/${rentalId}/contract`);
  assert.doesNotMatch(after.body, /absolutely anything at all/,
    'a contract already signed must not pick up the new wording');
  assert.equal(after.body.length > 0, true);

  const page = await get(`/rentals/${rentalId}`);
  assert.match(page.body, /Agreement unchanged since signing/,
    'and it is still word for word what was signed');

  // A contract issued from here on does take the new terms.
  const fresh = await newRental('2026-11-01', '2026-11-03');
  const freshDoc = await get(`/rentals/${fresh.id}/contract`);
  assert.match(freshDoc.body, /absolutely anything at all/, 'new contracts use the current terms');

  await post('/settings/terms', { company_terms: '' }, '/settings');
});

test('the certificate of completion states the evidence, and its limits', async () => {
  jar = '';
  await signIn();
  const cert = await get(`/rentals/${rentalId}/certificate`);
  assert.equal(cert.status, 200);
  assert.match(cert.body, /Certificate of Completion/i);
  assert.match(cert.body, /Omar Al-Harbi/);
  assert.match(cert.body, /Fingerprint at signing/);
  assert.match(cert.body, /Access code entered correctly/, 'the audit trail is printed');
  assert.match(cert.body, /not<\/strong> a certificate-based or qualified/i, 'it does not overclaim');
  esign.CONSENTS.forEach((c) => {
    assert.ok(cert.body.includes(c.text.slice(0, 40)), `the certificate quotes: ${c.id}`);
  });
});

test('an unsigned agreement has no certificate to give', async () => {
  const other = await newRental('2026-05-01', '2026-05-03');
  const cert = await get(`/rentals/${other.id}/certificate`);
  assert.equal(cert.status, 302, 'staff are sent back rather than shown an empty certificate');
});

test('an expired link cannot be used', async () => {
  const other = await newRental('2026-06-01', '2026-06-04');
  await db.prepare('UPDATE rentals SET sign_expires_at = ? WHERE id = ?')
    .run('2020-01-01 00:00:00', other.id);

  jar = '';
  const page = await get('/sign/' + other.sign_token);
  assert.equal(page.status, 410);
  assert.match(page.body, /expired/i);

  const attempt = await post(`/sign/${other.sign_token}`, {
    signed_name: 'Omar Al-Harbi', signature_data: PNG, ...allConsents()
  }, '/login');
  assert.equal(attempt.status, 410, 'and it cannot be signed either');
});

test('reissuing kills the old link', async () => {
  jar = '';
  await signIn();
  const other = await newRental('2026-07-01', '2026-07-04');
  const old = other.sign_token;

  await post(`/rentals/${other.id}/reissue`, {}, `/rentals/${other.id}`);
  const after = await row(other.id);
  assert.notEqual(after.sign_token, old, 'a new token is issued');
  assert.notEqual(after.sign_code, other.sign_code, 'and a new code with it');

  jar = '';
  assert.equal((await get('/sign/' + old)).status, 404, 'the old link is dead');
});

test('the access code can be turned off for a business that does not want it', async () => {
  jar = '';
  await signIn();
  const other = await newRental('2026-08-01', '2026-08-04');
  await db.prepare("INSERT INTO settings (key, value) VALUES ('sign_code_required','0')").run();

  jar = '';
  const page = await get('/sign/' + other.sign_token);
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign here/, 'the agreement opens straight away');

  await db.prepare("DELETE FROM settings WHERE key = 'sign_code_required'").run();
});

test('the signature is printed on the contract', async () => {
  jar = '';
  await signIn();
  const contract = await get(`/rentals/${rentalId}/contract`);
  assert.match(contract.body, /class="signature"/);
  assert.match(contract.body, /Signed electronically by Omar Al-Harbi/);
});
