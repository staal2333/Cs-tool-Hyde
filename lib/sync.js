import { getAccessToken } from './google.js';
import { searchMessages, getMessage, parseFrom, parseRecipients } from './gmail.js';
import { DATA } from './data.js';
import { effectiveState, applyPatch } from './state.js';
import { appendLog } from './log.js';
import { isAutoReply, matchCompany } from './sync-core.js';
import { redis, hasRedis } from './redis.js';

const THREADS_KEY = 'hyde:threads';   // { company: {subject, from, date, snippet, threadId, auto} }
const SEEN_KEY = 'hyde:syncseen';     // [messageId]
const META_KEY = 'hyde:contactmeta';  // { company: {email, domain, person, phone} }
const LASTSYNC_KEY = 'hyde:lastsync';

let memThreads = {}, memSeen = [], memMeta = {}, memLast = 0;

async function get(key, fb) { if (!hasRedis) return fb; const v = await redis.get(key); return v ?? fb; }
async function set(key, v, memSetter) { if (!hasRedis) { memSetter(v); return; } await redis.set(key, v); }

export async function loadThreads() { return hasRedis ? (await get(THREADS_KEY, {})) || {} : memThreads; }
export async function loadMeta() { return hasRedis ? (await get(META_KEY, {})) || {} : memMeta; }
export async function loadLastSync() { return hasRedis ? (await get(LASTSYNC_KEY, 0)) || 0 : memLast; }

function fmtDate(ms) {
  return new Date(ms || Date.now()).toLocaleDateString('da-DK');
}

function cleanReply(t) {
  if (!t) return '';
  const out = [];
  for (const ln of t.split('\n')) {
    if (/^\s*>/.test(ln)) break;
    if (/^\s*(On .+wrote:|Den .+skrev:|Fra:\s|From:\s|-{3,}\s*Original|Sendt fra min)/i.test(ln)) break;
    out.push(ln);
  }
  return out.join('\n').trim();
}

export async function runSync() {
  const token = await getAccessToken();
  const companies = DATA.contacts;
  const meta = await loadMeta();
  const threads = await loadThreads();
  const seen = new Set(hasRedis ? (await get(SEEN_KEY, [])) : memSeen);
  const state = await effectiveState();
  const summary = { sent: 0, replies: 0, autoreplies: 0, matched: 0, updates: [] };

  // ---- SENT pass: anything Sebastian emailed → at least "Sendt" ----
  const sentIds = await searchMessages(token, 'in:sent newer_than:180d', 150);
  for (const id of sentIds) {
    const m = await getMessage(token, id);
    for (const rcpt of parseRecipients(m.headers)) {
      const hit = matchCompany(rcpt, companies, meta);
      if (!hit) continue;
      meta[hit.company] = meta[hit.company] || {};
      if (!meta[hit.company].email) meta[hit.company].email = rcpt;
      const cur = (state[hit.company] || {}).status || 'Ikke kontaktet';
      if (cur === 'Ikke kontaktet') {
        const date = fmtDate(m.date);
        await applyPatch(hit.company, { status: 'Sendt', date });
        state[hit.company] = { ...(state[hit.company] || {}), status: 'Sendt', date };
        summary.sent++;
        summary.updates.push(`${hit.company} → Sendt`);
      }
    }
  }

  // ---- INBOX pass: replies from clients ----
  const inIds = await searchMessages(token, 'in:inbox newer_than:180d -from:hydemedia.dk', 150);
  for (const id of inIds) {
    const m = await getMessage(token, id);
    const from = parseFrom(m.headers);
    const hit = matchCompany(from, companies, meta);
    if (!hit) continue;
    summary.matched++;
    const subject = m.headers.subject || '';
    const auto = isAutoReply({ subject, snippet: m.snippet, headers: m.headers });
    threads[hit.company] = { subject, from, date: m.date, snippet: m.snippet, threadId: m.threadId, auto };

    if (auto) { summary.autoreplies++; continue; }

    summary.replies++;
    const cur = (state[hit.company] || {}).status || 'Ikke kontaktet';
    if (cur !== 'Booket' && cur !== 'Nej tak' && cur !== 'Svar modtaget') {
      await applyPatch(hit.company, { status: 'Svar modtaget', date: fmtDate(m.date) });
      state[hit.company] = { ...(state[hit.company] || {}), status: 'Svar modtaget' };
      summary.updates.push(`${hit.company} → Svar modtaget`);
    }
    if (!seen.has(m.id)) {
      const text = cleanReply(m.body || m.snippet);
      if (text) await appendLog(hit.company, 'kunde', text.slice(0, 1500));
      seen.add(m.id);
    }
  }

  const now = Date.now();
  await set(META_KEY, meta, (v) => (memMeta = v));
  await set(THREADS_KEY, threads, (v) => (memThreads = v));
  await set(SEEN_KEY, [...seen].slice(-3000), (v) => (memSeen = v));
  await set(LASTSYNC_KEY, now, (v) => (memLast = v));

  return { ...summary, lastSync: now, threads: Object.keys(threads).length };
}
