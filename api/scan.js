// GET /api/scan?site=<id>&keyword=<kw>&location=<loc>&page=<n>
// Scrapes one listing source directly — NO LLM, no API keys required.
// Responses are cached at Vercel's edge for 5 hours (s-maxage=18000), so each
// unique site+keyword+location combination is re-scraped at most every 5 hours.
//
// GET /api/scan?meta=1 returns the source registry so the UI stays in sync.

import { SOURCES, scanSource } from "./_lib/scrape.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const { site, keyword, location = "", page = "1", meta } = req.query || {};

  if (meta) {
    res.setHeader("Cache-Control", "public, s-maxage=86400");
    return res.status(200).json({
      refreshHours: 5,
      sources: Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label, kind: s.kind })),
    });
  }

  if (!site || !keyword) return res.status(400).json({ error: "site and keyword required" });
  if (!SOURCES[site]) return res.status(400).json({ error: "unknown_site", known: Object.keys(SOURCES) });

  const result = await scanSource(site, String(keyword), String(location), Math.max(1, Number(page) || 1));

  // 5-hour refresh window: edge caches successful scrapes; failures are not cached
  // so a blocked/erroring source can recover on the next request.
  if (result.status === "ok" || result.status === "empty") {
    res.setHeader("Cache-Control", "public, s-maxage=18000, stale-while-revalidate=86400");
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  return res.status(200).json(result);
}
