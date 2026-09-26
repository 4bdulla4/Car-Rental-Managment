'use strict';
/**
 * The agreement, frozen at the moment it was issued.
 *
 * The rest of the settings already work this way — a contract records the
 * currency, the fuel rate and the mileage terms it was written under, so a
 * later change of policy cannot re-price it. The words were the exception: the
 * clauses and the lessor's own details were read live, which meant editing the
 * standard terms silently rewrote every agreement ever issued, signed ones
 * included. That is the one change a signature cannot survive.
 *
 * So the wording is captured with the contract and read back from there. Older
 * contracts, issued before this was recorded, fall back to the live settings —
 * the best that can be done for them, and no worse than before.
 */
const settings = require('./settings');
const termsLib = require('./terms');

/** What the agreement says today, ready to be stored on a new contract. */
function capture() {
  const company = settings.company();
  const agreement = settings.contract();
  return {
    // The lessor as it was when the contract was written: a company that later
    // renames or moves has not thereby changed an agreement it already signed.
    company: { ...company },
    agreement: { deductible: agreement.deductible, returnLocation: agreement.returnLocation, governingLaw: agreement.governingLaw },
    terms: termsLib.forCompany(settings.termsText(), company.name)
  };
}

const serialise = () => JSON.stringify(capture());

/** What a given contract says: its own wording if it has any, else today's. */
function restore(rental) {
  if (rental && rental.contract_snapshot) {
    try {
      const saved = JSON.parse(rental.contract_snapshot);
      if (saved && saved.company && Array.isArray(saved.terms)) {
        return { ...saved, frozen: true };
      }
    } catch {
      // A damaged snapshot falls back rather than taking the contract down.
    }
  }
  return { ...capture(), frozen: false };
}

module.exports = { capture, serialise, restore };
