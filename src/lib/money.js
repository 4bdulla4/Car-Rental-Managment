'use strict';

/** Round to 2 decimals without float drift (e.g. 1.005 -> 1.01). */
function round2(value) {
  const n = Number(value) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatMoney(value, currency) {
  const n = round2(value);
  const fixed = Math.abs(n).toFixed(2);
  const [whole, decimals] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}${grouped}.${decimals} ${currency}`;
}

module.exports = { round2, formatMoney };
