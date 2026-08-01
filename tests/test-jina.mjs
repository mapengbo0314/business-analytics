import { extractFromMarkdown, scanSource, SOURCES, _jinaCooldown } from "../api/_lib/scrape.js";

let fails = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// markdown extraction as Jina Reader returns it
const md = `
Title: Businesses for sale

[![Image](https://cdn.example.com/x.jpg)](https://www.bizbuysell.com/business-opportunity/profitable-austin-area-hvac/2433694/)
[Profitable Austin Area HVAC Company](https://www.bizbuysell.com/business-opportunity/profitable-austin-area-hvac/2433694/)
Austin, TX · Asking Price: $675,000 · Cash Flow: $254,696

[Established Commercial HVAC Contractor Dallas](https://www.bizbuysell.com/business-opportunity/commercial-hvac-dallas/2450001/)
Dallas, TX Asking Price: $1.2M Cash Flow: $400K Established: 1995

[Sign up for alerts](https://www.bizbuysell.com/alerts/)
[Next page](https://www.bizbuysell.com/businesses-for-sale/?page=2)
`;
const src = SOURCES.bizbuysell;
const got = extractFromMarkdown(md, src.detailRe, src);
eq(got.length, 2, "md: 2 listings, nav/image links dropped");
eq(got[0].name, "Profitable Austin Area HVAC Company", "md: name");
eq(got[0].asking, 675000, "md: asking");
eq(got[0].sde, 254696, "md: sde");
eq(got[0].location, "Austin, TX", "md: location");
eq(got[1].asking, 1200000, "md: 1.2M");
eq(got[1].established, 1995, "md: established");

// full chain: bing 403, ddg 403, mojeek 403, jina 200 -> ok via jina-reader
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://r.jina.ai/")) return { status: 200, text: async () => md };
  return { status: 403, text: async () => "" };
};
const r = await scanSource("bizbuysell", "hvac", "Texas", 1, true);
eq(r.status, "ok", "chain: ok");
eq(r.via, "jina-reader", "chain: via jina");
eq(r.listings.length, 2, "chain: listings");
eq(r.attempts.length, 5, "chain: 5 attempts traced");
eq(r.attempts.map(a => a.via).join(","), "bing-rss,ddg-html,ddg-lite,mojeek,jina-reader", "chain: attempt order (ddg both endpoints + mojeek tried)");

// whole-card anchor with a nested image (BusinessBroker.net's layout): the
// title lives in a ### heading inside one big link
const bbMd = `[![Image 1: Passive Medical Spa Portfolio](https://img.example.com/1.jpg)Asking Price: $1,400,000 ### Passive Medical Spa Managed Portfolio
Dallas, TX](https://www.businessbroker.net/business-for-sale/passive-medical-spa/1013211.aspx)`;
const bbSrc = SOURCES.businessbroker;
const bbGot = extractFromMarkdown(bbMd, bbSrc.linkRe, bbSrc);
eq(bbGot.length, 1, "card-anchor: extracted despite nested image");
eq(bbGot[0].name, "Passive Medical Spa Managed Portfolio", "card-anchor: name from ### heading");
eq(bbGot[0].asking, 1400000, "card-anchor: price from card text");
eq(bbGot[0].location, "Dallas, TX", "card-anchor: location");

// search-result title suffix stripping
const serpMd = `[Growing HVAC Business for Sale in - BizBuySell](https://www.bizbuysell.com/business-opportunity/growing-hvac-business-for-sale/2471418/)\nGreat business.`;
const serpGot = extractFromMarkdown(serpMd, SOURCES.bizbuysell.detailRe, SOURCES.bizbuysell);
eq(serpGot[0].name, "Growing HVAC Business for Sale", "serp title: site suffix + dangling preposition stripped");

// snippet glues the site name onto the city — scrub it from the location
const serpMd2 = `[Established HVAC And Electrical Business Strong](https://www.bizbuysell.com/business-opportunity/hvac-electrical/2477729/)\nBizBuySell Collin County, TX 30 years strong.`;
const serpGot2 = extractFromMarkdown(serpMd2, SOURCES.bizbuysell.detailRe, SOURCES.bizbuysell);
eq(serpGot2[0].location, "Collin County, TX", "location: site name scrubbed from city");

// keyword relevance: engine results are fuzzy, so every stemmed query word
// must appear in the name/description — "manufacturer" keeps manufacturing
// businesses and drops the car dealerships DDG likes to return for it.
const mixMd = `[Precision Sheet Metal Manufacturing Business](https://synergybb.com/listings/precision-sheet-metal-manufacturing-business/)
Fort Worth, TX Asking Price: $2,000,000 — established manufacturer of HVAC ductwork.

[Luxury Import Car Dealership And Service Center](https://synergybb.com/listings/luxury-import-car-dealership-service-center/)
Dallas, TX Asking Price: $5,000,000 — high-line vehicle sales and service.

[Engine Machine Shop With Real Estate Included](https://synergybb.com/listings/engine-machine-shop-with-real-estate/)
Austin, TX Asking Price: $900,000 — automotive engine rebuilding.`;
globalThis.fetch = async (url) =>
  String(url).startsWith("https://r.jina.ai/") ? { status: 200, text: async () => mixMd } : { status: 403, text: async () => "" };
const kwRes = await scanSource("synergybb", "manufacturer", "", 1, true);
eq(kwRes.listings.length, 1, "kw filter: only the manufacturing business survives");
eq(kwRes.listings[0].name, "Precision Sheet Metal Manufacturing Business", "kw filter: stem manufactur~ matches manufacturing");
eq(kwRes.droppedByKeyword, 2, "kw filter: dealership + machine shop dropped");
const kwRes2 = await scanSource("synergybb", "manufacturing", "", 1, true);
eq(kwRes2.listings.length, 1, "kw filter: 'manufacturing' query matches 'manufacturer' text too");
const kwRes3 = await scanSource("synergybb", "car dealership", "", 1, true);
eq(kwRes3.listings.length, 1, "kw filter: multi-word query requires every word");
eq(kwRes3.listings[0].name.includes("Car Dealership"), true, "kw filter: right listing for 'car dealership'");

// direct source: direct 403, jina 200 with markdown links
const dsMd = `[Profitable HVAC Services Company In Dallas](https://synergybb.com/listings/profitable-hvac-services-company/)\nAsking Price: $850,000 Cash Flow: $310,000`;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("https://r.jina.ai/")) return { status: 200, text: async () => dsMd };
  return { status: 403, text: async () => "" };
};
const d = await scanSource("synergybb", "hvac", "", 1, true);
eq(d.status, "ok", "direct-fallback: ok");
eq(d.via, "jina-reader", "direct-fallback: via jina");
eq(d.listings[0].asking, 850000, "direct-fallback: asking");

// wayback rescue: everything live is down, but the Internet Archive has a
// snapshot of the GENERIC state page (keyword-slug pages are rarely archived)
const wbHtml = `<html><body>
<a href="/web/20260728000000/https://www.bizbuysell.com/business-opportunity/archived-texas-hvac-company/2499999/">Archived Texas HVAC Company For Sale</a>
<p>Asking Price: $500,000 Cash Flow: $200,000 Dallas, TX</p>
</body></html>`;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("web.archive.org") && u.includes("hvac-businesses-for-sale")) return { status: 404, text: async () => "" };
  if (u.includes("web.archive.org")) return { status: 200, text: async () => wbHtml };
  return { status: 403, text: async () => "" };
};
_jinaCooldown.set(0);
const w = await scanSource("bizbuysell", "hvac", "Texas", 1, true);
eq(w.status, "ok", "wayback: ok when only the archive responds");
eq(w.via, "wayback", "wayback: via wayback");
eq(w.listings.length, 1, "wayback: listing extracted from generic-page snapshot");
eq(w.listings[0].listingUrl, "https://www.bizbuysell.com/business-opportunity/archived-texas-hvac-company/2499999/", "wayback: link unwrapped to the live detail URL");
eq(w.attempts.filter(a => a.via === "wayback").length, 2, "wayback: keyword page tried first, then generic page");

// everything down -> a jina 403 trips the cooldown, later calls report 429
_jinaCooldown.set(0);
globalThis.fetch = async () => ({ status: 403, text: async () => "" });
const b = await scanSource("bizbuysell", "hvac", "", 1);
eq(b.status, "rate-limited", "all-403: jina cooldown makes later attempts 429 => rate-limited");
eq(b.attempts, undefined, "no debug: attempts omitted");
eq(_jinaCooldown.get() > Date.now(), true, "cooldown armed after a jina 403");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
