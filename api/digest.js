// GET /api/digest — fired by Vercel Cron daily at 12:00 UTC (see vercel.json).
// Scans the 3 brokerage sites for WATCH_KEYWORD, scores against the buy box,
// dedupes against previously-emailed URLs (Upstash Redis, optional), and emails
// the digest via Resend to DIGEST_TO.
//
// Env vars:
//   ANTHROPIC_API_KEY  (required for scanning — without it, digest is skipped)
//   RESEND_API_KEY     (required to send email)
//   DIGEST_TO          default: pengbo.dev@gmail.com
//   DIGEST_FROM        default: onboarding@resend.dev (works out of the box)
//   WATCH_KEYWORD      default: HVAC
//   WATCH_LOCATION     default: Texas
//   FIT_MIN            default: 40
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (optional — enables no-repeat dedup)
//   CRON_SECRET        (optional — if set, requests must carry Authorization: Bearer <secret>)

const SITES = ["businessesforsale.com", "bizbuysell.com", "bizquest.com"];
const BOX = { priceMin: 200000, priceMax: 1500000, sdeMin: 150000, multMax: 4.0, marginMin: 0.15, ageMin: 5 };
const YEAR = new Date().getFullYear();

function scoreDeal(d) {
  const mult = d.asking != null && d.sde ? d.asking / d.sde : null;
  const margin = d.sde != null && d.revenueT12 ? d.sde / d.revenueT12 : null;
  const age = d.established != null ? YEAR - d.established : null;
  let score = 0;
  if (d.asking != null && d.asking >= BOX.priceMin && d.asking <= BOX.priceMax) score += 20;
  if (d.sde != null && d.sde >= BOX.sdeMin) score += 25;
  if (mult != null && mult <= BOX.multMax && mult >= 1.2) score += 25;
  if (margin != null && margin >= BOX.marginMin) score += 15;
  if (age != null && age >= BOX.ageMin) score += 15;
  return { ...d, score, mult };
}

const money = (n) =>
  n == null ? "Not stated" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`;
const canon = (u) => (u || "").toLowerCase().replace(/\/+$/, "");
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function scanSite(site, keyword, location, key) {
  const prompt = `Search the web for small businesses currently for sale matching "${keyword}"${location ? ` in or near "${location}"` : ""}. ONLY include listings hosted on ${site}.

Respond with ONLY a raw JSON array, no prose, no markdown fences. Up to 5 listings, each object exactly:
{"name": string, "source": "${site}", "location": string, "asking": number or null, "sde": number or null, "revenueT12": number or null, "established": number or null, "listingUrl": string, "broker": string or null, "note": string}

STRICT EXTRACTION RULES: only figures explicitly stated in search results; null for anything not stated; NEVER estimate; listingUrl copied exactly from a search result URL on ${site}. Return [] if nothing found.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return [];
  const text = (data.content || []).map((i) => (i.type === "text" ? i.text : "")).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const s = clean.indexOf("["), e = clean.lastIndexOf("]");
  if (s === -1 || e === -1) return [];
  try {
    return JSON.parse(clean.slice(s, e + 1)).filter((p) => p && p.listingUrl);
  } catch {
    return [];
  }
}

// ---- Optional Upstash Redis seen-registry (free tier) ----
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  const r = await fetch(`${url}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const j = await r.json();
  return j.result;
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`)
      return res.status(401).json({ error: "unauthorized" });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!anthropicKey)
    return res.status(200).json({ skipped: true, reason: "No ANTHROPIC_API_KEY — nothing to scan, digest not sent." });
  if (!resendKey)
    return res.status(200).json({ skipped: true, reason: "No RESEND_API_KEY — cannot send email." });

  const keyword = process.env.WATCH_KEYWORD || "HVAC";
  const location = process.env.WATCH_LOCATION || "Texas";
  const fitMin = Number(process.env.FIT_MIN || 40);
  const to = process.env.DIGEST_TO || "pengbo.dev@gmail.com";
  const from = process.env.DIGEST_FROM || "Deal Scanner <onboarding@resend.dev>";

  // 1. Scan all three sites in parallel
  const settled = await Promise.allSettled(SITES.map((s) => scanSite(s, keyword, location, anthropicKey)));
  let listings = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  // 2. Dedupe within the batch by canonical URL
  const seenBatch = new Set();
  listings = listings.filter((d) => {
    const k = canon(d.listingUrl);
    if (!k || seenBatch.has(k)) return false;
    seenBatch.add(k);
    return true;
  });

  // 3. Drop anything emailed in a previous digest (Upstash, if configured)
  let dedupNote = "No-repeat registry: not configured (add Upstash env vars to enable).";
  const already = await redis(["SMEMBERS", "digest:seen"]);
  if (already !== null) {
    const prior = new Set(already || []);
    listings = listings.filter((d) => !prior.has(canon(d.listingUrl)));
    dedupNote = `No-repeat registry active: ${prior.size} previously-sent listings excluded.`;
  }

  // 4. Score and cut at the fit threshold
  const scored = listings.map(scoreDeal).sort((a, b) => b.score - a.score);
  const qualified = scored.filter((d) => d.score > fitMin);

  // 5. Record what we're about to send, so tomorrow never repeats it
  if (already !== null && qualified.length) {
    await redis(["SADD", "digest:seen", ...qualified.map((d) => canon(d.listingUrl))]);
  }

  // 6. Render the email
  const rows = qualified
    .map(
      (d) => `
    <div style="border:1px solid #D9DED8;border-radius:8px;padding:14px;margin-bottom:12px;background:#fff">
      <div style="font-size:16px;font-weight:700;color:#1C2B25">${esc(d.name)}
        <span style="font-size:11px;font-weight:400;color:#5C6B63"> · ${esc(d.source)} · ${esc(d.location)}</span>
      </div>
      <div style="font-family:monospace;font-size:13px;margin-top:6px;color:#1C2B25">
        FIT ${d.score} · Asking ${money(d.asking)} · SDE ${money(d.sde)} · Rev ${money(d.revenueT12)} · ${d.mult != null ? d.mult.toFixed(1) + "×" : "—"}
      </div>
      <div style="font-size:12px;color:#5C6B63;margin-top:4px">${esc(d.note)}</div>
      <div style="margin-top:8px">
        <a href="${esc(d.listingUrl)}" style="color:#1E5B4A;font-size:12px">View source listing ↗</a>
        &nbsp;·&nbsp;
        <a href="mailto:?subject=${encodeURIComponent("Buyer inquiry — " + d.name)}&body=${encodeURIComponent(
          `Hi,\n\nI came across your listing for ${d.name} and it fits my acquisition criteria. I'm a qualified buyer and prepared to sign an NDA.\n\nCould you share: T12 monthly P&L, SDE add-back schedule, 3 years of tax returns, lease terms, customer concentration, and reason for sale?\n\nBest regards,\nPengbo\npengbo.dev@gmail.com`
        )}" style="color:#8F6E1F;font-size:12px">Draft info request ✉</a>
      </div>
    </div>`
    )
    .join("");

  const html = `
  <div style="font-family:system-ui,sans-serif;background:#F1F3EF;padding:24px">
    <div style="max-width:640px;margin:0 auto">
      <div style="font-family:monospace;font-size:11px;letter-spacing:2px;color:#1E5B4A">DAILY DEAL SHEET · ${new Date().toDateString().toUpperCase()}</div>
      <h1 style="font-size:22px;color:#1C2B25;margin:6px 0 4px">Acquisition screen — "${esc(keyword)}"${location ? " · " + esc(location) : ""}</h1>
      <p style="font-size:13px;color:#5C6B63;margin:0 0 16px">${qualified.length} listing${qualified.length === 1 ? "" : "s"} above fit ${fitMin}, across ${SITES.length} sites. ${esc(dedupNote)} Figures are extracted verbatim from listings — unstated fields are marked "Not stated", never estimated.</p>
      ${rows || `<p style="font-size:13px;color:#5C6B63">Nothing new above the cutoff today. See you tomorrow.</p>`}
    </div>
  </div>`;

  // 7. Send via Resend
  const send = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({ from, to, subject: `Deal sheet: ${qualified.length} new "${keyword}" listings above fit ${fitMin}`, html }),
  });
  const sendResult = await send.json();

  return res.status(200).json({
    scanned: listings.length + (already !== null ? 0 : 0),
    qualified: qualified.length,
    emailed: send.ok,
    resend: send.ok ? sendResult.id : sendResult,
  });
}
