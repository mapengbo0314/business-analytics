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

export const SOURCES = {
  bizbuysell: {
    label: "BizBuySell",
    kind: "search-index",
    domain: "bizbuysell.com",
    scope: "bizbuysell.com/business-opportunity",
    detailRe: /bizbuysell\.com\/(?:business-opportunity|business-auction)\//i,
    pageUrl: (kw, loc, page) =>
      `https://www.bizbuysell.com/businesses-for-sale/?q=${encodeURIComponent(kw)}${page > 1 ? `&page=${page}` : ""}`,
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
    scope: "bizquest.com",
    detailRe: /bizquest\.com\/[a-z0-9-]*business[^\s"']*/i,
    pageUrl: (kw) => `https://www.bizquest.com/businesses-for-sale/?keyword=${encodeURIComponent(kw)}`,
  },
  dealstream: {
    label: "DealStream",
    kind: "direct",
    searchUrl: (kw, loc, page) =>
      `https://dealstream.com/search?q=${encodeURIComponent([kw, loc].filter(Boolean).join(" "))}${
        page > 1 ? `&page=${page}` : ""
      }`,
    linkRe: /^\/[a-z0-9][a-z0-9-]{13,}\/?$/i,
  },
  businessbroker: {
    label: "BusinessBroker.net",
    kind: "direct",
    searchUrl: (kw, loc, page) =>
      `https://www.businessbroker.net/listings/searchresults.aspx?kw=${encodeURIComponent(kw)}${
        page > 1 ? `&pg=${page}` : ""
      }`,
    linkRe: /(business-opportunity|business-for-sale|\/\d{5,}\.aspx$)/i,
  },
  synergybb: {
    label: "Synergy Business Brokers",
    kind: "direct",
    searchUrl: (kw) => `https://www.synergybb.com/?s=${encodeURIComponent(kw)}`,
    linkRe: /(businesses?-for-sale|listings?)\/[a-z0-9-]{8,}/i,
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
  const m = String(raw).replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (/m/i.test(m[2] || "")) n *= 1e6;
  else if (/k/i.test(m[2] || "")) n *= 1e3;
  n = Math.round(n);
  return n >= 1000 && n < 1e9 ? n : null; // ignore junk numbers
}

// Financial fields stated in plain text near/inside a listing card.
const FIELDS = {
  asking: /(?:asking\s*price|list(?:ed)?\s*price|price)\s*[:\-–]?\s*\$\s*([\d.,]+\s*[kKmM]?)/i,
  sde: /(?:cash\s*flow|sde\b|seller'?s\s*discretionary\s*earnings|discretionary\s*earnings)\s*[:\-–]?\s*\$\s*([\d.,]+\s*[kKmM]?)/i,
  revenueT12: /(?:gross\s*revenue|revenue|gross\s*sales|annual\s*sales|sales|gross\s*income)\s*[:\-–]?\s*\$\s*([\d.,]+\s*[kKmM]?)/i,
};
const ESTABLISHED_RE = /(?:established|est\.?|founded)\s*(?:in\s*)?[:\-–]?\s*((?:19|20)\d{2})/i;
// "City, ST" or "City Name, Texas" — every word must be capitalized so lead-ins
// like "Located in" don't get swallowed into the city name.
const LOCATION_RE = /\b([A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+){0,3},\s*(?:[A-Z]{2}\b|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?))/;

export function extractFields(text) {
  const out = { asking: null, sde: null, revenueT12: null, established: null, location: null };
  for (const [k, re] of Object.entries(FIELDS)) {
    const m = text.match(re);
    if (m) out[k] = parseMoney(m[1]);
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
  const t = setTimeout(() => controller.abort(), 25000);
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
    if (/\d{5,}/.test(path)) return true;
    const last = (path.split("/").pop() || "").replace(/\.aspx$/i, "");
    return last.length >= 18 && last.includes("-");
  } catch {
    return false;
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

function makeListing(src, name, url, text) {
  const f = extractFields(text);
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

function dedupeByUrl(listings, cap = 10) {
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
      abs = new URL(decodeEntities(a.href), baseUrl);
      path = abs.pathname;
    } catch {
      continue;
    }
    if (!(linkRe.test(path) || linkRe.test(abs.href))) continue;
    if (!looksLikeDetail(abs.href)) continue;
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
  while ((m = linkMd.exec(md))) matches.push({ text: m[1], url: m[2], index: m.index });
  for (let i = 0; i < matches.length; i++) {
    const a = matches[i];
    let path;
    try {
      path = new URL(a.url).pathname;
    } catch {
      continue;
    }
    if (!(linkRe.test(path) || linkRe.test(a.url))) continue;
    if (!looksLikeDetail(a.url)) continue;
    const name = cleanName(a.text.replace(/!\[[^\]]*\]/g, " "));
    if (!name) continue;
    const end = i + 1 < matches.length ? matches[i + 1].index : a.index + 2500;
    const windowText = md
      .slice(a.index, Math.min(end, a.index + 2500))
      .replace(/[\\*_#>|\[\]()]/g, " ")
      .replace(/\s+/g, " ");
    items.push(makeListing(src, name, a.url, windowText));
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
    if (!link || !src.detailRe.test(link) || !looksLikeDetail(link)) continue;
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
    if (!src.detailRe.test(href) || !looksLikeDetail(href)) continue;
    const name = cleanName(m[2]);
    if (!name) continue;
    const snippetMatch = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    items.push(makeListing(src, name, href, `${stripTags(m[2])} ${snippet}`));
  }
  return dedupeByUrl(items);
}

const note = (attempts, via, url, r, found) =>
  attempts.push({ via, url, httpStatus: r.status, found, sample: (r.body || r.error || "").slice(0, 160) });

async function scanSearchIndex(src, keyword, location, page, attempts) {
  const q = `site:${src.scope} ${keyword} ${location || ""} for sale`.trim();
  const first = page > 1 ? `&first=${(page - 1) * 10 + 1}` : "";

  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=15${first}`;
  const bing = await fetchPage(bingUrl, { accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8" });
  if (bing.status === 200 && bing.body.includes("<item>")) {
    const listings = dedupeByUrl(parseBingRss(bing.body, src));
    note(attempts, "bing-rss", bingUrl, bing, listings.length);
    if (listings.length) return { status: "ok", httpStatus: 200, via: "bing-rss", listings };
  } else note(attempts, "bing-rss", bingUrl, bing, 0);

  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${page > 1 ? `&s=${(page - 1) * 10}` : ""}`;
  const ddg = await fetchPage(ddgUrl);
  const ddgListings = ddg.status === 200 ? parseDdgHtml(ddg.body, src) : [];
  note(attempts, "ddg-html", ddgUrl, ddg, ddgListings.length);
  if (ddgListings.length) return { status: "ok", httpStatus: 200, via: "ddg-html", listings: ddgListings };

  // Search engines block datacenter IPs — read the marketplace's own search page
  // through Jina Reader instead.
  const pageUrl = src.pageUrl(keyword, location, page);
  const jina = await fetchViaJina(pageUrl);
  const jinaListings = jina.status === 200 ? extractFromMarkdown(jina.body, src.detailRe, src) : [];
  note(attempts, "jina-reader", pageUrl, jina, jinaListings.length);
  if (jinaListings.length) return { status: "ok", httpStatus: 200, via: "jina-reader", listings: jinaListings };
  if (jina.status === 200) return { status: "empty", httpStatus: 200, via: "jina-reader", listings: [] };

  const httpStatus = jina.status || ddg.status || bing.status || 0;
  return {
    status: httpStatus === 403 || httpStatus === 429 ? "blocked" : "error",
    httpStatus,
    via: "search-index",
    listings: [],
  };
}

async function scanDirect(src, keyword, location, page, attempts) {
  const url = src.searchUrl(keyword, location, page);
  const r = await fetchPage(url);
  const directListings = r.status === 200 ? extractFromHtml(r.body, url, src.linkRe, src) : [];
  note(attempts, "direct", url, r, directListings.length);
  if (directListings.length) return { status: "ok", httpStatus: 200, via: "direct", listings: directListings };

  // Blocked, erroring, or a page we couldn't parse — retry through Jina Reader.
  const jina = await fetchViaJina(url);
  const jinaListings = jina.status === 200 ? extractFromMarkdown(jina.body, src.linkRe, src) : [];
  note(attempts, "jina-reader", url, jina, jinaListings.length);
  if (jinaListings.length) return { status: "ok", httpStatus: 200, via: "jina-reader", listings: jinaListings };
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
    const before = r.listings.length;
    r.listings = r.listings.filter((l) => locationMatches(l, location));
    if (r.status === "ok" && !r.listings.length) r.status = "empty";
    if (debug) r.droppedByLocation = before - r.listings.length;
    return { site: siteId, label: src.label, ...r, ...(debug ? { attempts } : {}) };
  } catch (err) {
    return {
      site: siteId, label: src.label, status: "error", httpStatus: 0, listings: [],
      detail: String(err), ...(debug ? { attempts } : {}),
    };
  }
}
