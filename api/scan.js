// GET /api/scan?site=<id>&keyword=<kw>&location=<loc>&page=<n>
// Scrapes one listing source directly — NO LLM, no API keys required.
// Responses are cached at Vercel's edge for 5 hours (s-maxage=18000), so each
// unique site+keyword+location combination is re-scraped at most every 5 hours.
//
// GET /api/scan?meta=1 returns the source registry so the UI stays in sync.

import { SOURCES, scanSource } from "./_lib/scrape.js";
import { redis, redisConfigured } from "./_lib/redis.js";

// Persist found listings into the shared Redis pool (best-effort — a storage
// hiccup must never fail the scan). Trimmed lazily: oldest entries are evicted
// once the hash grows past 400.
async function storeListings(listings) {
  if (!redisConfigured() || !listings.length) return;
  try {
    const now = Date.now();
    const args = [];
    for (const l of listings) {
      const k = (l.listingUrl || "").toLowerCase().replace(/\/+$/, "");
      if (k) args.push(k, JSON.stringify({ ...l, storedAt: now }));
    }
    if (!args.length) return;
    await redis(["HSET", "deals:pool", ...args]);
    const size = await redis(["HLEN", "deals:pool"]);
    if (size > 400) {
      const flat = (await redis(["HGETALL", "deals:pool"])) || [];
      const entries = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        let at = 0;
        try { at = JSON.parse(flat[i + 1]).storedAt || 0; } catch { /* treat as oldest */ }
        entries.push([flat[i], at]);
      }
      entries.sort((a, b) => a[1] - b[1]);
      const evict = entries.slice(0, entries.length - 300).map((e) => e[0]);
      if (evict.length) await redis(["HDEL", "deals:pool", ...evict]);
    }
  } catch (e) { /* best-effort only */ }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const { site, keyword, location = "", page = "1", meta, debug } = req.query || {};

  if (meta) {
    res.setHeader("Cache-Control", "public, s-maxage=86400");
    return res.status(200).json({
      refreshHours: 5,
      sources: Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label, kind: s.kind })),
    });
  }

  // keyword is optional — empty means "browse everything the source lists"
  if (!site) return res.status(400).json({ error: "site required" });
  if (!SOURCES[site]) return res.status(400).json({ error: "unknown_site", known: Object.keys(SOURCES) });

  const result = await scanSource(site, String(keyword), String(location), Math.max(1, Number(page) || 1), !!debug);

  // 5-hour refresh window: edge caches successful scrapes; failures are not cached
  // so a blocked/erroring source can recover on the next request. Debug requests
  // bypass the cache so each one shows a live trace.
  if (debug) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  }
  await storeListings(result.listings || []);

  if (result.status === "ok" || result.status === "empty") {
    res.setHeader("Cache-Control", "public, s-maxage=18000, stale-while-revalidate=86400");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  return res.status(200).json(result);
}
