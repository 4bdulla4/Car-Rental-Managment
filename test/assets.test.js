'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/db');

const app = require('../src/app');

let server;
let base;
test.before(async () => {
  await require('./helpers/db').reset();
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('pages link files with a release stamp', async () => {
  const html = await (await fetch(base + '/login')).text();
  assert.match(html, /href="\/css\/app\.css\?v=[a-z0-9]+"/);
  assert.match(html, /src="\/img\/logo-emblem\.png\?v=[a-z0-9]+"/);
  assert.doesNotMatch(html, /(href|src)="\/(css|js|img)\/[^"?]+"/, 'no file is linked without one');
});

test('a stamped file is kept for a year; anything else is re-checked soon', async () => {
  const html = await (await fetch(base + '/login')).text();
  const stamped = /href="(\/css\/app\.css\?v=[a-z0-9]+)"/.exec(html)[1];
  const kept = await fetch(base + stamped);
  assert.equal(kept.status, 200);
  assert.match(kept.headers.get('cache-control'), /max-age=31536000, immutable/);

  const stale = await fetch(base + '/css/app.css?v=an-old-release');
  assert.match(stale.headers.get('cache-control'), /max-age=300/, 'an old stamp is not cached for a year');
});

test('every response says how long the server spent on it', async () => {
  const res = await fetch(base + '/login');
  assert.match(res.headers.get('server-timing') || '', /^app;dur=\d+(\.\d+)?$/);
});
