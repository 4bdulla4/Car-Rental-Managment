'use strict';
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./config');
const { loadUser, csrf } = require('./middleware/auth');
const { formatMoney } = require('./lib/money');
const { fuelLabel, FUEL_LABELS } = require('./lib/contracts');
const settings = require('./lib/settings');
const db = require('./db');
const { ensureFirstAdmin } = require('./lib/bootstrap');

const app = express();

// Hosts like Railway, Render and Fly terminate TLS at the edge and forward plain
// HTTP, so Express must trust X-Forwarded-Proto. Without this the Secure session
// cookie below is refused and every sign-in fails. See test/session.test.js.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));

app.use(
  cookieSession({
    name: 'carrenter.sid',
    keys: [config.sessionSecret],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  })
);

// Schema and first-admin creation happen once per process, before any request is
// served. On serverless this runs on a cold start; afterwards it is a no-op.
let bootstrapped = null;
const bootstrap = () => {
  if (!bootstrapped) bootstrapped = db.ready().then(() => ensureFirstAdmin());
  return bootstrapped;
};

app.use(async (req, res, next) => {
  try {
    await bootstrap();
    await settings.load();
    next();
  } catch (err) {
    bootstrapped = null;
    next(err);
  }
});

app.use(loadUser);

// View locals must be in place before csrf, which can itself render the error page.
app.use((req, res, next) => {
  // Flash messages survive exactly one redirect.
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) req.session.flash = null;
  res.locals.company = settings.company();
  const activeCurrency = settings.currency();
  res.locals.currency = activeCurrency;
  res.locals.money = (v) => formatMoney(v, activeCurrency);
  // For records that carry their own currency, such as an issued contract.
  res.locals.moneyIn = (v, code) => formatMoney(v, code || activeCurrency);
  res.locals.fuelLabel = fuelLabel;
  res.locals.FUEL_LABELS = FUEL_LABELS;
  res.locals.path = req.path;
  res.locals.title = 'Car Renter';
  next();
});

app.use(csrf);


app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/cars', require('./routes/cars'));
app.use('/customers', require('./routes/customers'));
app.use('/rentals', require('./routes/rentals'));
app.use('/users', require('./routes/users'));
app.use('/settings', require('./routes/settings'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Something went wrong',
    message: err.message || 'Unexpected error.'
  });
});

module.exports = app;
