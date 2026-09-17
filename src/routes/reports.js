'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
const { requireAuth } = require('../middleware/auth');
const { round2 } = require('../lib/money');
const charts = require('../lib/charts');

const router = express.Router();
router.use(requireAuth);

const PERIODS = {
  month: { label: 'This month', months: 0 },
  quarter: { label: 'Last 3 months', months: 3 },
  year: { label: 'This year', months: 0 },
  all: { label: 'All time', months: 0 }
};

/** The closed_at range for a period, as the text dates the column stores. */
function range(period) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (period === 'quarter') {
    const from = new Date(now);
    from.setMonth(from.getMonth() - 2);
    return { from: iso(from).slice(0, 8) + '01', to: null };
  }
  if (period === 'year') return { from: iso(now).slice(0, 4) + '-01-01', to: null };
  if (period === 'all') return { from: null, to: null };
  return { from: iso(now).slice(0, 8) + '01', to: null };
}

router.get('/', async (req, res) => {
  const period = Object.prototype.hasOwnProperty.call(PERIODS, req.query.period) ? req.query.period : 'year';
  const { from } = range(period);
  const currency = settings.currency();

  // Reports cover one currency: totals in different currencies cannot be added.
  const where = ["r.status = 'closed'", 'r.currency = ?'];
  const params = [currency];
  if (from) {
    where.push('r.closed_at >= ?');
    params.push(from);
  }
  const clause = where.join(' AND ');

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS contracts,
              COALESCE(SUM(total_amount), 0) AS revenue,
              COALESCE(SUM(base_charge), 0) AS base,
              COALESCE(SUM(late_fee), 0) AS late,
              COALESCE(SUM(excess_km_fee), 0) AS excess,
              COALESCE(SUM(fuel_fee), 0) AS fuel,
              COALESCE(SUM(damage_charge), 0) AS damage,
              COALESCE(SUM(other_charges), 0) AS other,
              COALESCE(SUM(discount), 0) AS discount,
              COALESCE(AVG(julianday(end_date) - julianday(start_date)), 0) AS avg_days
       FROM rentals r WHERE ${clause}`
    )
    .get(...params);

  const byMonth = await db
    .prepare(
      `SELECT substr(r.closed_at, 1, 7) AS month, SUM(r.total_amount) AS total, COUNT(*) AS n
       FROM rentals r WHERE ${clause}
       GROUP BY month ORDER BY month`
    )
    .all(...params);

  const byCar = await db
    .prepare(
      `SELECT c.plate, c.make, c.model, SUM(r.total_amount) AS total, COUNT(*) AS n
       FROM rentals r JOIN cars c ON c.id = r.car_id
       WHERE ${clause}
       GROUP BY c.id ORDER BY total DESC LIMIT 8`
    )
    .all(...params);

  // Other currencies are reported separately rather than folded in.
  const otherCurrencies = await db
    .prepare(
      `SELECT currency, COUNT(*) AS n FROM rentals
       WHERE status = 'closed' AND currency <> ? GROUP BY currency`
    )
    .all(currency);

  const contracts = Number(totals.contracts) || 0;
  const revenue = round2(totals.revenue);

  const monthLabel = (m) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  res.render('reports/index', {
    title: 'Reports',
    period,
    periods: PERIODS,
    currency,
    otherCurrencies,
    stats: {
      revenue,
      contracts,
      average: contracts ? round2(revenue / contracts) : 0,
      avgDays: contracts ? Math.max(1, Math.round(Number(totals.avg_days))) : 0
    },
    monthChart: charts.columns(
      byMonth.map((m) => ({ label: monthLabel(m.month), value: Number(m.total) || 0, n: Number(m.n) })),
      { width: 720, height: 210 }
    ),
    carChart: charts.bars(
      byCar.map((c) => ({
        label: c.plate,
        sub: `${c.make} ${c.model}`,
        value: Number(c.total) || 0,
        n: Number(c.n)
      })),
      { width: 720 }
    ),
    breakdown: charts.stack(
      [
        { key: 'rental', label: 'Rental charge', value: round2(totals.base) },
        { key: 'late', label: 'Late returns', value: round2(totals.late) },
        { key: 'excess', label: 'Excess mileage', value: round2(totals.excess) },
        { key: 'fuel', label: 'Missing fuel', value: round2(totals.fuel) },
        { key: 'other', label: 'Damage & other', value: round2(Number(totals.damage) + Number(totals.other)) }
      ],
      { width: 720 }
    ),
    discount: round2(totals.discount)
  });
});

module.exports = router;
