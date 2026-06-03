import { redis, hasRedis, STATE_KEY } from './redis.js';
import { SEED } from './data.js';

// In-memory fallback so the app still runs (per-instance, non-persistent)
// when no Redis store is connected — handy for local dev without env vars.
let memory = {};

export async function loadSaved() {
  if (!hasRedis) return memory;
  const v = await redis.get(STATE_KEY);
  return v && typeof v === 'object' ? v : {};
}

async function persist(saved) {
  if (!hasRedis) {
    memory = saved;
    return;
  }
  await redis.set(STATE_KEY, saved);
}

// Effective state = CSV seed overlaid with saved edits.
export async function effectiveState() {
  const saved = await loadSaved();
  const out = {};
  for (const k of new Set([...Object.keys(SEED), ...Object.keys(saved)])) {
    out[k] = { ...(SEED[k] || {}), ...(saved[k] || {}) };
  }
  return out;
}

export async function applyPatch(company, patch) {
  if (!company || !patch || typeof patch !== 'object') {
    throw new Error('bad_patch');
  }
  const saved = await loadSaved();
  const rec = { ...(SEED[company] || {}), ...(saved[company] || {}) };
  for (const [key, val] of Object.entries(patch)) {
    if (val === null || val === undefined || val === '') delete rec[key];
    else rec[key] = val;
  }
  saved[company] = rec;
  await persist(saved);
  return rec;
}

export async function resetAll() {
  await persist({});
}
