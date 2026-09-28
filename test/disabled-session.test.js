'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const app = require('../src/app');
const { hashPassword } = require('../src/lib/passwords');

let db;
let server;
let base;
let jar = '';

function absorb(res) {
  const c = res.headers.getSetCookie();
  if (c.length) jar = c.map((x) => x.split(';')[0]).join('; ');
  return res;
}
async function get(path) {
  const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'staff')")
    .run('sara@test.local', 'Sara', hashPassword('CorrectHorseBattery'));
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
    body: new URLSearchParams({ _csrf: token, email: 'sara@test.local', password: 'CorrectHorseBattery', next: '/' })
  }));
});

test.after(async () => {
  if (server) server.close();
  if (db) await db.close();
});

test('someone disabled while signed in is sent to sign in, not shown an error', async () => {
  assert.equal((await get('/')).status, 200, 'signed in to begin with');

  await db.prepare("UPDATE users SET active = 0 WHERE email = 'sara@test.local'").run();
  const res = await get('/');
  assert.equal(res.status, 302, 'this was a 500: the session was nulled, then read');
  assert.match(res.location, /\/login/);

  const page = await get('/login');
  assert.equal(page.status, 200, 'and the sign-in page itself still renders');
});
