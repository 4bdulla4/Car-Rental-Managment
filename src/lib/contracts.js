'use strict';

/** Sequential, human-readable contract number: RC-2026-0007 */
async function nextContractNo(runner, date = new Date()) {
  const year = date.getFullYear();
  const prefix = `RC-${year}-`;
  const row = await runner
    .prepare('SELECT COUNT(*) AS n FROM rentals WHERE contract_no LIKE ?')
    .get(prefix + '%');
  let seq = Number(row.n) + 1;
  // Guard against gaps left by deleted rows so the UNIQUE index never trips.
  while (await runner.prepare('SELECT 1 FROM rentals WHERE contract_no = ?').get(prefix + String(seq).padStart(4, '0'))) {
    seq += 1;
  }
  return prefix + String(seq).padStart(4, '0');
}

const FUEL_LABELS = ['Empty', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8', 'Full'];
const fuelLabel = (eighths) => FUEL_LABELS[Math.max(0, Math.min(8, Number(eighths) || 0))];

module.exports = { nextContractNo, fuelLabel, FUEL_LABELS };
