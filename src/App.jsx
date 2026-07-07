import { useState, useMemo, useEffect, useRef } from "react";

// ---------- Design tokens: "Underwriter's ledger" ----------
const T = {
  bg: "#F1F3EF", surface: "#FFFFFF", ink: "#1C2B25", inkSoft: "#5C6B63",
  line: "#D9DED8", green: "#1E5B4A", greenSoft: "#E4EEE9",
  brass: "#8F6E1F", brassSoft: "#F4ECD8", clay: "#A8442E", claySoft: "#F6E4DE",
  mono: "'Spline Sans Mono', ui-monospace, monospace",
  body: "'Public Sans', system-ui, sans-serif",
  display: "'Young Serif', Georgia, serif",
};

const STORAGE_KEY = "dealflow-state-v1";
const SITES_KEY = "dealflow-sites-v1";
const POOL_KEY = "dealflow-pool-v2";
// Mirrors api/_lib/scrape.js — the big marketplaces are read via public search
// indexes (their own pages block server-side bots); the rest are scraped directly.
const SOURCES = [
  { id: "bizbuysell", label: "BizBuySell" },
  { id: "businessesforsale", label: "BusinessesForSale.com" },
  { id: "bizquest", label: "BizQuest" },
  { id: "dealstream", label: "DealStream" },
  { id: "businessbroker", label: "BusinessBroker.net" },
  { id: "synergybb", label: "Synergy Business Brokers" },
];
const REFRESH_MS = 5 * 60 * 60 * 1000; // 5 hours — matches the server-side cache & cron
const TODAY = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// ---------- Seed listings — extracted and validated live, Jul 6, 2026 ----------
const SEED_DEALS = [
  {
    id: "BFS-3960780",
    name: "Residential HVAC Co. (SBA Pre-Approved)",
    source: "BusinessesForSale.com",
    broker: "Saint Louis Group.com (ref 3475RY)",
    location: "Saint Louis County, MO",
    asking: 1250000, sde: 355447, revenueT12: 1433264, established: 1986,
    listingUrl: "https://us.businessesforsale.com/us/residential-hvac-company-sba-pre-approved.aspx",
    website: null,
    verify: "live", verifiedOn: "Jul 6, 2026",
    missing: ["Business name / website (pre-NDA)", "T12 monthly P&L", "Add-back schedule", "Customer concentration", "FF&E + inventory: included in price?"],
    note: "Stated on listing: ~40 yrs operating, 2 FT employees, 2,500 sq ft lease at $2,500/mo, owner retiring. FF&E $90,500 · Inventory $79,256.",
  },
  {
    id: "BFS-3975340",
    name: "Heating & Cooling Business — Austin",
    source: "BusinessesForSale.com",
    broker: "Hammer Brokers LLC (ref SSM-VZ-AUS)",
    location: "Austin, TX",
    asking: 255000, sde: 217400, revenueT12: 850000, established: 2017,
    listingUrl: "https://us.businessesforsale.com/us/lucrative-heating-and-cooling-business-in-austin.aspx",
    website: null,
    verify: "live", verifiedOn: "Jul 6, 2026",
    missing: ["Business name / website (pre-NDA)", "T12 monthly P&L", "Add-back schedule", "Reason for sale", "Lease terms", "Franchise affiliation?"],
    note: "Stated on listing: est. 2017, 4 employees, vehicle + FF&E included. 1.2× multiple is unusually low, and \"national accounts\" wording suggests a possible franchise resale — verify before valuing.",
  },
  {
    id: "BBS-2433694",
    name: "Profitable Austin Area HVAC",
    source: "BizBuySell",
    broker: "Not stated on category page",
    location: "Austin, TX",
    asking: 675000, sde: 254696, revenueT12: null, established: 1986,
    listingUrl: "https://www.bizbuysell.com/business-opportunity/profitable-austin-area-hvac/2433694/",
    website: null,
    verify: "partial", verifiedOn: "Jul 6, 2026",
    missing: ["Revenue (not on category page)", "T12 monthly P&L", "Add-back schedule", "Employee count", "Lease terms"],
    note: "Figures from BizBuySell's live Texas HVAC category page. Detail page blocks automated access, and a cached page showed $105,575 cash flow — click through to confirm current figures.",
  },
];

const money = (n) =>
  n == null ? "Not stated" : n >= 1000000 ? `$${(n / 1000000).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

// ---------- Deal pipeline (mirrors the real acquisition flow) ----------
const STAGES = [
  { id: "watching", label: "Watching" },
  { id: "inquired", label: "Inquired" },
  { id: "form", label: "Form submitted" },
  { id: "nda", label: "NDA signed" },
  { id: "docs", label: "Docs received" },
  { id: "dd", label: "In due diligence" },
  { id: "go", label: "Continue ✓" },
  { id: "passed", label: "Passed ✗" },
];
const STAGE_NEXT = {
  watching: "Next: read the listing and send the inquiry",
  inquired: "Waiting on the buyer form (user / asset / debt info)",
  form: "Waiting on the NDA",
  nda: "Waiting on business docs / financials",
  docs: "Next: run due diligence — copy the Claude prompt below",
  dd: "Next: decide — continue or pass",
  go: "Deal live — keep the momentum",
  passed: "Archived",
};

// Normalize a listing from /api/scan or /api/listings into the card shape.
const enrichListing = (p) => {
  const missing = [];
  if (p.asking == null) missing.push("Asking price");
  if (p.sde == null) missing.push("Cash flow / SDE");
  if (p.revenueT12 == null) missing.push("Revenue");
  if (p.established == null) missing.push("Year established");
  missing.push("T12 monthly P&L", "Add-back schedule");
  return {
    id: null, website: null, verifiedOn: null, broker: p.broker || null,
    ...p,
    name: p.name || "Untitled listing",
    location: p.location || "Not stated",
    asking: p.asking ?? null, sde: p.sde ?? null,
    revenueT12: p.revenueT12 ?? null, established: p.established ?? null,
    verify: p.verify || "search",
    missing, note: p.note || "",
  };
};

const copyText = async (t) => {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (e2) {
      return false;
    }
  }
};

function ddPrompt(d, c) {
  const mult = d.asking != null && d.sde ? (d.asking / d.sde).toFixed(1) + "×" : "not computable";
  return `You are a rigorous small-business acquisition analyst. I'm evaluating this deal and have attached the business documents I received under NDA (P&L, balance sheet, tax returns, add-back schedule — whatever is attached).

DEAL
- Name: ${d.name}
- Location: ${d.location}
- Source listing: ${d.listingUrl} (${d.source})
- Claimed figures from the listing: Asking ${money(d.asking)} · SDE/cash flow ${money(d.sde)} · Revenue ${money(d.revenueT12)} · Established ${d.established ?? "not stated"} · Implied multiple ${mult}
${d.notes ? `- My notes so far: ${d.notes}` : ""}

MY BUY BOX
- Price ${money(c.priceMin)}–${money(c.priceMax)}, SDE ≥ ${money(c.sdeMin)}, multiple ≤ ${c.multMax}×, SDE margin ≥ ${Math.round(c.marginMin * 100)}%, ${c.ageMin}+ years operating.

ANALYZE — using ONLY the attached documents and the listing facts above; say explicitly when something is missing rather than estimating:
1. SDE verification: recompute SDE from the statements. Itemize every add-back and flag aggressive or non-standard ones.
2. Revenue quality: trend over the available years, seasonality, customer concentration, one-time vs recurring.
3. Balance sheet: working capital the business actually needs, debt/liens, condition and age of FF&E, anything that transfers vs stays with the seller.
4. Risk register: owner dependence, key employees, lease terms, supplier/customer concentration, regulatory or warranty exposure — ranked by severity.
5. Valuation: is the asking price justified against verified SDE? Give a defensible offer range with reasoning.
6. Verdict: proceed / proceed with conditions / walk away — plus the exact list of questions to send the seller before an LOI.`;
}

const canon = (d) => ((typeof d === "string" ? d : d.listingUrl || d.id) || "").toLowerCase().replace(/\/+$/, "");

// ---------- Local persistence (per-browser) ----------
const loadStore = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupt or unavailable — start fresh */ }
  return { saved: {}, seen: {}, sent: {} };
};

function scoreDeal(d, c) {
  const mult = d.asking != null && d.sde ? d.asking / d.sde : null;
  const margin = d.sde != null && d.revenueT12 ? d.sde / d.revenueT12 : null;
  const age = d.established != null ? new Date().getFullYear() - d.established : null;
  const checks = [
    { key: "Price in range", pass: d.asking != null && d.asking >= c.priceMin && d.asking <= c.priceMax, w: 20 },
    { key: `SDE ≥ ${money(c.sdeMin)}`, pass: d.sde != null && d.sde >= c.sdeMin, w: 25 },
    { key: `Multiple ≤ ${c.multMax}×`, pass: mult != null && mult <= c.multMax && mult >= 1.2, w: 25 },
    { key: `SDE margin ≥ ${Math.round(c.marginMin * 100)}%`, pass: margin != null && margin >= c.marginMin, w: 15 },
    { key: `${c.ageMin}+ yrs operating`, pass: age != null && age >= c.ageMin, w: 15 },
  ];
  const score = checks.reduce((s, ch) => s + (ch.pass ? ch.w : 0), 0);
  return { mult, margin, age, checks, score };
}

function Dial({ score }) {
  const r = 26, C = 2 * Math.PI * r;
  const color = score >= 80 ? T.green : score >= 55 ? T.brass : T.clay;
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`Fit score ${score} of 100`}>
      <circle cx="36" cy="36" r={r} fill="none" stroke={T.line} strokeWidth="6" />
      <circle cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="6"
        strokeDasharray={`${(score / 100) * C} ${C}`} strokeLinecap="round" transform="rotate(-90 36 36)" />
      <text x="36" y="34" textAnchor="middle" fontSize="17" fontWeight="700" fill={T.ink} fontFamily={T.mono}>{score}</text>
      <text x="36" y="48" textAnchor="middle" fontSize="8" letterSpacing="1.5" fill={T.inkSoft} fontFamily={T.body}>FIT</text>
    </svg>
  );
}

function Stat({ label, value, flag }) {
  return (
    <div className="min-w-0">
      <div style={{ fontFamily: T.body, fontSize: 10, letterSpacing: 1.2, color: T.inkSoft, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 600, color: flag ? T.clay : T.ink }}>{value}</div>
    </div>
  );
}

function VerifyBadge({ d }) {
  const map = {
    live: { bg: T.greenSoft, fg: T.green, label: `✓ Page verified live ${d.verifiedOn}` },
    partial: { bg: T.brassSoft, fg: T.brass, label: `⚠ Partially verified ${d.verifiedOn} — detail page blocks bots` },
    search: { bg: T.brassSoft, fg: T.brass, label: "◌ Scraped from source — click through to verify" },
  };
  const s = map[d.verify] || map.search;
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10, padding: "2px 8px", borderRadius: 999, background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

function draftEmail(deal) {
  const items = (deal.missing || []).map((m) => `  • ${m}`).join("\n");
  return `Hi,

I came across your listing for ${deal.name} and it fits my acquisition criteria. I'm a qualified buyer and I'm prepared to sign an NDA to move quickly.

To complete my initial review, could you share the following?

${items}
  • Trailing-twelve-month (T12) P&L, monthly granularity if possible
  • Seller's discretionary earnings calculation with add-backs itemized

Happy to jump on a short call this week as well.

Best regards,
Pengbo
pengbo.dev@gmail.com`;
}

function PipelinePanel({ d, criteria, onStage, onNotes }) {
  const [copied, setCopied] = useState(false);
  const stage = d.stage || "watching";
  const daysIn = d.stageAt ? Math.floor((Date.now() - d.stageAt) / 86400000) : null;
  const stageColor = (id) =>
    id === "go" ? T.green : id === "passed" ? T.clay : id === "watching" ? T.inkSoft : T.brass;
  return (
    <div className="mt-4 pt-3" style={{ borderTop: `1px dashed ${T.line}` }}>
      <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: 1.5, color: stageColor(stage) }}>
        PIPELINE — {STAGE_NEXT[stage]}
        {daysIn != null && daysIn > 0 ? ` · ${daysIn}d in stage` : ""}
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {STAGES.map((s) => {
          const active = s.id === stage;
          return (
            <button key={s.id} onClick={() => onStage(s.id)}
              title={active ? "Current stage" : `Move to "${s.label}"`}
              style={{
                fontFamily: T.mono, fontSize: 10.5, padding: "3px 9px", borderRadius: 999,
                border: `1px solid ${active ? stageColor(s.id) : T.line}`,
                background: active ? (s.id === "go" ? T.greenSoft : s.id === "passed" ? T.claySoft : T.brassSoft) : "transparent",
                color: active ? stageColor(s.id) : T.inkSoft,
                fontWeight: active ? 700 : 400,
              }}>
              {s.label}
            </button>
          );
        })}
      </div>
      <textarea key={canon(d)} defaultValue={d.notes || ""} rows={2}
        placeholder="Shared notes — broker contact, docs received, DD findings, red flags…"
        onBlur={(e) => e.target.value !== (d.notes || "") && onNotes(e.target.value)}
        className="w-full rounded-md p-2 mt-2"
        style={{ fontFamily: T.body, fontSize: 12, border: `1px solid ${T.line}`, color: T.ink, background: T.bg, resize: "vertical" }} />
      <button
        onClick={async () => {
          if (await copyText(ddPrompt(d, criteria))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          }
        }}
        className="px-3 py-1.5 rounded-md text-sm mt-1"
        style={{ border: `1px solid ${T.brass}`, color: copied ? T.green : T.brass, background: "transparent", fontWeight: 600 }}>
        {copied ? "✓ Copied — paste into claude.ai with the financials attached" : "⧉ Copy due-diligence prompt for Claude"}
      </button>
    </div>
  );
}

function DealCard({ d, criteria, saved, sentFlag, onEmail, onSave, onPass, onRestore, inSeenList, pipeline, onStage, onNotes }) {
  return (
    <article className="rounded-lg p-4" style={{ background: T.surface, border: saved ? `1.5px solid ${T.green}` : `1px solid ${T.line}` }}>
      <div className="flex gap-4">
        <div className="flex flex-col items-center gap-1">
          <Dial score={d.score} />
          <button onClick={onSave} aria-label={saved ? "Remove from saved" : "Save deal"}
            title={saved ? "Remove from saved" : "Save — pins to Saved and keeps it out of future scans"}
            style={{ fontSize: 20, background: "none", border: "none", color: saved ? T.brass : T.line, lineHeight: 1 }}>
            {saved ? "★" : "☆"}
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 style={{ fontFamily: T.display, fontSize: 18 }}>{d.name}</h2>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft }}>
              {d.source}{d.id ? ` · ${d.id}` : ""} · {d.location}
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 2 }}>{d.note}</p>
          {d.broker && <p style={{ fontFamily: T.mono, fontSize: 11, color: T.inkSoft, marginTop: 2 }}>Broker: {d.broker}</p>}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
            <a href={d.listingUrl} target="_blank" rel="noopener noreferrer"
              style={{ fontFamily: T.mono, fontSize: 11.5, color: T.green, textDecoration: "underline", textUnderlineOffset: 3 }}>
              ↗ View source listing on {d.source}
            </a>
            <VerifyBadge d={d} />
            {d.website ? (
              <a href={d.website} target="_blank" rel="noopener noreferrer"
                style={{ fontFamily: T.mono, fontSize: 11.5, color: T.green, textDecoration: "underline", textUnderlineOffset: 3 }}>
                ↗ Business website
              </a>
            ) : (
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.brass }}>
                Website not disclosed (pre-NDA) — added to info request
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3">
            <Stat label="Asking" value={money(d.asking)} flag={d.asking == null} />
            <Stat label="SDE" value={money(d.sde)} flag={d.sde == null || d.sde < criteria.sdeMin} />
            <Stat label="T12 revenue" value={money(d.revenueT12)} flag={d.revenueT12 == null} />
            <Stat label="Multiple" value={d.mult != null ? `${d.mult.toFixed(1)}×` : "—"} flag={d.mult == null || d.mult > criteria.multMax} />
            <Stat label="SDE margin" value={d.margin != null ? `${Math.round(d.margin * 100)}%` : "—"} flag={d.margin == null || d.margin < criteria.marginMin} />
          </div>

          <div className="flex flex-wrap gap-1.5 mt-3">
            {d.checks.map((ch) => (
              <span key={ch.key} style={{
                fontSize: 10.5, fontFamily: T.mono, padding: "2px 8px", borderRadius: 999,
                background: ch.pass ? T.greenSoft : T.claySoft, color: ch.pass ? T.green : T.clay,
              }}>{ch.pass ? "✓" : "✗"} {ch.key}</span>
            ))}
          </div>

          <div className="mt-3">
            <span style={{ fontSize: 10, letterSpacing: 1.2, color: T.brass, textTransform: "uppercase" }}>Missing from listing</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {d.missing.map((m) => (
                <span key={m} style={{
                  fontSize: 11, padding: "2px 8px", borderRadius: 4,
                  background: T.brassSoft, color: T.brass, border: `1px dashed ${T.brass}55`,
                }}>{m}</span>
              ))}
            </div>
          </div>

          {pipeline && <PipelinePanel d={d} criteria={criteria} onStage={onStage} onNotes={onNotes} />}

          <div className="flex flex-wrap gap-2 mt-4">
            {sentFlag ? (
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.green, padding: "6px 0" }}>
                ✓ Info request drafted — check your email app's outbox
              </span>
            ) : (
              <button onClick={onEmail}
                className="px-3 py-1.5 rounded-md text-sm font-semibold" style={{ background: T.green, color: "#fff" }}>
                Request missing info
              </button>
            )}
            {inSeenList ? (
              <button onClick={onRestore} className="px-3 py-1.5 rounded-md text-sm"
                style={{ border: `1px solid ${T.line}`, color: T.inkSoft, background: "transparent" }}>
                Restore
              </button>
            ) : (
              <button onClick={onPass} className="px-3 py-1.5 rounded-md text-sm"
                title="Hides this listing from today and every future scan"
                style={{ border: `1px solid ${T.line}`, color: T.inkSoft, background: "transparent" }}>
                Pass — don't show again
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [criteria, setCriteria] = useState({
    priceMin: 200000, priceMax: 1500000,
    // minScore starts at 0: scraped listings often omit financials, and unstated
    // figures score as failed checks — a high default cutoff would hide everything.
    sdeMin: 150000, multMax: 4.0, marginMin: 0.15, ageMin: 5, minScore: 0,
  });
  const [emailDeal, setEmailDeal] = useState(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState("today");
  const [showPassed, setShowPassed] = useState(false);

  const [store, setStore] = useState(loadStore);
  const persist = (next) => {
    setStore(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
  };

  const [keyword, setKeyword] = useState("HVAC");
  const [loc, setLoc] = useState("Texas");
  const [pool, setPool] = useState(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(POOL_KEY));
      if (cached && Array.isArray(cached.deals) && cached.deals.length) return cached.deals;
    } catch (e) { /* no cache — fall through to seeds */ }
    return SEED_DEALS;
  });
  const [lastScanAt, setLastScanAt] = useState(() => {
    try { return JSON.parse(localStorage.getItem(POOL_KEY))?.at || null; } catch (e) { return null; }
  });
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [siteStatus, setSiteStatus] = useState(null);
  const [hasScanned, setHasScanned] = useState(false);
  const [page, setPage] = useState(1);
  const [enabled, setEnabled] = useState(() => {
    try {
      const raw = localStorage.getItem(SITES_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        return Object.fromEntries(SOURCES.map((s) => [s.id, saved[s.id] !== false]));
      }
    } catch (e) { /* fresh browser */ }
    return Object.fromEntries(SOURCES.map((s) => [s.id, true]));
  });
  const toggleSite = (id) =>
    setEnabled((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem(SITES_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
      return next;
    });

  // Shared stars: when Upstash is configured server-side, /api/saved is the
  // source of truth for everyone using the app. Stars made before sharing was
  // enabled (or while offline) are pushed up on first sync.
  const [shared, setShared] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/saved");
        const data = await r.json();
        if (cancelled || !r.ok || !data.enabled) return;
        setShared(true);
        const remote = data.saved || {};
        const local = loadStore().saved || {};
        for (const [k, d] of Object.entries(local)) {
          if (!remote[k]) {
            remote[k] = d;
            fetch("/api/saved", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deal: d }),
            }).catch(() => {});
          }
        }
        setStore((prev) => {
          const next = { ...prev, saved: remote };
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
          return next;
        });
      } catch (e) { /* endpoint unreachable — stay in per-browser mode */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const isSaved = (d) => !!store.saved[canon(d)];
  const isSeen = (d) => !!store.seen[canon(d)];
  const isSent = (d) => !!store.sent[canon(d)];

  const dedupe = (arr) => {
    const seen = new Set(); const out = [];
    for (const d of arr) { const k = canon(d); if (!k || seen.has(k)) continue; seen.add(k); out.push(d); }
    return out;
  };

  const scanSite = async (siteId, kw, location, pageNum) => {
    const params = new URLSearchParams({ site: siteId, keyword: kw });
    if (location) params.set("location", location);
    if (pageNum > 1) params.set("page", String(pageNum));
    const r = await fetch(`/api/scan?${params.toString()}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || "scan failed");
    if (data.status !== "ok" && data.status !== "empty")
      throw Object.assign(new Error(data.status), { siteState: data.status });
    return (data.listings || []).map((p) => enrichListing({ ...p, source: p.source || siteId }));
  };

  const runScan = async (append = false) => {
    if (!keyword.trim() || scanning) return;
    const active = SOURCES.filter((s) => enabled[s.id]);
    if (!active.length) { setScanError("Enable at least one source site below."); return; }
    setScanning(true); setScanError(null);
    const nextPage = append ? page + 1 : 1;
    try {
      const settled = await Promise.allSettled(
        active.map((s) => scanSite(s.id, keyword.trim(), loc.trim(), nextPage))
      );
      const batch = [];
      const status = {};
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") { batch.push(...r.value); status[active[i].id] = r.value.length; }
        else { status[active[i].id] = r.reason?.siteState || "error"; }
      });
      setSiteStatus(status);
      setPage(nextPage);
      setHasScanned(true);
      const at = Date.now();
      setLastScanAt(at);
      setPool((prev) => {
        // keep what we have if a refresh comes back empty (sources may be flaky)
        const merged = batch.length ? dedupe(append ? [...prev, ...batch] : batch) : prev;
        try { localStorage.setItem(POOL_KEY, JSON.stringify({ at, deals: merged })); } catch (e) { /* private mode */ }
        return merged;
      });
      if (batch.length === 0 && !append)
        setScanError("No listings returned this round — check the per-source status below; blocked sources can be unticked.");
    } catch (err) {
      console.error(err);
      setScanError("Scan failed — try again in a moment.");
    } finally {
      setScanning(false);
    }
  };

  // Fresh browser (no local cache): bootstrap the sheet from the shared
  // server-side pool of previously scraped companies.
  useEffect(() => {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(POOL_KEY)); } catch (e) { /* none */ }
    if (cached && Array.isArray(cached.deals) && cached.deals.length) return;
    (async () => {
      try {
        const r = await fetch("/api/listings");
        const data = await r.json();
        if (r.ok && data.enabled && data.listings && data.listings.length) {
          setPool((prev) => dedupe([...prev.filter((d) => d.verify === "live"), ...data.listings.map(enrichListing)]));
        }
      } catch (e) { /* pool store not configured — seeds remain */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh: scan on load when the cached pool is older than 5 hours, then
  // re-scan every 5 hours while the tab stays open (matches server cache + cron).
  const scanRef = useRef(runScan);
  scanRef.current = runScan;
  useEffect(() => {
    if (!lastScanAt || Date.now() - lastScanAt > REFRESH_MS) scanRef.current(false);
    const iv = setInterval(() => scanRef.current(false), REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scored = useMemo(
    () => dedupe(pool).map((d) => ({ ...d, ...scoreDeal(d, criteria) })),
    [pool, criteria]
  );
  const fresh = scored.filter((d) => !isSeen(d) && !isSaved(d));
  const visible = fresh.filter((d) => d.score >= criteria.minScore).sort((a, b) => b.score - a.score);
  const belowCut = fresh.length - visible.length;
  const passedList = scored.filter((d) => isSeen(d));
  // Active pipeline deals first (furthest along on top), passed ones sink.
  const stageRank = (d) => STAGES.findIndex((s) => s.id === (d.stage || "watching"));
  const savedList = useMemo(
    () =>
      Object.values(store.saved)
        .map((d) => ({ ...d, ...scoreDeal(d, criteria) }))
        .sort((a, b) =>
          (a.stage === "passed") - (b.stage === "passed") || stageRank(b) - stageRank(a) || b.score - a.score
        ),
    [store.saved, criteria]
  );

  const toggleSave = (d) => {
    const k = canon(d);
    const next = { ...store, saved: { ...store.saved } };
    const removing = !!next.saved[k];
    if (removing) delete next.saved[k];
    else {
      const { checks, score, mult, margin, age, ...snapshot } = d;
      next.saved[k] = { ...snapshot, savedOn: TODAY, stage: "watching", stageAt: Date.now(), notes: "" };
    }
    persist(next);
    if (shared) {
      (removing
        ? fetch(`/api/saved?url=${encodeURIComponent(k)}`, { method: "DELETE" })
        : fetch("/api/saved", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deal: next.saved[k] }),
          })
      ).catch(() => {});
    }
  };
  // Patch a saved deal (stage/notes) and sync it to the shared store.
  const updateSaved = (k, patch) => {
    const cur = store.saved[k];
    if (!cur) return;
    const deal = { ...cur, ...patch };
    persist({ ...store, saved: { ...store.saved, [k]: deal } });
    if (shared) {
      fetch("/api/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal }),
      }).catch(() => {});
    }
  };

  const markSeen = (d) => persist({ ...store, seen: { ...store.seen, [canon(d)]: { on: TODAY, name: d.name } } });
  const restore = (d) => {
    const next = { ...store, seen: { ...store.seen } };
    delete next.seen[canon(d)];
    persist(next);
  };
  const openEmail = (d) => { setEmailDeal(d); setDraft(draftEmail(d)); };
  const sendViaMailApp = () => {
    const subject = `Buyer inquiry — ${emailDeal.name}${emailDeal.id ? ` (Listing ${emailDeal.id})` : ""}`;
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}`;
    persist({ ...store, sent: { ...store.sent, [canon(emailDeal)]: TODAY } });
    setEmailDeal(null);
  };

  const set = (k, v) => setCriteria((c) => ({ ...c, [k]: v }));
  const num = (k, label, step, fmt = money) => (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", color: T.inkSoft }}>{label}</div>
      <div className="flex items-center gap-1 mt-1">
        <button onClick={() => set(k, Math.max(0, criteria[k] - step))} aria-label={`decrease ${label}`}
          className="w-6 h-6 rounded" style={{ border: `1px solid ${T.line}`, color: T.inkSoft, fontSize: 12 }}>–</button>
        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 600, color: T.ink, minWidth: 62, textAlign: "center" }}>
          {fmt(criteria[k])}
        </span>
        <button onClick={() => set(k, criteria[k] + step)} aria-label={`increase ${label}`}
          className="w-6 h-6 rounded" style={{ border: `1px solid ${T.line}`, color: T.inkSoft, fontSize: 12 }}>+</button>
      </div>
    </div>
  );

  const cardProps = (d, opts = {}) => ({
    d, criteria,
    saved: isSaved(d),
    sentFlag: isSent(d),
    onEmail: () => openEmail(d),
    onSave: () => toggleSave(d),
    onPass: () => markSeen(d),
    onRestore: () => restore(d),
    inSeenList: !!opts.inSeenList,
    pipeline: !!opts.pipeline,
    onStage: (stage) => updateSaved(canon(d), { stage, stageAt: Date.now() }),
    onNotes: (notes) => updateSaved(canon(d), { notes }),
  });

  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)}
      className="px-4 py-1.5 rounded-full text-sm font-semibold"
      style={{
        background: tab === id ? T.green : "transparent",
        color: tab === id ? "#fff" : T.inkSoft,
        border: `1px solid ${tab === id ? T.green : T.line}`,
      }}>{label}</button>
  );

  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: T.body, color: T.ink }}>
      <style>{`
        button { cursor: pointer; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${T.green}; outline-offset: 2px; }
        input::placeholder { color: ${T.inkSoft}; opacity: 0.7; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
        @keyframes pulse-dot { 0%,100% { opacity: 0.3 } 50% { opacity: 1 } }
      `}</style>

      <header className="px-6 pt-6 pb-4" style={{ borderBottom: `1px solid ${T.line}` }}>
        <div className="max-w-5xl mx-auto flex flex-wrap items-end justify-between gap-3">
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 2, color: T.green }}>MARKET SCRAPE · {TODAY.toUpperCase()} · {SOURCES.length} SOURCES · REFRESHES EVERY 5H</div>
            <h1 style={{ fontFamily: T.display, fontSize: 30, lineHeight: 1.1, marginTop: 6 }}>Acquisition screen</h1>
          </div>
          <div className="text-right">
            <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 600 }}>
              {visible.length} above fit {criteria.minScore} · {savedList.length} saved · {passedList.length} passed
            </div>
            <div style={{ fontSize: 12, color: T.inkSoft }}>Email digest every 5 hours → pengbo.dev@gmail.com</div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.green, marginTop: 2 }}>
              ● Direct scrape — no AI · {shared ? "★ shared with your team" : "★ this browser only"}
              {lastScanAt ? ` · last refresh ${new Date(lastScanAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6">
        <section className="flex flex-col gap-4">
          <div className="rounded-lg p-4" style={{ background: T.surface, border: `1px solid ${T.line}` }}>
            <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 2, color: T.green, marginBottom: 8 }}>
              SCRAPE — {SOURCES.filter((s) => enabled[s.id]).length} OF {SOURCES.length} SOURCES ENABLED · AUTO-REFRESH EVERY 5 HOURS
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runScan(false)}
                placeholder="Business type or keyword — laundromat, landscaping, SaaS…"
                className="flex-1 rounded-md px-3 py-2"
                style={{ border: `1px solid ${T.line}`, fontSize: 13, fontFamily: T.body, color: T.ink, background: T.bg }} />
              <input value={loc} onChange={(e) => setLoc(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runScan(false)}
                placeholder="Location (optional)"
                className="sm:w-44 rounded-md px-3 py-2"
                style={{ border: `1px solid ${T.line}`, fontSize: 13, fontFamily: T.body, color: T.ink, background: T.bg }} />
              <button onClick={() => runScan(false)} disabled={scanning || !keyword.trim()}
                className="px-4 py-2 rounded-md text-sm font-semibold"
                style={{ background: scanning || !keyword.trim() ? T.line : T.green, color: scanning || !keyword.trim() ? T.inkSoft : "#fff" }}>
                {scanning ? "Scraping…" : "Refresh now"}
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 mt-3">
              {SOURCES.map((s) => {
                const on = enabled[s.id];
                const st = siteStatus ? siteStatus[s.id] : undefined;
                const stText =
                  st === undefined || !on ? null
                    : typeof st === "number" ? `${st} found`
                    : st === "blocked" ? "blocked"
                    : "error";
                const stColor = typeof st === "number" ? (st > 0 ? T.green : T.brass) : T.clay;
                return (
                  <button key={s.id} onClick={() => toggleSite(s.id)}
                    title={on ? "Click to exclude this source from scans" : "Click to include this source"}
                    style={{
                      fontFamily: T.mono, fontSize: 11, padding: "3px 10px", borderRadius: 999,
                      border: `1px solid ${on ? T.green : T.line}`,
                      background: on ? T.greenSoft : "transparent",
                      color: on ? T.green : T.inkSoft,
                    }}>
                    {on ? "☑" : "☐"} {s.label}
                    {stText && <span style={{ color: stColor }}> · {stText}</span>}
                  </button>
                );
              })}
            </div>

            {scanning && (
              <div className="flex items-center gap-2 mt-3" style={{ fontFamily: T.mono, fontSize: 12, color: T.green }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: T.green, animation: "pulse-dot 1s infinite" }} />
                Scraping {SOURCES.filter((s) => enabled[s.id]).length} sources in parallel for "{keyword.trim()}"…
              </div>
            )}
            {scanError && (
              <div className="mt-3 rounded-md px-3 py-2" style={{ background: T.claySoft, color: T.clay, fontSize: 12.5 }}>
                {scanError}
              </div>
            )}

            <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${T.line}` }}>
              <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 2, color: T.green, marginBottom: 10 }}>
                THE BUY BOX — FILTERS
              </div>
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                {num("priceMin", "Asking, min", 50000)}
                {num("priceMax", "Asking, max", 50000)}
                {num("sdeMin", "SDE floor", 25000)}
                {num("multMax", "Max multiple", 0.5, (v) => `${v.toFixed(1)}×`)}
                {num("marginMin", "Min SDE margin", 0.05, (v) => `${Math.round(v * 100)}%`)}
                {num("ageMin", "Min yrs operating", 1, (v) => `${v} yr`)}
                {num("minScore", "Min FIT score", 5, (v) => `${v}`)}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {tabBtn("today", `Deals above fit ${criteria.minScore} (${visible.length})`)}
            {tabBtn("saved", `★ Pipeline (${savedList.length})`)}
          </div>

          {tab === "today" && (
            <>
              {belowCut > 0 && (
                <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkSoft }}>
                  {belowCut} listing{belowCut > 1 ? "s" : ""} hidden below fit {criteria.minScore} — lower the Min FIT filter to see {belowCut > 1 ? "them" : "it"}.
                </div>
              )}
              {visible.length === 0 ? (
                <div className="rounded-lg p-5 text-center" style={{ background: T.surface, border: `1px solid ${T.line}` }}>
                  <div style={{ fontFamily: T.display, fontSize: 16 }}>
                    {hasScanned || belowCut > 0 ? "Nothing above the fit cutoff" : "Run a scan to fill the sheet"}
                  </div>
                  <p style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 4 }}>
                    {hasScanned || belowCut > 0
                      ? "Try Load more, broaden the keyword, lower the Min FIT filter, or check which sources are responding above."
                      : "Enter a keyword above and scrape all enabled sources in parallel — it also refreshes itself every 5 hours."}
                  </p>
                </div>
              ) : (
                visible.map((d) => <DealCard key={canon(d)} {...cardProps(d)} />)
              )}

              {visible.length > 0 && (
                <button onClick={() => runScan(true)} disabled={scanning}
                  className="px-4 py-2 rounded-md text-sm font-semibold self-center"
                  style={{ border: `1px solid ${T.green}`, color: T.green, background: "transparent" }}>
                  {scanning ? "Scraping…" : "Load more — pull the next page from each source"}
                </button>
              )}

              {passedList.length > 0 && (
                <div>
                  <button onClick={() => setShowPassed(!showPassed)}
                    style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkSoft, background: "none", border: "none", textDecoration: "underline", textUnderlineOffset: 3 }}>
                    {showPassed ? "▾ Hide" : "▸ Show"} {passedList.length} passed listing{passedList.length > 1 ? "s" : ""} (hidden from all future scans)
                  </button>
                  {showPassed && (
                    <div className="flex flex-col gap-4 mt-3" style={{ opacity: 0.6 }}>
                      {passedList.map((d) => <DealCard key={canon(d)} {...cardProps(d, { inSeenList: true })} />)}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {tab === "saved" && (
            savedList.length === 0 ? (
              <div className="rounded-lg p-5 text-center" style={{ background: T.surface, border: `1px solid ${T.line}` }}>
                <div style={{ fontFamily: T.display, fontSize: 16 }}>No deals in the pipeline yet</div>
                <p style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 4 }}>
                  Tap the ☆ on any deal to start tracking it here — inquiry → form → NDA → docs → due
                  diligence → decision. {shared
                    ? "The pipeline is shared: everyone who opens this app sees the same deals, stages and notes."
                    : "The pipeline lives in this browser only (add Upstash env vars in Vercel to share it)."} Saved deals never reappear in scans.
                </p>
              </div>
            ) : (
              savedList.map((d) => <DealCard key={canon(d)} {...cardProps(d, { pipeline: true })} />)
            )
          )}
        </section>
      </main>

      {emailDeal && (
        <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: "rgba(28,43,37,0.5)" }}
          role="dialog" aria-modal="true" aria-label="Broker email draft">
          <div className="w-full max-w-lg rounded-lg p-5" style={{ background: T.surface }}>
            <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 2, color: T.green }}>
              DRAFT — OPENS IN YOUR EMAIL APP · PASTE THE BROKER'S ADDRESS FROM THE LISTING
            </div>
            <h3 style={{ fontFamily: T.display, fontSize: 18, margin: "6px 0 10px" }}>{emailDeal.name}</h3>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={14}
              className="w-full rounded-md p-3"
              style={{ fontFamily: T.mono, fontSize: 12, lineHeight: 1.55, border: `1px solid ${T.line}`, color: T.ink, resize: "vertical" }} />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setEmailDeal(null)} className="px-3 py-1.5 rounded-md text-sm"
                style={{ border: `1px solid ${T.line}`, color: T.inkSoft, background: "transparent" }}>Cancel</button>
              <button onClick={sendViaMailApp} className="px-4 py-1.5 rounded-md text-sm font-semibold"
                style={{ background: T.green, color: "#fff" }}>Open in email app</button>
            </div>
          </div>
        </div>
      )}

      <footer className="max-w-5xl mx-auto px-6 pb-8">
        <p style={{ fontSize: 11, color: T.inkSoft }}>
          Listings are scraped directly from the enabled sources (no AI involved) and auto-refresh every
          5 hours; big marketplaces that block bots are read via public search indexes instead. The chips
          above show which sources responded on the last pass — untick any that report "blocked". Only
          listings above the Min FIT cutoff are shown; unstated figures count as failed checks, never
          estimates. Saves, passes and drafts persist in this browser, keyed by listing URL.
        </p>
      </footer>
    </div>
  );
}
