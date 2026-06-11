import { redis, hasRedis } from './redis.js';
import { DATA } from './data.js';

const KEY = 'hyde:contacts';      // { custom:[...], deleted:[...], edits:{company:{...}} }
const META_KEY = 'hyde:contactmeta'; // { company:{email,...} } — filled by Gmail sync

let mem = null;

function blank() { return { custom: [], deleted: [], edits: {} }; }

export async function loadOverlay() {
  if (!hasRedis) return mem || blank();
  const v = await redis.get(KEY);
  if (!v || typeof v !== 'object') return blank();
  return { custom: v.custom || [], deleted: v.deleted || [], edits: v.edits || {} };
}
async function saveOverlay(o) {
  if (!hasRedis) { mem = o; return; }
  await redis.set(KEY, o);
}
async function loadMeta() {
  if (!hasRedis) return {};
  const v = await redis.get(META_KEY);
  return v && typeof v === 'object' ? v : {};
}

// Effective list = seed + custom, with edits applied, deleted removed,
// and sync-discovered email merged in when the contact has none.
export async function effectiveContacts() {
  const [o, meta] = await Promise.all([loadOverlay(), loadMeta()]);
  const deleted = new Set(o.deleted || []);
  const apply = (c) => {
    let out = o.edits[c.company] ? { ...c, ...o.edits[c.company] } : c;
    if (!out.email && meta[c.company]?.email) out = { ...out, email: meta[c.company].email };
    return out;
  };
  const list = [];
  for (const c of DATA.contacts) if (!deleted.has(c.company)) list.push(apply(c));
  for (const c of o.custom || []) if (!deleted.has(c.company)) list.push(apply(c));
  return list;
}

export async function contactByCompany(company) {
  return (await effectiveContacts()).find((c) => c.company === company) || null;
}

const FIELDS = ['temp', 'segment', 'placement', 'email', 'person', 'phone', 'subject', 'body', 'fuSubject', 'fuBody', 'crmStatus', 'buyer'];
function clean(obj) {
  const out = {};
  for (const k of FIELDS) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export async function addContact(contact) {
  const company = String(contact.company || '').trim();
  if (!company) throw new Error('company_required');
  const o = await loadOverlay();
  const inSeed = DATA.contacts.some((c) => c.company === company);
  const inCustom = (o.custom || []).some((c) => c.company === company);
  if (inSeed || inCustom) {
    // Re-adding a hidden/existing company: un-hide and apply fields as edits.
    o.deleted = (o.deleted || []).filter((x) => x !== company);
    if (inCustom) {
      const i = o.custom.findIndex((c) => c.company === company);
      o.custom[i] = { ...o.custom[i], ...clean(contact) };
    } else {
      o.edits[company] = { ...(o.edits[company] || {}), ...clean(contact) };
    }
  } else {
    o.custom = o.custom || [];
    o.custom.push({ company, temp: 'kold', order: 1000 + o.custom.length, custom: true, ...clean(contact) });
  }
  await saveOverlay(o);
  return company;
}

export async function updateContact(company, patch) {
  if (!company) throw new Error('company_required');
  const o = await loadOverlay();
  const i = (o.custom || []).findIndex((c) => c.company === company);
  if (i >= 0) o.custom[i] = { ...o.custom[i], ...clean(patch) };
  else { o.edits = o.edits || {}; o.edits[company] = { ...(o.edits[company] || {}), ...clean(patch) }; }
  await saveOverlay(o);
}

export async function deleteContact(company, hard = false) {
  const o = await loadOverlay();
  if (hard) {
    o.custom = (o.custom || []).filter((c) => c.company !== company);
    if (o.edits) delete o.edits[company];
    if (DATA.contacts.some((c) => c.company === company)) {
      o.deleted = o.deleted || [];
      if (!o.deleted.includes(company)) o.deleted.push(company);
    }
  } else {
    o.deleted = o.deleted || [];
    if (!o.deleted.includes(company)) o.deleted.push(company);
  }
  await saveOverlay(o);
}

export async function restoreContact(company) {
  const o = await loadOverlay();
  o.deleted = (o.deleted || []).filter((x) => x !== company);
  await saveOverlay(o);
}

// Apply a {company: buyer} map in one write (used by auto-classify).
export async function bulkSetBuyer(map) {
  const o = await loadOverlay();
  o.edits = o.edits || {};
  for (const [company, buyer] of Object.entries(map)) {
    const i = (o.custom || []).findIndex((c) => c.company === company);
    if (i >= 0) o.custom[i].buyer = buyer;
    else o.edits[company] = { ...(o.edits[company] || {}), buyer };
  }
  await saveOverlay(o);
}
