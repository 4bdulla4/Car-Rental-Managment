# Car Renter

A small rent-a-car management app: manage the fleet and customers, issue numbered
handover contracts, and close them with an automatically calculated settlement.

Built to stay small — Node's built-in SQLite and crypto, Express, EJS. Four npm
dependencies, no build step, no native modules. Requires **Node 24 or newer**
(`node:sqlite` needs a runtime flag on older versions).

## Quick start

```bash
npm install
cp .env.example .env     # then edit it (see below)
npm run seed -- --demo   # creates the admin account + sample fleet
npm start
```

Open http://localhost:3210.

`npm run seed` reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`. If the
password is missing it prompts for one without echoing it. Drop `--demo` if you do
not want the sample cars and customers.

> **First thing to do:** sign in, go to **Users → Reset**, set your own password, then
> delete the `SEED_ADMIN_PASSWORD` line from `.env`.

## Configuration (`.env`)

| Key | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3210) |
| `SESSION_SECRET` | Signs the session cookie. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `COMPANY_*` | Name, address, phone, email and registration number printed on contracts |
| `CURRENCY` | Currency label shown throughout (default `SAR`) |
| `FUEL_CHARGE_PER_EIGHTH` | Charged per missing 1/8 tank at return |
| `LATE_DAY_MULTIPLIER` | Late days bill at daily rate × this (default 1.25) |

`.env` and the database in `data/` are gitignored. Never commit real credentials.

## How it works

**Fleet** — each car carries its own daily rate, mileage allowance, excess-km rate,
odometer and fuel level. Status is one of `available`, `rented`, `maintenance`,
`retired`. A car with rental history can't be deleted, only retired.

**Customers** — name, phone, ID/passport, licence number and expiry. The app blocks a
rental if the licence expires before the rental ends.

**Rentals** — picking a car copies its rate, mileage policy, odometer and fuel onto the
contract, so later changes to the car never rewrite past contracts. Saving issues a
sequential number (`RC-2026-0001`), marks the car `rented`, and opens the printable
handover agreement: renter and vehicle details, period and charges, accessory
checklist, pre-existing damage, ten standard terms, and signature blocks. It prints to
one A4 page — use the browser's Print / Save as PDF.

**Return** — enter the return date, odometer and fuel. The settlement is derived
automatically:

| Line | Rule |
| --- | --- |
| Rental charge | contracted days × daily rate |
| Late return | days past the end date × daily rate × `LATE_DAY_MULTIPLIER` |
| Excess mileage | km driven beyond `allowance × contracted days`, × excess rate (0 allowance = unlimited) |
| Missing fuel | eighths below the pickup level × `FUEL_CHARGE_PER_EIGHTH` |
| Damage / other | entered by staff |
| Balance | total − deposit (negative means refund) |

The figures update live as you type, then the server recomputes them — the server
value is what gets stored. Closing the contract releases the car back to the fleet with
its new odometer and fuel reading, and produces the printable return & settlement sheet.

A day is counted as any started day, and a rental always bills at least one day.

## Deploying

The app keeps its data in a SQLite file, so it needs a host that gives it a
**persistent disk**. Railway, Render and Fly.io all do. It will *not* work on
serverless platforms such as Vercel, where the filesystem is read-only and wiped
between invocations — there the database would vanish seconds after each write.

### Railway

```bash
npm i -g @railway/cli
railway login
railway init                      # or: railway link, to attach to an existing project
railway volume add -m /data       # persistent disk for the SQLite file
```

Set the variables. `DB_FILE` must point inside the volume — that is what makes
the data survive restarts and redeploys:

```bash
railway variable set \
  NODE_ENV=production \
  DB_FILE=/data/car-renter.db \
  SEED_ADMIN_EMAIL=you@yourcompany.com \
  COMPANY_NAME="Your Company" \
  CURRENCY=SAR
```

Set the two secrets from stdin so they never land in your shell history:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  | railway variable set --stdin SESSION_SECRET
```

```bash
railway variable set --stdin SEED_ADMIN_PASSWORD
```

Then deploy and get the URL:

```bash
railway up
railway domain
```

On first boot the app creates the admin account from `SEED_ADMIN_*` and logs the
email only, never the password. Sign in, change it under **Users → Reset
password**, then remove the variable:

```bash
railway variable delete SEED_ADMIN_PASSWORD
```

Seeding is skipped on every later boot because a user already exists.

`PORT` is supplied by the platform — do not set it. In production the app
refuses to start without `SESSION_SECRET`, and trusts the proxy's
`X-Forwarded-Proto` so the session cookie can be marked `Secure`.

## Branding

The car logo lives in two places, both plain SVG you can edit by hand:
`public/logo.svg` (favicon) and `views/partials/logo.ejs` (the inline version used in
the sidebar, login page and printed contracts). The accent colour and the rest of the
palette are CSS variables at the top of `public/css/app.css`; `COMPANY_NAME` in `.env`
sets the wordmark.

## Accounts

Two roles. **Admin** manages users; **staff** manage fleet, customers and contracts.
Passwords are hashed with scrypt, sessions are signed HTTP-only cookies, all forms carry
CSRF tokens, and repeated failed logins are throttled per email address.

## Tests

```bash
npm test
```

Covers the pricing and settlement rules — day counting, late fees, excess mileage,
unlimited mileage, fuel charges, refunds and rounding.

## Layout

```
src/
  app.js server.js config.js db.js seed.js
  lib/        pricing.js  money.js  passwords.js  contracts.js
  middleware/ auth.js     (session, roles, CSRF)
  routes/     auth  dashboard  cars  customers  rentals  users
views/
  contracts/  handover.ejs  receipt.ejs   (printable A4 documents)
test/         pricing.test.js
data/         car-renter.db (gitignored)
```

## Notes

Single-company by design — every signed-in user sees the same fleet. To run it for
several companies, add a `company_id` to each table and scope every query by the
signed-in user's company.
