// Shared scraping library — NO LLM, NO API keys. Plain fetch + HTML/RSS parsing.
//
// Two kinds of sources:
//  - "direct":        broker/marketplace sites without bot walls — we fetch their
//                     search page and extract listing cards from the HTML.
//  - "search-index":  the big marketplaces (BizBuySell, BizQuest, BFS) run
//                     Akamai/Cloudflare bot protection that blocks datacenter IPs,
//                     so we read their listings out of public search indexes
//                     instead (Bing RSS first, DuckDuckGo HTML as fallback).
//
// Every scan returns { site, label, status, httpStatus, listings } so the UI can
// show which sources are currently valid and let the user pick from them.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// URL helpers — every source's browse pages are slug-based (verified against
// real indexed URLs), e.g. bizbuysell.com/texas/hvac-businesses-for-sale/.
const kwSlug = (s) =>
  String(s || "").toLowerCase().trim().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, "-");

const STATE_NAMES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida",
  "georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine",
  "maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska",
  "nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio",
  "oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas",
  "utah","vermont","virginia","washington","west virginia","wisconsin","wyoming",
];
const ABBR_TO_NAME = {
  al:"alabama",ak:"alaska",az:"arizona",ar:"arkansas",ca:"california",co:"colorado",ct:"connecticut",
  de:"delaware",fl:"florida",ga:"georgia",hi:"hawaii",id:"idaho",il:"illinois",in:"indiana",ia:"iowa",
  ks:"kansas",ky:"kentucky",la:"louisiana",me:"maine",md:"maryland",ma:"massachusetts",mi:"michigan",
  mn:"minnesota",ms:"mississippi",mo:"missouri",mt:"montana",ne:"nebraska",nv:"nevada",nh:"new hampshire",
  nj:"new jersey",nm:"new mexico",ny:"new york",nc:"north carolina",nd:"north dakota",oh:"ohio",
  ok:"oklahoma",or:"oregon",pa:"pennsylvania",ri:"rhode island",sc:"south carolina",sd:"south dakota",
  tn:"tennessee",tx:"texas",ut:"utah",vt:"vermont",va:"virginia",wa:"washington",wv:"west virginia",
  wi:"wisconsin",wy:"wyoming",
};
// "Texas" / "TX" → "texas"; cities and anything else → null (the post-scan
// location filter still applies — the URL just stays un-scoped).
export function stateSlug(loc) {
  const l = String(loc || "").trim().toLowerCase();
  if (!l) return null;
  if (STATE_NAMES.includes(l)) return l.replace(/ /g, "-");
  if (ABBR_TO_NAME[l]) return ABBR_TO_NAME[l].replace(/ /g, "-");
  return null;
}
const pageQ = (page) => (page > 1 ? `?page=${page}` : "");

export const SOURCES = {
  bizbuysell: {
    label: "BizBuySell",
    kind: "search-index",
    domain: "bizbuysell.com",
    scope: "bizbuysell.com/business-opportunity",
    detailRe: /bizbuysell\.com\/(?:business-opportunity|business-auction)\//i,
    // Real format: bizbuysell.com/{state}/{kw}-businesses-for-sale/
    pageUrl: (kw, loc, page) => {
      const st = stateSlug(loc);
      const k = kwSlug(kw);
      const path = `${st ? `${st}/` : ""}${k ? `${k}-` : ""}businesses-for-sale/`;
      return `https://www.bizbuysell.com/${path}${pageQ(page)}`;
    },
  },
  businessesforsale: {
    label: "BusinessesForSale.com",
    kind: "search-index",
    domain: "businessesforsale.com",
    scope: "us.businessesforsale.com",
    detailRe: /businessesforsale\.com\/[^\s"']*\.aspx/i,
    pageUrl: (kw) =>
      `https://us.businessesforsale.com/search/businesses-for-sale?Keywords=${encodeURIComponent(kw)}`,
  },
  bizquest: {
    label: "BizQuest",
    kind: "search-index",
    domain: "bizquest.com",
    scope: "bizquest.com/business-for-sale",
    detailRe: /bizquest\.com\/business-for-sale\//i,
    // Real format: bizquest.com/{kw}-businesses-for-sale-in-{state}/
    pageUrl: (kw, loc, page) => {
      const st = stateSlug(loc);
      const k = kwSlug(kw);
      let path;
      if (k && st) path = `${k}-businesses-for-sale-in-${st}`;
      else if (k) path = `${k}-businesses-for-sale`;
      else if (st) path = `${st}-businesses-for-sale`;
      else path = "businesses-for-sale";
      return `https://www.bizquest.com/${path}/${pageQ(page)}`;
    },
  },
  // (DealStream was removed: it CAPTCHA-blocks every access path we have —
  // direct, Jina Reader, and search-index snippets — so it only ever showed 0.)
  businessbroker: {
    label: "BusinessBroker.net",
    kind: "direct",
    domain: "businessbroker.net",
    // Real formats: /state/{state}-businesses-for-sale.aspx (browse) and
    // /business-for-sale/{slug}/{id}.aspx (detail). No keyword browse URL —
    // listings are keyword-filtered after extraction (kwFilter).
    searchUrl: (kw, loc, page) => {
      const st = stateSlug(loc);
      return st
        ? `https://www.businessbroker.net/state/${st}-businesses-for-sale.aspx${pageQ(page)}`
        : `https://www.businessbroker.net/${pageQ(page)}`;
    },
    linkRe: /business-for-sale\//i,
    kwFilter: true,
  },
  synergybb: {
    label: "Synergy Business Brokers",
    kind: "direct",
    domain: "synergybb.com",
    // Real format: synergybb.com/businesses-for-sale/{state}/ (browse).
    searchUrl: (kw, loc, page) => {
      const st = stateSlug(loc);
      return `https://synergybb.com/businesses-for-sale/${st ? `${st}/` : ""}${pageQ(page)}`;
    },
    linkRe: /(businesses?-for-sale|listings?)\/[a-z0-9-]{8,}/i,
    detailOk: /synergybb\.com\/listings\/[a-z0-9-]{8,}/i, // real detail namespace
    kwFilter: true,
  },
  sunbelt: {
    label: "Sunbelt Network",
    kind: "direct",
    domain: "sunbeltnetwork.com",
    // Real formats: /business-search/business-results/state-{state}/ (browse);
    // details at .../listing-details/{slug}/ or /business-search/business-details/{slug}/
    searchUrl: (kw, loc, page) => {
      const st = stateSlug(loc);
      return st
        ? `https://www.sunbeltnetwork.com/business-search/business-results/state-${st}/${pageQ(page)}`
        : `https://www.sunbeltnetwork.com/business-search/${pageQ(page)}`;
    },
    linkRe: /(listing-details|business-details)\//i,
    detailOk: /(listing-details|business-details)\//i, // ID-style slugs can be short
    kwFilter: true,
  },
};

export const SOURCE_IDS = Object.keys(SOURCES);

// ---------- small utilities ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#38": "&" };
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&(#?x?[0-9a-z]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] != null) return ENTITIES[k];
      if (k[0] === "#") {
        const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(n) && n > 31 ? String.fromCodePoint(n) : m;
      }
      return m;
    });
}

export function stripTags(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

export function parseMoney(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(million|mil\b|mm\b|thousand|[kKmM])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const suf = (m[2] || "").toLowerCase();
  if (suf.startsWith("m")) n *= 1e6;
  else if (suf === "thousand" || suf === "k") n *= 1e3;
  n = Math.round(n);
  return n >= 1000 && n < 1e9 ? n : null; // ignore junk numbers
}

// Financial fields stated in plain text near/inside a listing card.
// Between a label and its value pages put colons, dashes, markdown bold (**),
// pipes, or nothing at all — tolerate all of it. Amounts can be "$675,000",
// "$1.2M", or "$1.2 million".
const AMOUNT = "([\\d.,]+\\s*(?:million|mil\\b|mm\\b|thousand|[kKmM])?)";
const SEP = "(?:\\s|from|approx\\.?|[:*_~≈()\\-–—|])*";
const FIELDS = {
  asking: new RegExp(`(?:asking\\s*price|asking|list(?:ed)?\\s*price|sale\\s*price|price)${SEP}\\$\\s*${AMOUNT}`, "i"),
  sde: new RegExp(`(?:cash\\s*flow|sde\\b|seller'?s\\s*discretionary\\s*earnings|discretionary\\s*earnings|net\\s*profit)${SEP}\\$\\s*${AMOUNT}`, "i"),
  revenueT12: new RegExp(`(?:gross\\s*revenue|revenue|gross\\s*sales|annual\\s*sales|sales|gross\\s*income|(?:business\\s*)?making)${SEP}\\$\\s*${AMOUNT}`, "i"),
};
const ESTABLISHED_RE = /(?:established|est\.?|founded)\s*(?:in\s*)?[:\-–]?\s*((?:19|20)\d{2})/i;
// "City, ST" or "City Name, Texas" — every word must be capitalized so lead-ins
// like "Located in" don't get swallowed into the city name.
const LOCATION_RE = /\b([A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+){0,3},\s*(?:[A-Z]{2}\b|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?))/;

export function extractFields(text) {
  const out = { asking: null, sde: null, revenueT12: null, established: null, location: null };
  // Grid/table cards (e.g. Synergy) render labels in one row and values in the
  // next: "Price  Revenue  Cash Flow  $3.5M  $8M  $1.2M". When labels and
  // amounts appear in equal count with ALL labels before ANY amount, zip them
  // by position — and do it BEFORE the adjacency pass, which would otherwise
  // pair the last header label with the first value.
  {
    const labelRe = /\b(asking\s*price|price|annual\s*revenue|gross\s*revenue|revenue|cash\s*flow|sde)\b/gi;
    const moneyRe = /\$\s*[\d.,]+\s*(?:million|mil\b|mm\b|thousand|[kKmM])?/gi;
    const labels = [...text.matchAll(labelRe)];
    const monies = [...text.matchAll(moneyRe)];
    if (labels.length >= 2 && labels.length === monies.length && labels[labels.length - 1].index < monies[0].index) {
      const fieldOf = (lab) =>
        /price/i.test(lab) ? "asking" : /revenue/i.test(lab) ? "revenueT12" : "sde";
      labels.forEach((l, i) => {
        const f = fieldOf(l[1]);
        if (out[f] == null) out[f] = parseMoney(monies[i][0]);
      });
    }
  }
  for (const [k, re] of Object.entries(FIELDS)) {
    if (out[k] != null) continue;
    const m = text.match(re);
    if (m) out[k] = parseMoney(m[1]);
  }
  // Cards often show one bare price with no label ("Austin, TX · $675,000").
  // If NOTHING was labeled and there is exactly one money amount, it's the
  // asking price; with several unlabeled amounts we stay at "Not stated"
  // rather than guess.
  if (out.asking == null && out.sde == null && out.revenueT12 == null) {
    const monies = text.match(/\$\s*[\d.,]+\s*(?:million|mil\b|mm\b|thousand|[kKmM])?/gi) || [];
    const parsed = [...new Set(monies.map((t) => parseMoney(t)).filter(Boolean))];
    if (parsed.length === 1) out.asking = parsed[0];
  }
  const est = text.match(ESTABLISHED_RE);
  if (est) out.established = Number(est[1]);
  const loc = text.match(LOCATION_RE);
  if (loc) out.location = loc[1].trim();
  return out;
}

export async function fetchPage(url, extraHeaders = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
    });
    const body = await r.text();
    return { status: r.status, body };
  } catch (err) {
    return { status: 0, body: "", error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(t);
  }
}

// Vercel functions run on datacenter IPs that most sites (and Bing/DDG) refuse.
// Jina's public Reader fetches the page from its own infrastructure and returns
// markdown — free and keyless (rate-limited, but our 5h edge cache absorbs that).
export async function fetchViaJina(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 14000);
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers: { accept: "text/plain, text/markdown, */*", "user-agent": UA },
    });
    const body = await r.text();
    return { status: r.status, body };
  } catch (err) {
    return { status: 0, body: "", error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(t);
  }
}

// CTA/navigation link text, not company listings: "Sell a business", "Find a
// broker", "Businesses for sale in Texas", etc.
const BAD_NAME_RE = /^(view|read|see|more|contact|learn|details?|photos?|next|prev|previous|sign|log|home|about|search|browse|save|share|email|print|sell|buy|find|get|why|how|what|advertise|value|list your|register|join|start|compare|explore|discover|franchises?\b|businesse?s? for sale|business brokers?|brokers?\b|page \d)/i;

function cleanName(s) {
  const name = stripTags(s).replace(/\s+/g, " ").trim();
  if (name.length < 10 || name.length > 140) return null;
  if (BAD_NAME_RE.test(name)) return null;
  if (name.split(" ").length < 3) return null;
  return name;
}

// Listing detail pages carry a numeric ID or a long hyphenated slug; category
// and navigation pages (/sell-a-business/, /find-a-broker/) don't.
function looksLikeDetail(u) {
  try {
    const path = new URL(u).pathname.replace(/\/+$/, "");
    const last = (path.split("/").pop() || "").replace(/\.aspx$/i, "");
    // browse/category pages ("hvac-businesses-for-sale-in-texas") are never listings
    if (/businesses-for-sale/.test(last)) return false;
    if (/\d{5,}/.test(path)) return true;
    return last.length >= 18 && last.includes("-");
  } catch {
    return false;
  }
}

// A source can mark its own detail-URL shape (e.g. DealStream's short /d/ slugs
// that the generic heuristic would reject).
const isDetail = (u, src) => looksLikeDetail(u) || !!(src && src.detailOk && src.detailOk.test(u));

// Search engines wrap result links in redirects — Bing: /ck/a?u=a1<base64url>,
// DDG: ?uddg=<encoded>. Unwrap to the real marketplace URL before matching.
export function unwrapRedirect(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname.startsWith("/ck")) {
      const p = u.searchParams.get("u");
      if (p && p.startsWith("a1")) {
        const b64 = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const decoded = Buffer.from(pad, "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch { /* not a URL or not a redirect — use as-is */ }
  return href;
}

// "profitable-austin-area-hvac" -> "Profitable Austin Area Hvac"
function nameFromSlug(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const slug = (segs.reverse().find((x) => /[a-z]-[a-z]/i.test(x)) || "").replace(/\.aspx$/i, "");
    const words = slug.split("-").filter((w) => w && !/^\d+$/.test(w));
    if (words.length < 3) return null;
    return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ").slice(0, 120);
  } catch {
    return null;
  }
}

// Hard location filter: sources return nationwide results no matter what the
// query asks for, so when a location is set, a listing must actually mention it.
const STATE_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const STATE_ABBR_SET = new Set(Object.values(STATE_ABBR));

export function locationMatches(listing, location) {
  if (!location || !location.trim()) return true;
  const wanted = location.trim().toLowerCase();
  const hayRaw = `${listing.location || ""} ${listing.name || ""} ${listing.note || ""}`;
  const hay = hayRaw.toLowerCase();
  if (hay.includes(wanted)) return true;
  const abbr = STATE_ABBR[wanted] || (/^[a-z]{2}$/.test(wanted) ? wanted.toUpperCase() : null);
  if (abbr && new RegExp(`\\b${abbr}\\b`).test(hayRaw)) return true;
  // No affirmative match. Most listings simply don't state a location — keep
  // those (dropping them empties every scan). Drop only when the listing
  // clearly names a DIFFERENT US state (", AZ" form or a full state name).
  const statedAbbrs = [...hayRaw.matchAll(/,\s*([A-Z]{2})\b/g)].map((m) => m[1]);
  if (statedAbbrs.some((s) => STATE_ABBR_SET.has(s) && s !== abbr)) return false;
  for (const name of Object.keys(STATE_ABBR)) {
    if (name !== wanted && new RegExp(`\\b${name}\\b`).test(hay)) return false;
  }
  return true;
}

function makeListing(src, name, url, text, priceHint) {
  const f = extractFields(text);
  // Some index layouts print the price in a label line just BEFORE the title
  // link; consult that slice only when the forward window found no figure.
  if (priceHint && f.asking == null && f.sde == null && f.revenueT12 == null) {
    const pf = extractFields(priceHint);
    f.asking = pf.asking;
    f.sde = pf.sde;
    f.revenueT12 = pf.revenueT12;
  }
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 180);
  return {
    name,
    source: src.label,
    broker: null,
    location: f.location || "Not stated",
    asking: f.asking,
    sde: f.sde,
    revenueT12: f.revenueT12,
    established: f.established,
    listingUrl: url,
    website: null,
    verify: "search",
    verifiedOn: null,
    note: snippet,
  };
}

function dedupeByUrl(listings, cap = 30) {
  const seen = new Set();
  const out = [];
  for (const l of listings) {
    const k = (l.listingUrl || "").toLowerCase().replace(/\/+$/, "");
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(l);
    if (out.length >= cap) break;
  }
  return out;
}

// ---------- JSON-LD (schema.org) extraction — most reliable when present ----------

function walkJsonLd(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => walkJsonLd(n, out));
  const type = String(node["@type"] || "");
  if (/Product|Offer|ListItem/i.test(type) || node.offers) {
    const name = node.name || (node.item && node.item.name);
    const url = node.url || (node.item && node.item.url);
    const offers = node.offers || (node.item && node.item.offers);
    const price = offers && (offers.price || (Array.isArray(offers) && offers[0] && offers[0].price));
    if (name && url) out.push({ name: String(name), url: String(url), price: price != null ? parseMoney(price) : null });
  }
  for (const v of Object.values(node)) walkJsonLd(v, out);
}

export function extractJsonLd(html, baseUrl) {
  const out = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      walkJsonLd(JSON.parse(m[1].trim()), out);
    } catch { /* malformed block — skip */ }
  }
  const seen = new Set();
  return out
    .map((e) => {
      try {
        return { ...e, url: new URL(e.url, baseUrl).href };
      } catch {
        return null;
      }
    })
    .filter((e) => {
      if (!e || seen.has(e.url)) return false; // nested ListItem/Product can yield dupes
      seen.add(e.url);
      return true;
    });
}

// ---------- generic HTML card extraction for "direct" sources ----------

export function extractFromHtml(html, baseUrl, linkRe, src) {
  const listings = [];

  for (const ld of extractJsonLd(html, baseUrl)) {
    const name = cleanName(ld.name);
    if (!name) continue;
    const l = makeListing(src, name, ld.url, "");
    if (ld.price) l.asking = ld.price;
    listings.push(l);
  }

  const anchors = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,600}?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    anchors.push({ href: m[1], inner: m[2], index: m.index });
  }
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    let abs, path;
    try {
      abs = new URL(unwrapRedirect(new URL(decodeEntities(a.href), baseUrl).href));
      path = abs.pathname;
    } catch {
      continue;
    }
    if (!(linkRe.test(path) || linkRe.test(abs.href))) continue;
    if (!isDetail(abs.href, src)) continue;
    const name = cleanName(a.inner);
    if (!name) continue;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : a.index + 3000;
    const windowText = stripTags(html.slice(a.index, Math.min(end, a.index + 3000)));
    listings.push(makeListing(src, name, abs.href, windowText));
  }

  return dedupeByUrl(listings);
}

// ---------- markdown extraction (for pages fetched via Jina Reader) ----------

export function extractFromMarkdown(md, linkRe, src) {
  const items = [];
  const linkMd = /\[([^\]]{3,300}?)\]\((https?:\/\/[^)\s]+)\)/g;
  const matches = [];
  let m;
  while ((m = linkMd.exec(md))) matches.push({ text: m[1], url: unwrapRedirect(m[2]), index: m.index });
  for (let i = 0; i < matches.length; i++) {
    const a = matches[i];
    let path;
    try {
      path = new URL(a.url).pathname;
    } catch {
      continue;
    }
    if (!(linkRe.test(path) || linkRe.test(a.url))) continue;
    if (!isDetail(a.url, src)) continue;
    const name = cleanName(a.text.replace(/!\[[^\]]*\]/g, " "));
    if (!name) continue;
    const end = i + 1 < matches.length ? matches[i + 1].index : a.index + 2500;
    const windowText = md
      .slice(a.index, Math.min(end, a.index + 2500))
      .replace(/[\\*_#>|\[\]()]/g, " ")
      .replace(/\s+/g, " ");
    // Index cards often print "Asking Price: $X" just BEFORE the title link.
    // Pass a short preceding slice (clamped to the previous card) so money is
    // found there when the forward window has none — kept tight to avoid
    // bleeding the previous card's price/location into this one.
    const preStart = Math.max(i > 0 ? matches[i - 1].index : 0, a.index - 120);
    const preText = md.slice(preStart, a.index).replace(/[\\*_#>|\[\]()]/g, " ").replace(/\s+/g, " ");
    items.push(makeListing(src, name, a.url, windowText, preText));
  }
  if (items.length) return dedupeByUrl(items);

  // No markdown-syntax links matched — some renders list bare URLs instead.
  // Extract those, deriving a name from the URL slug.
  const bare = [...md.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)];
  for (let i = 0; i < bare.length; i++) {
    const url = unwrapRedirect(bare[i][0].replace(/[.,;:]+$/, ""));
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    if (!(linkRe.test(path) || linkRe.test(url))) continue;
    if (!isDetail(url, src)) continue;
    const name = nameFromSlug(url);
    if (!name) continue;
    const end = i + 1 < bare.length ? bare[i + 1].index : bare[i].index + 1500;
    const windowText = md.slice(bare[i].index, Math.min(end, bare[i].index + 1500)).replace(/[\\*_#>|\[\]()]/g, " ").replace(/\s+/g, " ");
    const preStart = Math.max(i > 0 ? bare[i - 1].index : 0, bare[i].index - 120);
    const preText = md.slice(preStart, bare[i].index).replace(/[\\*_#>|\[\]()]/g, " ").replace(/\s+/g, " ");
    items.push(makeListing(src, name, url, windowText, preText));
  }
  return dedupeByUrl(items);
}

// ---------- search-index adapters (for bot-walled marketplaces) ----------

function parseBingRss(xml, src) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const t = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
      return t ? decodeEntities(t[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim() : "";
    };
    const link = pick("link");
    const title = stripTags(pick("title"));
    const desc = stripTags(pick("description"));
    if (!link || !src.detailRe.test(link) || !isDetail(link, src)) continue;
    const name = cleanName(title.replace(new RegExp(`\\s*[-|·]\\s*${src.label}.*$`, "i"), "")) || cleanName(title);
    if (!name) continue;
    items.push(makeListing(src, name, link, `${title} ${desc}`));
  }
  return items;
}

function parseDdgHtml(html, src) {
  const items = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/gi;
  let m;
  while ((m = blockRe.exec(html))) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    const dre = src.detailRe || src.linkRe;
    if ((dre && !dre.test(href)) || !isDetail(href, src)) continue;
    const name = cleanName(m[2]);
    if (!name) continue;
    const snippetMatch = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    items.push(makeListing(src, name, href, `${stripTags(m[2])} ${snippet}`));
  }
  return dedupeByUrl(items);
}

const note = (attempts, via, url, r, found) =>
  attempts.push({
    via, url, httpStatus: r.status, found,
    sample: (r.body || r.error || "").slice(0, via === "jina-reader" ? 900 : 160),
  });

// Last-resort stage for every source: have Jina fetch Bing's results for a
// site:-scoped query. The marketplaces' own pages can bot-wall even Jina, but
// Bing's SERP (fetched from Jina's infra) lists their listing URLs + snippets.
async function jinaBingSerp(src, keyword, location, page, attempts) {
  const scope = src.scope || src.domain;
  const q = `site:${scope} ${keyword || ""} ${location || ""} for sale`.trim();
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=30${
    page > 1 ? `&first=${(page - 1) * 10 + 1}` : ""
  }`;
  const jina = await fetchViaJina(url);
  const listings =
    jina.status === 200 ? extractFromMarkdown(jina.body, src.detailRe || src.linkRe, src) : [];
  note(attempts, "jina-bing", url, jina, listings.length);
  return listings;
}

// DuckDuckGo LITE results — simpler HTML, separate rate-limit bucket from the
// html endpoint. Links carry class="result-link"; snippets follow in a
// result-snippet cell. Redirects unwrap via unwrapRedirect (uddg=).
function parseDdgLite(html, src) {
  const items = [];
  const dre = src.detailRe || src.linkRe;
  // Attribute order varies (href before or after class), so match the whole
  // result-link anchor tag and pull href out of its attributes.
  const re = /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link|$)/gi;
  let m;
  while ((m = re.exec(html))) {
    const hrefM = m[1].match(/href="([^"]+)"/i);
    if (!hrefM) continue;
    const href = unwrapRedirect(decodeEntities(hrefM[1]));
    if ((dre && !dre.test(href)) || !isDetail(href, src)) continue;
    const name = cleanName(m[2]);
    if (!name) continue;
    const snip = m[3].match(/class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    items.push(makeListing(src, name, href, `${stripTags(m[2])} ${snip ? stripTags(snip[1]) : ""}`));
  }
  return dedupeByUrl(items);
}

// DuckDuckGo site-search — proven to work from datacenter IPs and keyword+
// location scoped, so results need no keyword post-filter. Primary path for
// every source. Tries the html endpoint, then the lite endpoint on
// throttle/empty (they rate-limit independently).
async function ddgSiteSearch(src, keyword, location, page, attempts) {
  const scope = src.scope || src.domain;
  if (!scope) return [];
  const q = `site:${scope} ${keyword || ""} ${location || ""} for sale`.trim();

  const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${page > 1 ? `&s=${(page - 1) * 10}` : ""}`;
  const rh = await fetchPage(htmlUrl);
  const htmlListings = rh.status === 200 ? parseDdgHtml(rh.body, src) : [];
  note(attempts, "ddg-html", htmlUrl, rh, htmlListings.length);
  if (htmlListings.length) return htmlListings;

  const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}${page > 1 ? `&s=${(page - 1) * 10}` : ""}`;
  const rl = await fetchPage(liteUrl);
  const liteListings = rl.status === 200 ? parseDdgLite(rl.body, src) : [];
  note(attempts, "ddg-lite", liteUrl, rl, liteListings.length);
  return liteListings;
}

async function scanSearchIndex(src, keyword, location, page, attempts) {
  const q = `site:${src.scope} ${keyword} ${location || ""} for sale`.trim();
  const first = page > 1 ? `&first=${(page - 1) * 10 + 1}` : "";

  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=30${first}`;
  const bing = await fetchPage(bingUrl, { accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8" });
  if (bing.status === 200 && bing.body.includes("<item>")) {
    const listings = dedupeByUrl(parseBingRss(bing.body, src));
    note(attempts, "bing-rss", bingUrl, bing, listings.length);
    if (listings.length) return { status: "ok", httpStatus: 200, via: "bing-rss", listings };
  } else note(attempts, "bing-rss", bingUrl, bing, 0);

  // DDG site-search (html endpoint, then the lite endpoint — they throttle
  // independently, so one 202 doesn't zero the source out).
  const ddgListings = await ddgSiteSearch(src, keyword, location, page, attempts);
  if (ddgListings.length) return { status: "ok", httpStatus: 200, via: "ddg", listings: ddgListings, keywordScoped: !!keyword };

  // Search engines block datacenter IPs — read the marketplace's own search page
  // through Jina Reader instead. If the keyword-specific page yields nothing
  // (odd keyword slugs can 404), fall back to the generic browse page and let
  // the keyword post-filter narrow the results.
  const pages = [src.pageUrl(keyword, location, page)];
  if (keyword) {
    const generic = src.pageUrl("", location, page);
    if (generic !== pages[0]) pages.push(generic);
  }
  let jina = { status: 0, body: "" };
  for (let i = 0; i < pages.length; i++) {
    jina = await fetchViaJina(pages[i]);
    const jinaListings = jina.status === 200 ? extractFromMarkdown(jina.body, src.detailRe, src) : [];
    note(attempts, "jina-reader", pages[i], jina, jinaListings.length);
    if (jinaListings.length)
      return { status: "ok", httpStatus: 200, via: "jina-reader", listings: jinaListings, usedGenericPage: i > 0, keywordScoped: keyword && i === 0 };
  }
  const serp = await jinaBingSerp(src, keyword, location, page, attempts);
  if (serp.length) return { status: "ok", httpStatus: 200, via: "jina-bing", listings: serp, keywordScoped: !!keyword };
  if (jina.status === 200) return { status: "empty", httpStatus: 200, via: "jina-reader", listings: [] };

  const lastDdg = [...attempts].reverse().find((a) => a.via.startsWith("ddg"));
  const httpStatus = jina.status || (lastDdg && lastDdg.httpStatus) || bing.status || 0;
  return {
    status: httpStatus === 403 || httpStatus === 429 ? "blocked" : "error",
    httpStatus,
    via: "search-index",
    listings: [],
  };
}

async function scanDirect(src, keyword, location, page, attempts) {
  // 1. DDG site-search first — keyword-scoped, works from datacenter IPs, and
  //    reaches the actual detail pages even when the site bot-walls Jina.
  const ddg = await ddgSiteSearch(src, keyword, location, page, attempts);
  if (ddg.length) return { status: "ok", httpStatus: 200, via: "ddg-html", listings: ddg, keywordScoped: !!keyword };

  // 2. Fetch the site's own browse page directly.
  const url = src.searchUrl(keyword, location, page);
  const r = await fetchPage(url);
  const kwInUrl = keyword && url !== src.searchUrl("", location, page);
  const directListings = r.status === 200 ? extractFromHtml(r.body, url, src.linkRe, src) : [];
  note(attempts, "direct", url, r, directListings.length);
  if (directListings.length)
    return { status: "ok", httpStatus: 200, via: "direct", listings: directListings, keywordScoped: !!kwInUrl };

  // 3. Retry through Jina Reader (keyword page, then generic browse page).
  const pages = [url];
  if (keyword) {
    const generic = src.searchUrl("", location, page);
    if (generic !== url) pages.push(generic);
  }
  let jina = { status: 0, body: "" };
  for (let i = 0; i < pages.length; i++) {
    jina = await fetchViaJina(pages[i]);
    const jinaListings = jina.status === 200 ? extractFromMarkdown(jina.body, src.linkRe, src) : [];
    note(attempts, "jina-reader", pages[i], jina, jinaListings.length);
    if (jinaListings.length)
      return { status: "ok", httpStatus: 200, via: "jina-reader", listings: jinaListings, usedGenericPage: !kwInUrl || i > 0, keywordScoped: kwInUrl && i === 0 };
  }
  // 4. Last resort: Jina fetches the Bing SERP.
  const serp = await jinaBingSerp(src, keyword, location, page, attempts);
  if (serp.length) return { status: "ok", httpStatus: 200, via: "jina-bing", listings: serp, keywordScoped: !!keyword };
  if (jina.status === 200 || r.status === 200) return { status: "empty", httpStatus: 200, via: "jina-reader", listings: [] };

  const httpStatus = jina.status || r.status || 0;
  return {
    status: httpStatus === 403 || httpStatus === 429 || httpStatus === 503 ? "blocked" : "error",
    httpStatus,
    via: "direct",
    listings: [],
  };
}

// ---------- public entry point ----------

export async function scanSource(siteId, keyword, location = "", page = 1, debug = false) {
  const src = SOURCES[siteId];
  if (!src) return { site: siteId, label: siteId, status: "unknown_site", httpStatus: 0, listings: [] };
  const attempts = [];
  try {
    const r =
      src.kind === "direct"
        ? await scanDirect(src, keyword, location, page, attempts)
        : await scanSearchIndex(src, keyword, location, page, attempts);
    // Sold / pending / off-market listings are dead ends — drop them outright.
    const SOLD_RE = /\b(sold|sale\s*pending|under\s*contract|off[-\s]?market|no\s*longer\s*(?:available|for\s*sale))\b/i;
    const beforeSold = r.listings.length;
    r.listings = r.listings.filter((l) => !SOLD_RE.test(`${l.name} ${l.note}`));
    if (debug) r.droppedSold = beforeSold - r.listings.length;

    const before = r.listings.length;
    r.listings = r.listings.filter((l) => locationMatches(l, location));
    if (debug) r.droppedByLocation = before - r.listings.length;
    // Sources whose browse pages can't carry the keyword in the URL list every
    // industry — keep only listings that actually mention the keyword.
    if (keyword && !r.keywordScoped) {
      const words = String(keyword).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      if (words.length) {
        const beforeKw = r.listings.length;
        r.listings = r.listings.filter((l) =>
          words.some((w) => `${l.name} ${l.note}`.toLowerCase().includes(w))
        );
        if (debug) r.droppedByKeyword = beforeKw - r.listings.length;
      }
    }
    if (r.status === "ok" && !r.listings.length) r.status = "empty";
    return { site: siteId, label: src.label, ...r, ...(debug ? { attempts } : {}) };
  } catch (err) {
    return {
      site: siteId, label: src.label, status: "error", httpStatus: 0, listings: [],
      detail: String(err), ...(debug ? { attempts } : {}),
    };
  }
}
