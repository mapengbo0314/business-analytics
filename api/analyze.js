// Server-side due diligence: sends the deal + its uploaded broker documents to
// Claude and returns a structured analysis — no copy/paste needed.
//
// Setup (Vercel env var): ANTHROPIC_API_KEY (console.anthropic.com; pay-per-use)
// Optional: ANALYZE_MODEL (default claude-opus-4-8)
//
// GET  → { enabled }  (feature detection for the UI)
// POST { deal, criteria } → { report, model, usage }
//
// Note: this is the ONLY endpoint that touches the Anthropic API — scanning
// stays scraper-based and works without any key.

import Anthropic from "@anthropic-ai/sdk";

const enabled = () => !!process.env.ANTHROPIC_API_KEY;
const MAX_DOC_BYTES = 12 * 1024 * 1024; // per file
const MAX_TEXT_CHARS = 60000; // per csv/txt file

const money = (n) =>
  n == null ? "Not stated" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`;

async function fileToBlock(f) {
  const name = String(f.name || "document");
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!/\.blob\.vercel-storage\.com\//.test(String(f.url || ""))) return { skipped: name, reason: "not a blob url" };
  const supported = ["pdf", "csv", "txt", "md", "png", "jpg", "jpeg", "webp"];
  if (!supported.includes(ext)) return { skipped: name, reason: `.${ext} not machine-readable here — export as PDF/CSV` };

  const r = await fetch(f.url);
  if (!r.ok) return { skipped: name, reason: `fetch failed (${r.status})` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > MAX_DOC_BYTES) return { skipped: name, reason: "over 12MB" };

  if (ext === "pdf") {
    return {
      block: { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") }, title: name },
    };
  }
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
    const mt = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return { block: { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } } };
  }
  return {
    block: { type: "text", text: `--- Document: ${name} ---\n${buf.toString("utf8").slice(0, MAX_TEXT_CHARS)}` },
  };
}

function analysisPrompt(deal, criteria, docNames, skipped) {
  const c = criteria || { priceMin: 200000, priceMax: 1500000, sdeMin: 150000, multMax: 4, marginMin: 0.15, ageMin: 5 };
  const mult = deal.asking != null && deal.sde ? (deal.asking / deal.sde).toFixed(1) + "×" : "not computable";
  return `You are a rigorous small-business acquisition analyst. Analyze this deal using ONLY the attached documents and the listing facts below; state explicitly when something is missing rather than estimating.

DEAL
- Name: ${deal.name}
- Location: ${deal.location}
- Source listing: ${deal.listingUrl} (${deal.source})
- Claimed figures from the listing: Asking ${money(deal.asking)} · SDE/cash flow ${money(deal.sde)} · Revenue ${money(deal.revenueT12)} · Established ${deal.established ?? "not stated"} · Implied multiple ${mult}
${deal.notes ? `- Buyer's notes so far: ${deal.notes}` : ""}
${docNames.length ? `- Documents attached: ${docNames.join(", ")}` : "- NO documents attached — analyze the listing figures only and say what documents to request."}
${skipped.length ? `- Documents on file that could NOT be attached (tell the buyer to re-export these): ${skipped.map((s) => `${s.skipped} (${s.reason})`).join("; ")}` : ""}

BUYER'S BOX: price ${money(c.priceMin)}–${money(c.priceMax)}, SDE ≥ ${money(c.sdeMin)}, multiple ≤ ${c.multMax}×, SDE margin ≥ ${Math.round(c.marginMin * 100)}%, ${c.ageMin}+ years operating.

ANALYZE:
1. SDE verification — recompute from the statements; itemize every add-back and flag aggressive ones.
2. Revenue quality — trend, seasonality, customer concentration, one-time vs recurring.
3. Balance sheet — real working-capital needs, debt/liens, FF&E condition, what transfers.
4. Risk register — owner dependence, key staff, lease, concentration, regulatory — ranked by severity.
5. Valuation — is asking justified against verified SDE? Give a defensible offer range with reasoning.
6. Verdict — proceed / proceed with conditions / walk away, plus the exact question list for the seller before an LOI.

Format as plain markdown with those six numbered section headers.`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      enabled: enabled(),
      ...(enabled() ? {} : { message: "Add ANTHROPIC_API_KEY in Vercel to enable in-app analysis." }),
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
  if (!enabled()) return res.status(501).json({ enabled: false, error: "no_api_key" });

  const { deal, criteria } = req.body || {};
  if (!deal || !deal.name || !deal.listingUrl) return res.status(400).json({ error: "deal required" });

  try {
    const content = [];
    const docNames = [];
    const skipped = [];
    for (const f of (deal.files || []).slice(0, 8)) {
      const out = await fileToBlock(f);
      if (out.block) {
        content.push(out.block);
        docNames.push(f.name);
      } else if (out.skipped) skipped.push(out);
    }
    content.push({ type: "text", text: analysisPrompt(deal, criteria, docNames, skipped) });

    const client = new Anthropic();
    const response = await client.messages.create({
      model: process.env.ANALYZE_MODEL || "claude-opus-4-8",
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return res.status(200).json({ enabled: true, error: "refused", message: "Claude declined this request — try removing unusual documents." });
    }
    const report = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!report) return res.status(502).json({ error: "empty_response" });

    return res.status(200).json({
      enabled: true,
      report,
      truncated: response.stop_reason === "max_tokens",
      analyzedDocs: docNames,
      skippedDocs: skipped,
      model: response.model,
      usage: response.usage,
    });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return res.status(502).json({
      error: "analyze_failed",
      detail: status === 401 ? "Invalid ANTHROPIC_API_KEY" : String(err && err.message ? err.message : err),
    });
  }
}
