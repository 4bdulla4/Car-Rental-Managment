'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

// Production mode marks the session cookie Secure. Behind a TLS-terminating
// proxy (Railway, Render, Fly) the app itself receives plain HTTP, so Express
// must trust X-Forwarded-Proto or the cookie is refused and login fails.
process.env.NODE_ENV = 'production';

const app = require('../src/app');
const { hashPassword } = require('../src/lib/passwords');

let db;

test.before(async () => {
  db = await helper.reset();
  await db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,'admin')")
    .run('proxy@test.local', 'Proxy Test', hashPassword('CorrectHorseBattery'));
});

test.after(async () => { await db.close(); });

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function login(server, headers) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/login`, { headers });
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(await page.text())[1];
  const jar = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const body = new URLSearchParams({
    _csrf: token,
    email: 'proxy@test.local',
    password: 'CorrectHorseBattery',
    next: '/'
  });
  return fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
    body
  });
}

test('login succeeds behind a TLS-terminating proxy', async () => {
  const server = await listen();
  try {
    const res = await login(server, { 'x-forwarded-proto': 'https', host: 'app.example.com' });
    assert.equal(res.status, 302, 'expected a redirect, not a server error');
    assert.equal(res.headers.get('location'), '/');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('carrenter.sid='));
    assert.ok(cookie, 'session cookie was not set');
    assert.match(cookie, /secure/i, 'session cookie must be marked Secure in production');
    assert.match(cookie, /httponly/i, 'session cookie must be HttpOnly');
  } finally {
    server.close();
  }
});
