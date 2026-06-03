import { Redis } from '@upstash/redis';

// Works with either the Vercel-injected KV_* vars or native UPSTASH_* vars.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const hasRedis = Boolean(url && token);

export const redis = hasRedis ? new Redis({ url, token }) : null;

// Single key holds the whole status map: { "<company>": {status, date, note} }
export const STATE_KEY = 'hyde:state';
