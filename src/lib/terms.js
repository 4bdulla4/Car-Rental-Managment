'use strict';

/**
 * Clauses printed on the handover contract when none have been set in Settings.
 * `{company}` is replaced with the company name.
 */
const DEFAULT_TERMS = [
  'The renter confirms receipt of the vehicle in the condition recorded above and holds a valid driving licence.',
  'Only the named renter may drive the vehicle. Any additional driver must be registered with {company} in writing.',
  'The vehicle may not be used for racing, towing, off-road driving, subletting, or for carrying passengers or goods for hire.',
  'Driving under the influence of alcohol or drugs voids all insurance cover and makes the renter fully liable.',
  "Traffic fines, tolls and parking violations during the rental period are the renter's responsibility and may be charged after return.",
  'The vehicle must be returned on the agreed date with the same fuel level and all accessories listed above.',
  'The security deposit is refunded after inspection, less any charges for damage, excess mileage, missing fuel, fines or late return.',
  'In the event of an accident the renter must notify {company} and the police immediately and obtain an official report.',
  'The renter is liable for the insurance excess on any damage caused during the rental period.',
  'This agreement is governed by the laws applicable at the place of issue.'
];

/** One clause per line; blank lines are ignored. */
function parse(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

/** The clauses to print, with {company} resolved. */
function forCompany(stored, companyName) {
  const clauses = parse(stored);
  const list = clauses.length ? clauses : DEFAULT_TERMS;
  return list.map((c) => c.replace(/\{company\}/g, companyName));
}

module.exports = { DEFAULT_TERMS, parse, forCompany };
