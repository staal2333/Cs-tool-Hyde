import { redis, hasRedis } from './redis.js';

// One mockup image per placement, stored as a data URL in Redis.
// A separate small index lists which placements have an image, so /api/data
// stays cheap (one GET) — the actual bytes are streamed on demand.
const PREFIX = 'hyde:plimg:';
const INDEX_KEY = 'hyde:plimgindex';

const memImg = {};
let memIndex = [];

const key = (name) => PREFIX + encodeURIComponent(String(name || ''));

export async function loadImageIndex() {
  if (!hasRedis) return memIndex;
  const v = await redis.get(INDEX_KEY);
  return Array.isArray(v) ? v : [];
}
async function setIndex(arr) {
  const uniq = [...new Set(arr)];
  if (!hasRedis) { memIndex = uniq; return; }
  await redis.set(INDEX_KEY, uniq);
}

export async function loadPlacementImage(name) {
  if (!hasRedis) return memImg[name] || null;
  const v = await redis.get(key(name));
  return v && typeof v === 'object' ? v : null;
}

export async function savePlacementImage(name, img) {
  if (hasRedis) await redis.set(key(name), img);
  else memImg[name] = img;
  const idx = await loadImageIndex();
  if (!idx.includes(name)) await setIndex([...idx, name]);
}

export async function deletePlacementImage(name) {
  if (hasRedis) await redis.del(key(name));
  else delete memImg[name];
  const idx = await loadImageIndex();
  await setIndex(idx.filter((n) => n !== name));
}
