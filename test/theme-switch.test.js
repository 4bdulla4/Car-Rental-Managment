'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/db');

const app = require('../src/app');

let server;
let base;
let jar = '';
const absorb = (res) => {
  const c = res.headers.getSetCookie();
  if (c.length) jar = c.map((x) => x.split(';')[0]).join('; ');
  return res;
};
const get = async (path) => {
  const res = absorb(await fetch(base + path, { headers: { cookie: jar }, redirect: 'manual' }));
  return { status: res.status, body: await res.text() };
};

test.before(async () => {
  await require('./helpers/db').reset();
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('both themes are already in the page, so switching needs no reload', async () => {
  const page = await get('/login');
  assert.match(page.body, /:root \{\s*--accent:/, 'dark values');
  assert.match(page.body, /:root\[data-theme="light"\] \{\s*--accent:/, 'and light values, side by side');
  assert.match(page.body, /class="to-light"/);
  assert.match(page.body, /class="to-dark"/, 'both labels are in the button');
  assert.match(page.body, /\/js\/theme\.js/);
});

test('a background save answers with nothing, and the choice sticks', async () => {
  const page = await get('/login');
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body)[1];
  const res = absorb(await fetch(base + '/theme', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded', 'x-theme-switch': '1' },
    body: new URLSearchParams({ _csrf: token, theme: 'light', next: '/login' })
  }));
  assert.equal(res.status, 204, 'no page is sent back for a switch the page has already made');

  const again = await get('/login');
  assert.match(again.body, /<html lang="en" data-theme="light">/, 'the next page load remembers it');
});

test('without JavaScript the form still works the old way', async () => {
  const page = await get('/login');
  const token = /name="_csrf" value="([a-f0-9]+)"/.exec(page.body)[1];
  const res = absorb(await fetch(base + '/theme', {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, theme: 'dark', next: '/login' })
  }));
  assert.equal(res.status, 302);
});

test('paper stays light whatever the screen is set to', async () => {
  const { renderFile } = require('ejs');
  const theme = require('../src/lib/theme');
  const html = await renderFile('views/partials/accent-vars.ejs', { accent: theme.get(), theme: 'light', fixed: true });
  assert.doesNotMatch(html, /data-theme/, 'one block only');
  assert.match(html, new RegExp(`--accent: ${theme.get().deep}`), 'and it is the light one');
});
