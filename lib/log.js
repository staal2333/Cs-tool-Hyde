import { redis, hasRedis } from './redis.js';

const LOGS_KEY = 'hyde:logs'; // { company: [{who:'mig'|'kunde', text, ts}] }
const TONE_KEY = 'hyde:tone'; // [{text, ts}] — Sebastian's own messages, style reference

let logsMem = {};
let toneMem = [];

export async function loadLogs() {
  if (!hasRedis) return logsMem;
  const v = await redis.get(LOGS_KEY);
  return v && typeof v === 'object' ? v : {};
}
async function saveLogs(l) {
  if (!hasRedis) { logsMem = l; return; }
  await redis.set(LOGS_KEY, l);
}

export async function loadTone() {
  if (!hasRedis) return toneMem;
  const v = await redis.get(TONE_KEY);
  return Array.isArray(v) ? v : [];
}
async function saveTone(t) {
  if (!hasRedis) { toneMem = t; return; }
  await redis.set(TONE_KEY, t);
}

export async function appendLog(company, who, text) {
  const t = String(text || '').trim();
  if (!company || !t) throw new Error('bad_log');
  const dir = who === 'kunde' ? 'kunde' : 'mig';

  const logs = await loadLogs();
  const arr = (logs[company] || []).slice();
  arr.push({ who: dir, text: t, ts: Date.now() });
  logs[company] = arr.slice(-50);
  await saveLogs(logs);

  // Sebastian's own messages become global tone examples.
  if (dir === 'mig') {
    const tone = await loadTone();
    tone.push({ text: t, ts: Date.now() });
    const seen = new Set();
    const dedup = [];
    for (const e of tone.slice().reverse()) {
      if (seen.has(e.text)) continue;
      seen.add(e.text);
      dedup.push(e);
    }
    await saveTone(dedup.reverse().slice(-20));
  }

  return logs[company];
}
