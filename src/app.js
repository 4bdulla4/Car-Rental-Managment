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
const { ensureFirstAdmin, ensureSampleData } = require('./lib/bootstrap');

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
  if (!bootstrapped) bootstrapped = db.ready().then(() => ensureFirstAdmin()).then(() => ensureSampleData());
  return bootstrapped;
};

// A deployment missing its configuration explains itself rather than 500ing.
app.use((req, res, next) => {
  const missing = config.missingConfig();
  if (!missing.length) return next();
  res.status(503).render('setup', {
    title: 'Setup needed',
    company: config.company,
    missing,
    currency: config.currency,
    csrfToken: '',
    flash: null,
    currentUser: null,
    path: req.path
  });
});

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
  res.locals.accent = settings.accent();
  res.locals.theme = req.session.theme === 'light' ? 'light' : 'dark';
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
app.use('/reports', require('./routes/reports'));
app.use('/users', require('./routes/users'));
app.use('/settings', require('./routes/settings'));
app.use('/sign', require('./routes/sign'));
app.use('/account', require('./routes/account'));

// Open to anyone, including the sign-in page, so the switch works before login.
app.post('/theme', (req, res) => {
  req.session.theme = req.body.theme === 'light' ? 'light' : 'dark';
  const next = String(req.body.next || '/');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
});

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);

  // A failure during start-up happens before the view locals are set, so they
  // are filled in here; otherwise rendering the error page would itself throw
  // and Express would fall back to a bare "Internal Server Error".
  res.locals.company = res.locals.company || config.company;
  res.locals.currency = res.locals.currency || config.currency;
  res.locals.currentUser = res.locals.currentUser || null;
  res.locals.csrfToken = res.locals.csrfToken || '';
  res.locals.flash = res.locals.flash || null;
  res.locals.path = req.path;
  res.locals.money = res.locals.money || ((v) => String(v));
  res.locals.accent = res.locals.accent || require('./lib/theme').get();
  res.locals.theme = res.locals.theme || 'dark';
  res.locals.fuelLabel = res.locals.fuelLabel || (() => '');
  res.locals.FUEL_LABELS = res.locals.FUEL_LABELS || [];

  // The useful part of a libSQL failure is in the error's name and code, not
  // only its message, so all three are examined.
  const text = err
    ? `${err.name || ''} ${err.code || ''} ${err.message || err}`
    : String(err);
  const databaseProblem =
    /libsql|sqlite|server_error|unauthorized|forbidden|401|403|404|econnrefused|enotfound|fetch failed|auth token/i
      .test(text);

  // The database's own HTTP status says which of the two settings is wrong, and
  // neither the URL nor the token is revealed by reporting it.
  const status = (/HTTP status (\d{3})/.exec(text) || [])[1];
  const diagnosis = {
    404: 'The database was not found at that address, so DATABASE_URL points at a database that does not exist. Check it with: turso db list',
    401: 'The database rejected the credentials, so DATABASE_AUTH_TOKEN is wrong or expired. Issue a new one with: turso db tokens create <database>',
    403: 'The database rejected the credentials, so DATABASE_AUTH_TOKEN is wrong or expired. Issue a new one with: turso db tokens create <database>'
  }[status];

  const message = databaseProblem
    ? (diagnosis || 'The app could not reach its database. Check DATABASE_URL and DATABASE_AUTH_TOKEN for this environment.') +
      ' Remember to redeploy after changing a variable — Vercel does not apply them to the running deployment.'
    : 'Something went wrong handling that request. Your host\'s runtime logs have the details.';

  res.status(500).render(
    'error',
    { title: databaseProblem ? 'Database unavailable' : 'Something went wrong', message },
    (renderErr, html) => {
      if (renderErr) {
        console.error('Could not render the error page:', renderErr);
        res.type('text/plain').send(message);
        return;
      }
      res.send(html);
    }
  );
});

module.exports = app;
