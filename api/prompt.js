// The keyless due-diligence path: builds ONE complete research prompt for the
// user to paste into claude.ai — deal facts, buy box, notes + email history,
// the CONTENTS of text-based documents inlined, an attach-list for binary
// documents, and the previous analysis when this is a follow-up.
// No ANTHROPIC_API_KEY required — this endpoint never calls an LLM.
//
// GET  → { enabled: true }
// POST { deal, criteria } → { prompt, attach: [names to attach], inlined: [names] }

const TEXT_EXTS = ["csv", "txt", "md", "json"];
const PER_FILE_CHARS = 40000;
const TOTAL_CHARS = 120000;

const money = (n) =>
  n == null ? "Not stated" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`;

async function gatherDocs(files) {
  const inlined = [];
  const attach = [];
  let budget = TOTAL_CHARS;
  for (const f of (files || []).slice(0, 12)) {
    const name = String(f.name || "document");
    const ext = (name.split(".").pop() || "").toLowerCase();
    const isBlob = /\.blob\.vercel-storage\.com\//.test(String(f.url || ""));
    if (TEXT_EXTS.includes(ext) && isBlob && budget > 1000) {
      try {
        const r = await fetch(f.url);
        if (!r.ok) throw new Error(String(r.status));
        const text = (await r.text()).slice(0, Math.min(PER_FILE_CHARS, budget));
        budget -= text.length;
        inlined.push({ name, text });
        continue;
      } catch { /* fall through to attach list */ }
    }
    attach.push(name);
  }
  return { inlined, attach };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ enabled: true });
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  const { deal, criteria } = req.body || {};
  if (!deal || !deal.name) return res.status(400).json({ error: "deal required" });
  const c = criteria || { priceMin: 200000, priceMax: 1500000, sdeMin: 150000, multMax: 4, marginMin: 0.15, ageMin: 5 };
  const mult = deal.asking != null && deal.sde ? (deal.asking / deal.sde).toFixed(1) + "×" : "not computable";

  const { inlined, attach } = await gatherDocs(deal.files);

  const prompt = `You are a rigorous small-business acquisition analyst. Below is EVERYTHING I have on this deal — the listing facts, my notes and the email history with the broker, and the financial documents (some inlined below, some attached to this message). Analyze it thoroughly.

DEAL
- Name: ${deal.name}
- Location: ${deal.location || "Not stated"}
- Source listing: ${deal.listingUrl || "n/a"} (${deal.source || "unknown"})
- Claimed figures from the listing: Asking ${money(deal.asking)} · SDE/cash flow ${money(deal.sde)} · Revenue ${money(deal.revenueT12)} · Established ${deal.established ?? "not stated"} · Implied multiple ${mult}
- Pipeline stage: ${deal.stage || "watching"}

MY BUY BOX
- Price ${money(c.priceMin)}–${money(c.priceMax)}, SDE ≥ ${money(c.sdeMin)}, multiple ≤ ${c.multMax}×, SDE margin ≥ ${Math.round(c.marginMin * 100)}%, ${c.ageMin}+ years operating.

MY NOTES & EMAIL HISTORY WITH THE BROKER
${deal.notes ? deal.notes : "None yet."}
${attach.length ? `
DOCUMENTS ATTACHED TO THIS MESSAGE (read them — I attached these files before sending): ${attach.join(", ")}` : ""}${inlined.length ? `

DOCUMENTS INLINED BELOW
${inlined.map((i) => `--- DOCUMENT: ${i.name} ---\n${i.text}`).join("\n\n")}` : ""}${deal.ddReport ? `

PREVIOUS ANALYSIS (this is a follow-up — explicitly call out what CHANGED versus this):
${String(deal.ddReport).slice(0, 15000)}` : ""}

ANALYZE — using ONLY the documents and facts above; state explicitly when something is missing rather than estimating:
1. SDE verification — recompute from the statements; itemize every add-back and flag aggressive ones.
2. Revenue quality — trend, seasonality, customer concentration, one-time vs recurring.
3. Balance sheet — real working-capital needs, debt/liens, FF&E condition, what transfers.
4. Risk register — owner dependence, key staff, lease, concentration, regulatory — ranked by severity.
5. Valuation — is the asking price justified against verified SDE? Give a defensible offer range with reasoning.
6. Verdict — proceed / proceed with conditions / walk away, plus the exact question list for the seller before an LOI.

Format as plain markdown with those six numbered section headers.`;

  return res.status(200).json({ prompt, attach, inlined: inlined.map((i) => i.name) });
}
