# Car Renter

A small rent-a-car management app: manage the fleet and customers, issue numbered
handover contracts, and close them with an automatically calculated settlement.

Built to stay small — Express, EJS, libSQL/SQLite and Node's built-in crypto. No
build step and no native modules. Requires **Node 20 or newer**.

## Quick start

```bash
npm install
cp .env.example .env     # then set DATABASE_URL and a password (see below)
npm run seed -- --demo   # creates the admin account + sample fleet
npm start
```

Locally the database is just a file — the default `DATABASE_URL=file:./data/car-renter.db`
needs nothing installed. In production point it at a [Turso](https://turso.tech)
database instead. The schema is created automatically on first start.

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
| `DATABASE_URL` | `file:./data/car-renter.db` locally, or a `libsql://` URL from Turso. Required |
| `DATABASE_AUTH_TOKEN` | Turso auth token. Only needed for a hosted database |
| `SESSION_SECRET` | Signs the session cookie. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `COMPANY_*` | Starting name, address, phone, email and registration number. Editable in **Settings**, where the stored value then wins |
| `CURRENCY` | Starting currency. Once changed in **Settings** the stored value wins |
| `FUEL_CHARGE_PER_EIGHTH` | Starting fuel charge per missing 1/8 tank. Editable in **Settings** |
| `LATE_DAY_MULTIPLIER` | Starting late-day multiplier. Editable in **Settings** |
| `DEFAULT_KM_ALLOWANCE` | Starting km included per day for a new car (0 = unlimited) |
| `DEFAULT_EXCESS_KM_RATE` | Starting excess km rate for a new car |
| `DEFAULT_DEPOSIT` | Starting security deposit pre-filled on a new rental |
| `DEFAULT_DISCOUNT` | Starting standing discount pre-filled on a new rental |
| `DEFAULT_DISCOUNT_MODE` | `amount` or `percent` |
| `DEFAULT_DAILY_RATE` | Starting daily rate pre-filled when a car is added |

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

The app keeps no state on disk in production, so it runs on serverless platforms as
well as ordinary servers. The database is [Turso](https://turso.tech), which is SQLite
over HTTP — a good fit for serverless, where a normal database connection pool
struggles.

### Set up the database

```bash
brew install tursodatabase/tap/turso   # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup
turso db create car-renter
turso db show car-renter --url          # DATABASE_URL
turso db tokens create car-renter       # DATABASE_AUTH_TOKEN
```

Already have a local `data/car-renter.db`? Turso can take it as the starting point:

```bash
turso db create car-renter --from-file data/car-renter.db
```

### Vercel

Import the repo at [vercel.com/new](https://vercel.com/new), choose the **Other**
preset, and add these under **Settings → Environment Variables**:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the `libsql://...` URL |
| `DATABASE_AUTH_TOKEN` | the token |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SEED_ADMIN_EMAIL` | your email |
| `SEED_ADMIN_PASSWORD` | a strong password |

Then redeploy — Vercel does not pick up variable changes on its own. On the first
request the app creates its schema and the admin account, logging the email only.
Sign in, change the password under **Users → Reset password**, then delete
`SEED_ADMIN_PASSWORD`.

A deployment missing `DATABASE_URL` or `SESSION_SECRET` serves a page naming exactly
what is missing rather than failing with an opaque error.

`vercel.json` routes every path to `api/index.js`, which exports the Express app.
Sessions are signed cookies, so there is no session store to configure, and the app
trusts the platform's `X-Forwarded-Proto` so the cookie can be marked `Secure`.

### Anywhere else

Railway, Render, Fly.io and a plain VPS work the same way: set `DATABASE_URL` and
`SESSION_SECRET`, then run `npm start`. With a persistent disk you can keep using a
`file:` database instead of Turso.

## Daily rate

**Settings → Daily rate** only pre-fills the form when you add a car; it is not a
fleet-wide price. The rate that applies lives on each car, and is copied onto a rental
when the contract is issued, so changing the default never touches an existing car or
contract. To change what a car actually costs, edit that car under **Fleet**.

## Discount

**Settings → Discount** sets a standing discount pre-filled on new rentals, either as
a fixed amount or as a percentage of the rental charge. A percentage is worked out
once the car and dates are chosen, and stops updating the moment staff type their own
figure, so a manual discount is never overwritten.

Whichever mode is used, the contract records a **fixed amount** — a percentage is only
a convenience for arriving at it, so the agreement is never ambiguous about what was
taken off. A discount larger than the rental charge is rejected, since it would
produce a negative total.

## Deposit

**Settings → Deposit** sets the security deposit pre-filled on the New rental form.
Staff can still change it on any individual contract, so it is a starting point rather
than a fixed rule. Set it to 0 if you do not normally take a deposit.

The deposit is held at handover and offset against the final settlement when the car
comes back; if it exceeds the total, the return sheet shows a refund. Each rental
stores the deposit it was issued with, so changing the default never alters an
existing contract.

## Mileage

The km included per day and the excess km rate are set in three places, most general
first:

1. **Settings → Mileage defaults** — what a newly added car starts with
2. **The car** — each car can be tuned individually on its edit page
3. **The rental** — the car's terms are copied onto the contract when it is issued

Changing the default only affects cars added afterwards. To push it across the fleet
as well, tick **Also apply to all existing cars** when saving; that rewrites every
car, but never a contract. An allowance of 0 means unlimited mileage, and is stored
as a real value rather than treated as unset.

## Return charges

The fuel charge per 1/8 tank and the late-day multiplier are edited under **Settings**,
with a worked example showing the effect before you save. The `FUEL_CHARGE_PER_EIGHTH`
and `LATE_DAY_MULTIPLIER` env vars only seed the initial values.

These are contract terms — they are printed on the handover agreement the customer
signs — so each rental records the rates it was issued under and is always settled
against those. Raising the fuel charge today never re-prices a car that was rented
last week, and reprinting an old contract still shows the rates that were agreed.
New rentals use the current rates.

## Company details

An admin edits the company details under **Settings → Company**: name, address, phone,
email, website, registration number, VAT number, a bank account or IBAN, and a one-line
footer note. They appear in the header of every handover contract and return sheet, and
the name is used throughout the UI. A live preview shows the header as it will print.
The `COMPANY_*` env vars only seed the initial values.

The numbered **contract terms** are edited on the same tab, one clause per line. Leave
the box empty to use the standard ten. Write `{company}` where the company name should
appear, and any numbering you type is stripped so the contract numbers them itself.

Unlike the currency, these are not snapshotted per contract — reprinting an old
contract shows your current details. That is usually what you want for a rename or a
move, but if you need a reprint to match exactly what was signed, say so and the
details can be stored per rental the way the currency is.

## Currency

An admin can change the currency under **Settings**. Any 2–5 letter code works; the
common ones are offered in a picker. `CURRENCY` in `.env` only sets the starting
value — once changed in the app, the stored setting takes over.

Each rental records the currency it was issued in. Changing the currency applies to
new rentals only: contracts already issued keep their original code, so a signed
agreement never silently changes meaning, and a printed document is never a mix of
two currencies. Because of that a list can legitimately show more than one code, and
closed revenue on the dashboard is grouped per currency rather than summed across
them. Amounts always use two decimal places.

If a figure still shows an old code after you switch, that is a contract issued
before the change rather than a bug, and the dashboard and rentals list say so. When
the old code was simply a setup mistake, **Settings → Currency** offers a one-off
"relabel" for each old code. It rewrites the code on those contracts and nothing
else: amounts are never converted, because no exchange rate is involved.

## Branding

The car logo lives in two places, both plain SVG you can edit by hand:
`public/logo.svg` (favicon) and `views/partials/logo.ejs` (the inline version used in
the sidebar, login page and printed contracts). The accent colour and the rest of the
palette are CSS variables at the top of `public/css/app.css`; `COMPANY_NAME` in `.env`
sets the wordmark.

## Dashboard

The dashboard answers what needs doing today. Six counts across the top — cars
available, on rent, due back today, overdue, off the road, customers — each linking to
the list it summarises.

**Still out** lists every car not yet back, soonest due first, each row marked Overdue
or Today with a Return button beside it. **Revenue** reports this month and all time,
grouped per currency. **Recently closed** shows the last settlements, and **Licences to
chase** the customers whose licence expires within thirty days, so it is renewed before
it blocks a booking.

## Rentals and the fleet

Both lists open with counts that double as filters. **Rentals** shows open contracts,
how many are due back today, how many are overdue and how many are closed, and sorts
open contracts first with the soonest due at the top — so the work of the day is the
first thing on screen. Each row marks Overdue or Due today.

**Fleet** shows cars in the fleet, available, on rent, and off the road. A car that is
out names the contract it is on and when it is due back, flagged if that date has
passed, and its Rent button is disabled until it comes back. Each row also carries how
many rentals the car has done.

## Customers

The list shows counts across the top — total, how many are renting right now, and whose
licence expires within 30 days or already has. Each count is a filter: click it to see
only those customers.

Every row carries the licence expiry with its standing, so an expired one is obvious
before a booking is attempted rather than after the rental form rejects it — and the
Rent button on that row is disabled until the licence is renewed. A customer with
contracts on file cannot be deleted, since the contracts name them.

## Settings

Settings is split into four tabs: **Company**, **Currency**, **Pricing** (daily rate,
deposit, discount) and **Charges** (return charges, mileage defaults). Switching is
instant and the tab is kept in the address bar, so saving a form returns you to the
tab you were on rather than the top of the page.

## Users

**Users** (admins only) shows the accounts at a glance — total, admins, staff and
disabled — with a search box and a Create user button that opens the form on demand.

A role is changed from the dropdown on its row. An account can be disabled, which keeps
its history but stops it signing in, or deleted outright. Deleting is refused for an
account that has issued contracts, because each contract records who issued it; disable
those instead. You cannot change your own role, disable yourself, or delete yourself —
which is what guarantees an admin always remains.

## Changing your own password

Every signed-in user has **My account** (the name at the bottom of the sidebar), where
they set their own password. It asks for the current one first, so a session left open
on a shared machine cannot be used to lock the owner out of their own account.

An administrator can still reset a password from **Users**, but cannot see it. Note that
changing a password does not end sessions already signed in elsewhere.

## Locked out

Changing `SEED_ADMIN_PASSWORD` does not reset an account that already exists — otherwise
a stale variable would quietly undo a password changed in the app. If the password is
genuinely lost, set `SEED_ADMIN_RESET=1` alongside `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` and redeploy: the account's password is reset on the next request
and the account re-enabled.

**Remove the variable afterwards.** While it is set, every deploy resets that password.

## Accounts

Two roles. **Admin** manages users; **staff** manage fleet, customers and contracts.
Passwords are hashed with scrypt, sessions are signed HTTP-only cookies, all forms carry
CSRF tokens, and repeated failed logins are throttled per email address.

## Tests

```bash
npm test
```

No database service is needed: each test file gets its own temporary libSQL file.

Covers the pricing and settlement rules (day counting, late fees, excess mileage,
unlimited mileage, fuel charges, refunds, rounding), the settings and their
per-contract snapshots, sign-in behind a TLS-terminating proxy, and that a currency
change reaches every page.

## Layout

```
api/index.js    (Vercel entry point)
src/
  app.js server.js config.js db.js seed.js
  lib/        pricing.js  money.js  passwords.js  contracts.js
  middleware/ auth.js     (session, roles, CSRF)
  routes/     auth  dashboard  cars  customers  rentals  users
views/
  contracts/  handover.ejs  receipt.ejs   (printable A4 documents)
test/         pricing.test.js
```

## Notes

Single-company by design — every signed-in user sees the same fleet. To run it for
several companies, add a `company_id` to each table and scope every query by the
signed-in user's company.
