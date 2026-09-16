'use strict';
const { round2 } = require('./money');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse a 'YYYY-MM-DD' string into a UTC-midnight timestamp. */
function dayStamp(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Billable days between two dates. A same-day rental still bills one day,
 * and any started day counts as a full day.
 */
function rentalDays(startDate, endDate) {
  const start = dayStamp(startDate);
  const end = dayStamp(endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(1, Math.round((end - start) / DAY_MS));
}

/** Quote shown before the handover contract is issued. */
function quote({ dailyRate, startDate, endDate, discount = 0, deposit = 0 }) {
  const days = rentalDays(startDate, endDate);
  const baseCharge = round2(days * Number(dailyRate || 0));
  const total = round2(baseCharge - Number(discount || 0));
  return {
    days,
    baseCharge,
    discount: round2(discount),
    total,
    deposit: round2(deposit),
    balanceDue: round2(total - Number(deposit || 0))
  };
}

/**
 * Final settlement produced when the car is handed back.
 * Late days, excess kilometres and missing fuel are derived automatically.
 */
function settlement(rental, ret, policy = {}) {
  const fuelChargePerEighth = Number(policy.fuelChargePerEighth ?? 0);
  const lateDayMultiplier = Number(policy.lateDayMultiplier ?? 1);

  const dailyRate = Number(rental.daily_rate || 0);
  const contractedDays = rentalDays(rental.start_date, rental.end_date);
  const actualDays = rentalDays(rental.start_date, ret.returnDate);
  const lateDays = Math.max(0, actualDays - contractedDays);
  const lateFee = round2(lateDays * dailyRate * lateDayMultiplier);

  const kmDriven = Math.max(0, Number(ret.returnOdometer || 0) - Number(rental.pickup_odometer || 0));
  const kmAllowed = Number(rental.km_allowance_per_day || 0) * contractedDays;
  // No allowance configured (0) means unlimited kilometres.
  const excessKm = kmAllowed > 0 ? Math.max(0, kmDriven - kmAllowed) : 0;
  const excessKmFee = round2(excessKm * Number(rental.excess_km_rate || 0));

  const fuelMissingEighths = Math.max(0, Number(rental.pickup_fuel || 0) - Number(ret.returnFuel || 0));
  const fuelFee = round2(fuelMissingEighths * fuelChargePerEighth);

  const baseCharge = round2(contractedDays * dailyRate);
  const damageCharge = round2(ret.damageCharge || 0);
  const otherCharges = round2(ret.otherCharges || 0);
  const discount = round2(rental.discount || 0);
  const deposit = round2(rental.deposit || 0);

  const total = round2(
    baseCharge + lateFee + excessKmFee + fuelFee + damageCharge + otherCharges - discount
  );

  return {
    contractedDays,
    actualDays,
    lateDays,
    lateFee,
    kmDriven,
    kmAllowed,
    excessKm,
    excessKmFee,
    fuelMissingEighths,
    fuelFee,
    baseCharge,
    damageCharge,
    otherCharges,
    discount,
    deposit,
    total,
    balanceDue: round2(total - deposit)
  };
}

/**
 * Quote for a rental row or form, using the database's column names.
 * Call this rather than quote() with a rental object: quote() takes camelCase
 * keys, and passing a snake_case row silently produces a zero total.
 */
function quoteRental(row) {
  return quote({
    dailyRate: row.daily_rate,
    startDate: row.start_date,
    endDate: row.end_date,
    discount: row.discount,
    deposit: row.deposit
  });
}

module.exports = { rentalDays, quote, quoteRental, settlement, dayStamp, DAY_MS };
