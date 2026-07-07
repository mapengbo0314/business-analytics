// Shared listing store — every successful scan (see scan.js) upserts what it
// found into a Redis hash, so scraped companies accumulate server-side and are
// shared across browsers/people instead of living only in localStorage.
//
// GET /api/listings → { enabled, listings: [...] } newest-first, capped at 300.

import { redis, redisConfigured } from "./_lib/redis.js";

export const POOL_KEY = "deals:pool";
export const POOL_MAX = 300;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!redisConfigured()) {
    return res.status(200).json({ enabled: false, listings: [] });
  }
  try {
    const flat = (await redis(["HGETALL", POOL_KEY])) || [];
    const listings = [];
    const push = (v) => {
      try { listings.push(typeof v === "string" ? JSON.parse(v) : v); } catch { /* skip corrupt */ }
    };
    if (Array.isArray(flat)) for (let i = 1; i < flat.length; i += 2) push(flat[i]);
    else if (flat && typeof flat === "object") for (const v of Object.values(flat)) push(v);
    listings.sort((a, b) => (b.storedAt || 0) - (a.storedAt || 0));
    return res.status(200).json({ enabled: true, listings: listings.slice(0, POOL_MAX) });
  } catch (err) {
    return res.status(502).json({ error: "redis_error", detail: String(err) });
  }
}
