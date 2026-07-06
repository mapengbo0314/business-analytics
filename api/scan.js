// POST /api/scan  { site, keyword, location, exclude: [urls] }
// Proxies one site-scoped listing search to the Anthropic API (key stays server-side).
// Returns { listings: [...] } or a clear 501 if no key is configured.

const MODEL = "claude-sonnet-4-6";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(501).json({
      error: "no_key",
      message:
        "Live scanning is off: add an ANTHROPIC_API_KEY environment variable in Vercel to enable it. Everything else in the app works without it.",
    });
  }

  const { site, keyword, location = "", exclude = [] } = req.body || {};
  if (!site || !keyword) return res.status(400).json({ error: "site and keyword required" });

  const prompt = `Search the web for small businesses currently for sale matching "${keyword}"${
    location ? ` in or near "${location}"` : ""
  }. ONLY include listings hosted on ${site}.${
    exclude.length ? ` EXCLUDE these URLs (already collected): ${exclude.slice(0, 15).join(" , ")}` : ""
  }

Respond with ONLY a raw JSON array, no prose, no markdown fences. Up to 5 listings, each object exactly:
{"name": string, "source": "${site}", "location": string, "asking": number or null, "sde": number or null (cash flow / seller's discretionary earnings), "revenueT12": number or null, "established": number or null (year), "listingUrl": string, "broker": string or null, "note": string (one short sentence of facts stated in the listing)}

STRICT EXTRACTION RULES: only include numbers explicitly stated in search results; use null for anything not stated; NEVER estimate; listingUrl must be copied exactly from a search result URL on ${site}, never constructed from memory. Return [] if nothing found.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "anthropic_error", detail: data?.error?.message || r.status });
    }
    const text = (data.content || [])
      .map((i) => (i.type === "text" ? i.text : ""))
      .filter(Boolean)
      .join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("["), e = clean.lastIndexOf("]");
    let listings = [];
    if (s !== -1 && e !== -1) {
      try {
        listings = JSON.parse(clean.slice(s, e + 1)).filter(
          (p) => p && p.listingUrl && p.listingUrl.toLowerCase().includes(site.split(".")[0])
        );
      } catch {
        listings = [];
      }
    }
    return res.status(200).json({ listings });
  } catch (err) {
    return res.status(500).json({ error: "scan_failed", detail: String(err) });
  }
}
