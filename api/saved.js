// Shared starred deals, backed by Upstash Redis (free tier) — the same env vars
// that enable the digest's no-repeat registry:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//
// GET    /api/saved            → { enabled, saved: { <canonUrl>: deal, ... } }
// POST   /api/saved {deal}     → star a deal (upsert by canonical listing URL)
// DELETE /api/saved?url=<url>  → unstar
//
// Without the env vars, GET returns { enabled: false } and the frontend keeps
// stars in localStorage (per-browser) as before. Note: there is no per-user
// auth — anyone who can open the app shares one star list. That's the point.

import { redis, redisConfigured } from "./_lib/redis.js";

const KEY = "deals:saved";
const canon = (u) => (u || "").toLowerCase().replace(/\/+$/, "");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!redisConfigured()) {
    return res.status(200).json({
      enabled: false,
      message: "Shared saves are off — add UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in Vercel to enable.",
    });
  }

  try {
    if (req.method === "GET") {
      const flat = (await redis(["HGETALL", KEY])) || [];
      const saved = {};
      if (Array.isArray(flat)) {
        for (let i = 0; i + 1 < flat.length; i += 2) {
          try { saved[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip corrupt entry */ }
        }
      } else if (flat && typeof flat === "object") {
        for (const [k, v] of Object.entries(flat)) {
          try { saved[k] = typeof v === "string" ? JSON.parse(v) : v; } catch { /* skip */ }
        }
      }
      return res.status(200).json({ enabled: true, saved });
    }

    if (req.method === "POST") {
      const deal = req.body && req.body.deal;
      const k = canon(deal && (deal.listingUrl || deal.id));
      if (!k) return res.status(400).json({ error: "deal with a listingUrl is required" });
      await redis(["HSET", KEY, k, JSON.stringify(deal)]);
      return res.status(200).json({ enabled: true, ok: true });
    }

    if (req.method === "DELETE") {
      const k = canon(String((req.query && req.query.url) || ""));
      if (!k) return res.status(400).json({ error: "url query param required" });
      await redis(["HDEL", KEY, k]);
      return res.status(200).json({ enabled: true, ok: true });
    }

    return res.status(405).json({ error: "GET, POST or DELETE only" });
  } catch (err) {
    return res.status(502).json({ error: "redis_error", detail: String(err) });
  }
}
