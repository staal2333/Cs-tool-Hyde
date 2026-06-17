import { getAccessToken } from './google.js';
import { searchMessages, fetchMessages, parseFrom, parseFromName, parseRecipients } from './gmail.js';
import { effectiveContacts } from './contacts.js';
import { effectiveState, applyPatch } from './state.js';
import { appendLog } from './log.js';
import { isAutoReply, matchCompany, personFromConversation } from './sync-core.js';
import { detectPlacements } from './placement-detect.js';
import { DATA } from './data.js';
import { redis, hasRedis } from './redis.js';

const THREADS_KEY = 'hyde:threads';   // { company: {subject, from, date, snippet, threadId, auto} } — latest inbound (back-compat)
const HISTORY_KEY = 'hyde:history';   // { company: {threadId, events:[...], placements:[...], lastTs, replied} }
const SEEN_KEY = 'hyde:syncseen';     // [messageId]
const META_KEY = 'hyde:contactmeta';  // { company: {email, domain, person, phone} }
const LASTSYNC_KEY = 'hyde:lastsync';

let memThreads = {}, memHistory = {}, memSeen = [], memMeta = {}, memLast = 0;

async function get(key, fb) { if (!hasRedis) return fb; const v = await redis.get(key); return v ?? fb; }
async function set(key, v, memSetter) { if (!hasRedis) { memSetter(v); return; } await redis.set(key, v); }

export async function loadThreads() { return hasRedis ? (await get(THREADS_KEY, {})) || {} : memThreads; }
export async function loadHistory() { return hasRedis ? (await get(HISTORY_KEY, {})) || {} : memHistory; }
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
  const companies = await effectiveContacts();
  const meta = await loadMeta();
  const state = await effectiveState();
  const seen = new Set(hasRedis ? (await get(SEEN_KEY, [])) : memSeen);
  const placementKeys = Object.keys(DATA.placements || {});
  const summary = { sent: 0, replies: 0, autoreplies: 0, matched: 0, updates: [] };

  // company -> { events:[], threadId, lastInboundTs }
  const hist = {};
  const ev = (company) => (hist[company] = hist[company] || { events: [], threadId: null, lastInboundTs: 0 });

  // ---- SENT pass: what each contact was emailed (incl. which placement) ----
  const sentIds = await searchMessages(token, 'in:sent newer_than:365d', 200);
  const sentMsgs = await fetchMessages(token, sentIds, 'metadata');
  const sentMatched = []; // {msg, company}
  for (const m of sentMsgs) {
    for (const rcpt of parseRecipients(m.headers)) {
      const hit = matchCompany(rcpt, companies, meta);
      if (!hit) continue;
      meta[hit.company] = meta[hit.company] || {};
      if (!meta[hit.company].email) meta[hit.company].email = rcpt;
      sentMatched.push({ msg: m, company: hit.company, to: rcpt });
      break; // one company per sent mail is enough
    }
  }

  // Full bodies for matched outbound mail → reliable placement detection.
  const sentBodies = await fetchMessages(token, sentMatched.map((s) => s.msg.id), 'full');
  const bodyById = {};
  for (const b of sentBodies) bodyById[b.id] = b.body;

  for (const s of sentMatched) {
    const m = s.msg;
    const subject = m.headers.subject || '';
    const sentBody = bodyById[m.id] || '';
    const text = (subject + '\n' + (sentBody || m.snippet || ''));
    const placements = detectPlacements(text, placementKeys);
    const e = ev(s.company);
    e.events.push({ dir: 'out', ts: m.date, date: fmtDate(m.date), subject, snippet: m.snippet || '', to: s.to, placements, threadId: m.threadId });
    if (m.threadId) e.threadId = m.threadId;
    // Keep the most recent sent body as a sample for greeting-based name detection.
    if (sentBody && m.date >= (e.sentBodyTs || 0)) { e.sentBody = sentBody; e.sentBodyTs = m.date; }
  }

  // ---- INBOX pass: replies from clients ----
  const inIds = await searchMessages(token, 'in:inbox newer_than:365d -from:hydemedia.dk', 200);
  const inMsgs = await fetchMessages(token, inIds, 'metadata');
  const toLog = []; // unseen real replies → fetch body for the dialogue log
  for (const m of inMsgs) {
    const from = parseFrom(m.headers);
    const hit = matchCompany(from, companies, meta);
    if (!hit) continue;
    summary.matched++;
    const subject = m.headers.subject || '';
    const auto = isAutoReply({ subject, snippet: m.snippet, headers: m.headers });
    const fromName = parseFromName(m.headers);
    const e = ev(hit.company);
    e.events.push({ dir: 'in', ts: m.date, date: fmtDate(m.date), subject, snippet: m.snippet || '', from, fromName, auto, threadId: m.threadId });
    if (!auto && m.date > e.lastInboundTs) {
      e.lastInboundTs = m.date;
      e.threadId = m.threadId || e.threadId;
      if (fromName) e.fromName = fromName; // display name of the latest real reply
    }
    if (auto) { summary.autoreplies++; continue; }
    summary.replies++;
    if (!seen.has(m.id)) toLog.push({ id: m.id, company: hit.company, snippet: m.snippet });
  }

  // ---- Assemble per-company history + derive threads/status ----
  const byCompany = Object.fromEntries(companies.map((c) => [c.company, c]));
  const history = {};
  const threads = {};
  for (const [company, h] of Object.entries(hist)) {
    const events = h.events.sort((a, b) => a.ts - b.ts);
    const placements = [...new Set(events.filter((e) => e.dir === 'out').flatMap((e) => e.placements || []))];
    const outCount = events.filter((e) => e.dir === 'out').length;
    const realIn = events.filter((e) => e.dir === 'in' && !e.auto);
    const lastReply = realIn[realIn.length - 1] || null;
    const last = events[events.length - 1] || null;

    // Who is the person? Prefer a name found in the actual conversation.
    const contact = byCompany[company];
    const fromConvo = personFromConversation({ fromName: h.fromName, sebastianBody: h.sentBody });
    const person = fromConvo || (contact && contact.person) || '';
    if (fromConvo) {
      meta[company] = meta[company] || {};
      if (!meta[company].person) meta[company].person = fromConvo; // fill the contact card when empty
    }

    history[company] = {
      threadId: h.threadId,
      events,
      placements,
      person,
      sentCount: outCount,
      replied: realIn.length > 0,
      lastReplyTs: lastReply ? lastReply.ts : 0,
      lastTs: last ? last.ts : 0,
    };

    // Back-compat: latest inbound (auto or real) feeds the old THREADS consumers.
    const lastIn = events.filter((e) => e.dir === 'in').slice(-1)[0];
    if (lastIn) {
      threads[company] = { subject: lastIn.subject, from: lastIn.from, date: lastIn.ts, snippet: lastIn.snippet, threadId: lastIn.threadId, auto: !!lastIn.auto };
    }

    // Status derivation: real reply wins; otherwise an outbound mail means "Sendt".
    const cur = (state[company] || {}).status || 'Ikke kontaktet';
    if (lastReply && cur !== 'Booket' && cur !== 'Nej tak' && cur !== 'Svar modtaget') {
      await applyPatch(company, { status: 'Svar modtaget', date: fmtDate(lastReply.ts) });
      state[company] = { ...(state[company] || {}), status: 'Svar modtaget' };
      summary.updates.push(`${company} → Svar modtaget`);
    } else if (outCount && cur === 'Ikke kontaktet') {
      const firstOut = events.find((e) => e.dir === 'out');
      await applyPatch(company, { status: 'Sendt', date: fmtDate(firstOut.ts) });
      state[company] = { ...(state[company] || {}), status: 'Sendt', date: fmtDate(firstOut.ts) };
      summary.sent++;
      summary.updates.push(`${company} → Sendt`);
    }
  }

  // Full bodies only for the (few) unseen real replies → dialogue log + tone.
  const bodies = await fetchMessages(token, toLog.map((t) => t.id), 'full');
  const byId = {};
  for (const b of bodies) byId[b.id] = b.body;
  for (const t of toLog) {
    const text = cleanReply(byId[t.id] || t.snippet);
    if (text) await appendLog(t.company, 'kunde', text.slice(0, 1500));
    seen.add(t.id);
  }

  const now = Date.now();
  await set(META_KEY, meta, (v) => (memMeta = v));
  await set(THREADS_KEY, threads, (v) => (memThreads = v));
  await set(HISTORY_KEY, history, (v) => (memHistory = v));
  await set(SEEN_KEY, [...seen].slice(-4000), (v) => (memSeen = v));
  await set(LASTSYNC_KEY, now, (v) => (memLast = v));

  return { ...summary, lastSync: now, threads: Object.keys(threads).length, history: Object.keys(history).length };
}
