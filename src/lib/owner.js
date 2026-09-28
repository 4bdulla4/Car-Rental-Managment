'use strict';
/**
 * The owner: the one account that can see into every other.
 *
 * Ownership is read from the deployment's environment, never from the
 * database. A flag in the users table could be set by anyone who can edit that
 * table through the app — an admin could make themselves owner — whereas the
 * environment is controlled by whoever controls the deployment, who can already
 * do anything. So the power sits exactly where the power already was.
 *
 * OWNER_EMAIL names the owner; without it, the account created from
 * SEED_ADMIN_EMAIL is the owner, which on a fresh install is the first admin.
 */
function ownerEmail() {
  return String(process.env.OWNER_EMAIL || process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
}

const isOwnerEmail = (email) => Boolean(ownerEmail()) && String(email || '').trim().toLowerCase() === ownerEmail();

const isOwner = (user) => Boolean(user && user.active !== 0 && isOwnerEmail(user.email));

module.exports = { ownerEmail, isOwnerEmail, isOwner };
