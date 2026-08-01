import {
  parseMoney, stripTags, extractFields, extractFromHtml, extractJsonLd, SOURCES, scanSource, unwrapRedirect,
} from "../api/_lib/scrape.js";

let fails = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// money
eq(parseMoney("1,250,000"), 1250000, "money plain");
eq(parseMoney("1.2M"), 1200000, "money M");
eq(parseMoney("250K"), 250000, "money K");
eq(parseMoney("abc"), null, "money junk");
eq(parseMoney("12"), null, "money too small");

// fields
const f = extractFields("Asking Price: $675,000 Cash Flow: $254,696 Gross Revenue: $1.4M Established: 1986 Located in Austin, TX today");
eq(f.asking, 675000, "field asking");
eq(f.sde, 254696, "field sde");
eq(f.revenueT12, 1400000, "field revenue");
eq(f.established, 1986, "field established");
eq(f.location, "Austin, TX", "field location");

// stripTags + entities
eq(stripTags("<b>Joe&#39;s &#36;Shop</b> <script>x<1</script>ok"), "Joe's $Shop ok", "striptags");
eq(extractFields("Location: Saint Louis County, MO area").location, "Saint Louis County, MO", "field location multiword");

// wayback snapshot links unwrap to the original listing URL
eq(unwrapRedirect("https://web.archive.org/web/20260728123456/https://www.bizbuysell.com/business-opportunity/some-biz/2433694/"),
  "https://www.bizbuysell.com/business-opportunity/some-biz/2433694/", "wayback: full prefix unwrapped");
eq(unwrapRedirect("https://web.archive.org/web/20260728123456/https:/www.bizbuysell.com/business-opportunity/some-biz/2433694/"),
  "https://www.bizbuysell.com/business-opportunity/some-biz/2433694/", "wayback: collapsed // restored");

// generic direct extraction
const html = `
<html><body>
<div class="card">
  <a href="/business-for-sale/profitable-hvac-services-company/8842137.aspx">Profitable HVAC Services Company In Dallas</a>
  <p>Asking Price: $850,000 · Cash Flow: $310,000 · Revenue: $2,100,000 · Established: 2001 · Dallas, TX</p>
</div>
<div class="card">
  <a href="/business-for-sale/commercial-plumbing-contractor/7712345.aspx">Commercial Plumbing Contractor Est 1995</a>
  <span>Price: $1.2M Cash Flow: $400K Located in Houston, TX</span>
</div>
<a href="/about-us">About</a>
<a href="/business-for-sale/profitable-hvac-services-company/8842137.aspx">View details</a>
</body></html>`;
const ds = SOURCES.businessbroker;
const got = extractFromHtml(html, "https://www.businessbroker.net/state/texas-businesses-for-sale.aspx", ds.linkRe, ds);
eq(got.length, 2, "direct: 2 cards, nav + dup dropped");
eq(got[0].name, "Profitable HVAC Services Company In Dallas", "direct: name");
eq(got[0].asking, 850000, "direct: asking");
eq(got[0].sde, 310000, "direct: sde");
eq(got[0].revenueT12, 2100000, "direct: revenue");
eq(got[0].established, 2001, "direct: established");
eq(got[0].listingUrl, "https://www.businessbroker.net/business-for-sale/profitable-hvac-services-company/8842137.aspx", "direct: abs url");
eq(got[1].asking, 1200000, "direct: $1.2M");

// junk-location rejection: the "state" part must be a real US state
eq(extractFields("Well-Established HVAC Business, Over 200 Maintenance Accounts").location, null, "location: fake state rejected");
eq(extractFields("in Houston, Texas Houston metro area").location, "Houston, Texas", "location: stops at the real state");

// json-ld
const ldHtml = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"Established Landscaping Business North Texas","url":"/listings/landscaping-biz","offers":{"@type":"Offer","price":"495000"}}}]}</script>`;
const ld = extractJsonLd(ldHtml, "https://www.synergybb.com/");
eq(ld.length, 1, "jsonld: found");
eq(ld[0].price, 495000, "jsonld: price");
eq(ld[0].url, "https://www.synergybb.com/listings/landscaping-biz", "jsonld: abs url");

// bing rss parse via scanSource with a mocked fetch
const rss = `<?xml version="1.0"?><rss><channel>
<item><title>Profitable Austin Area HVAC business for sale - BizBuySell</title><link>https://www.bizbuysell.com/business-opportunity/profitable-austin-area-hvac/2433694/</link><description>Asking Price: $675,000 Cash Flow: $254,696 Austin, TX. Long established HVAC contractor.</description></item>
<item><title>Some blog post</title><link>https://www.bizbuysell.com/learning-center/article</link><description>not a listing</description></item>
</channel></rss>`;
globalThis.fetch = async (url) => ({
  status: 200,
  text: async () => (String(url).includes("bing.com") ? rss : "<html></html>"),
});
const r = await scanSource("bizbuysell", "hvac", "Texas");
eq(r.status, "ok", "search-index: status ok");
eq(r.via, "bing-rss", "search-index: via bing");
eq(r.listings.length, 1, "search-index: non-listing link filtered");
eq(r.listings[0].asking, 675000, "search-index: asking from snippet");
eq(r.listings[0].sde, 254696, "search-index: sde from snippet");

// blocked path
globalThis.fetch = async () => ({ status: 403, text: async () => "" });
const b = await scanSource("synergybb", "hvac", "");
eq(b.status, "blocked", "direct: 403 => blocked status");

// dealstream is gone — it CAPTCHA-blocked every access path
eq(SOURCES.dealstream, undefined, "dealstream removed from registry");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
