'use strict';
/** One rental with its car, customer and issuer, as every rental page needs it. */
const db = require('../db');
const lessee = require('./lessee');

const RENTAL_SELECT = `
  SELECT r.*,
         c.plate, c.make, c.model, c.year, c.color, c.vin, c.transmission, c.seats,
         cu.full_name, cu.phone, cu.email, cu.id_number, cu.license_number, cu.license_expiry, cu.address,
         cu.emergency_name, cu.emergency_phone,
         u.name AS issued_by
  FROM rentals r
  JOIN cars c ON c.id = r.car_id
  JOIN customers cu ON cu.id = r.customer_id
  LEFT JOIN users u ON u.id = r.created_by`;

/** The rental, with the Lessee as frozen at signing laid over the live record. */
async function findRental(id) {
  return lessee.overlay(await db.prepare(`${RENTAL_SELECT} WHERE r.id = ?`).get(Number(id)));
}

module.exports = { RENTAL_SELECT, findRental };
