import { createRequire } from 'node:module';

// require() of JSON is reliably bundled/traced by Vercel and keeps these files
// out of the public (statically served) directory, so contacts + drafts stay
// behind the password gate.
const require = createRequire(import.meta.url);

export const DATA = require('../data.json');

// Initial statuses imported from the exported CSV (hyde_status.csv).
// Saved edits in Redis are layered on top of this.
export const SEED = require('../seed.json');

export function contactByCompany(company) {
  return DATA.contacts.find((c) => c.company === company) || null;
}

export function placementFor(contact) {
  if (!contact || !contact.placement) return null;
  return DATA.placements?.[contact.placement] || null;
}
