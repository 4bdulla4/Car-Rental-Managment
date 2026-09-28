'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./helpers/db');

const sample = require('../src/lib/sample-data');
const settings = require('../src/lib/settings');
const { ensureDemoRemoved } = require('../src/lib/bootstrap');

let db;
const count = async (table) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);

test.before(async () => {
  db = await helper.reset();
  await db.prepare('DELETE FROM activity_log').run();
  await settings.load();
  await sample.load();
  // The earlier demo set, plus a real car that must survive.
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('RUH-4412','Toyota','Corolla',150)").run();
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('REAL-1','Lexus','ES',400)").run();
});
test.after(async () => { delete process.env.REMOVE_DEMO_DATA; if (db) await db.close(); });

test('nothing happens unless the deployment asks for it', async () => {
  delete process.env.REMOVE_DEMO_DATA;
  assert.equal(await ensureDemoRemoved(), false);
  assert.ok((await sample.demoSummary()).any, 'the demo is still there');
});

test('with REMOVE_DEMO_DATA set, the demo goes and real records stay', async () => {
  process.env.REMOVE_DEMO_DATA = '1';
  assert.equal(await ensureDemoRemoved(), true);
  assert.equal((await sample.demoSummary()).any, false);
  assert.equal(await count('cars'), 1);
  assert.ok(await db.prepare("SELECT 1 FROM cars WHERE plate = 'REAL-1'").get());
  const log = await db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1').get();
  assert.match(log.detail, /Removed 7 demo cars/, 'the owner can see what was removed');
});

test('it runs once: a variable left set does not keep deleting', async () => {
  // A car added later under a demo plate must not vanish on the next start.
  await db.prepare("INSERT INTO cars (plate, make, model, daily_rate) VALUES ('RUH-7781','Hyundai','Elantra',165)").run();
  assert.equal(await ensureDemoRemoved(), false);
  assert.ok(await db.prepare("SELECT 1 FROM cars WHERE plate = 'RUH-7781'").get());
});

test('SET_ACCENT applies once, and a later choice in Settings stands', async () => {
  const { ensureAccent } = require('../src/lib/bootstrap');
  process.env.SET_ACCENT = 'chrome';
  await settings.set('accent', 'teal');
  assert.equal(await ensureAccent(), true);
  await settings.load();
  assert.equal(settings.get('accent'), 'chrome');

  await settings.set('accent', 'rose');            // someone picks another in Settings
  assert.equal(await ensureAccent(), false, 'a variable left set does not override it');
  await settings.load();
  assert.equal(settings.get('accent'), 'rose');

  process.env.SET_ACCENT = 'neon';                 // not an accent: ignored
  assert.equal(await ensureAccent(), false);
  delete process.env.SET_ACCENT;
});
