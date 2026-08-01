import { extractFromMarkdown, locationMatches, scanSource, SOURCES } from "../api/_lib/scrape.js";

let fails = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

// nav links must be dropped even when their URL/text superficially qualifies
const md = `
[Sell a business today](https://www.bizquest.com/sell-a-business/)
[Find a business broker](https://www.bizquest.com/find-a-broker/)
[Businesses for sale in Texas](https://www.bizquest.com/texas-businesses-for-sale/)
[Franchise opportunities near you](https://www.bizquest.com/franchise-for-sale/)
[Profitable HVAC Business in Dallas For Sale](https://www.bizquest.com/business-for-sale/profitable-hvac-business-in-dallas/BW2058311/)
Dallas, TX · Asking Price: $850,000 · Cash Flow: $310,000
[Established Plumbing And HVAC Services Company](https://www.bizquest.com/business-for-sale/established-plumbing-and-hvac-services-company/BW1999888/)
Phoenix, AZ Asking Price: $500,000
[No Goodwill Gas Stations For Lease Statewide](https://www.bizquest.com/business-for-sale/no-goodwill-gas-stations-for-lease-statewide/BW2526059/)
Dallas, TX Asking Price: $8,500,000 fuel supply agreement included
`;
const src = SOURCES.bizquest;
const all = extractFromMarkdown(md, src.detailRe, src);
eq(all.length, 3, "nav/CTA links dropped, 3 real listings kept");
eq(all[0].name, "Profitable HVAC Business in Dallas For Sale", "real listing name kept");

// location matching
eq(locationMatches({ location: "Dallas, TX", name: "", note: "" }, "Texas"), true, "TX abbr matches Texas");
eq(locationMatches({ location: "Phoenix, AZ", name: "", note: "" }, "Texas"), false, "AZ rejected for Texas");
eq(locationMatches({ location: "Not stated", name: "HVAC Co", note: "serving Austin, Texas metro" }, "texas"), true, "note text matches");
eq(locationMatches({ location: "Not stated", name: "", note: "" }, "Texas"), true, "no location info KEPT (only explicit mismatches drop)");
eq(locationMatches({ location: "Not stated", name: "HVAC Co", note: "serving the Phoenix, AZ metro" }, "Texas"), false, "explicit other-state abbr drops");
eq(locationMatches({ location: "Not stated", name: "Florida Pool Service Co", note: "" }, "Texas"), false, "explicit other-state name drops");
eq(locationMatches({ location: "Not stated", name: "", note: "" }, ""), true, "no filter when location empty");
eq(locationMatches({ location: "Houston, TX", name: "", note: "" }, "houston"), true, "city match");
eq(locationMatches({ location: "Austin, TX", name: "", note: "" }, "tx"), true, "raw abbreviation input");

// end-to-end: Texas filter drops the Phoenix listing, and the keyword filter
// drops the gas station even though it came from bizquest's own "hvac"
// category URL — those soft-404 into generic everything pages, so nothing is
// trusted to be pre-scoped.
globalThis.fetch = async (url) =>
  String(url).startsWith("https://r.jina.ai/")
    ? { status: 200, text: async () => md }
    : { status: 403, text: async () => "" };
const r = await scanSource("bizquest", "hvac", "Texas", 1, true);
eq(r.listings.length, 1, "e2e: only the Texas HVAC listing survives");
eq(r.droppedByLocation, 1, "e2e: location drop count reported in debug");
eq(r.droppedByKeyword, 1, "e2e: off-keyword listing dropped even from the site's own category page");
eq(r.listings[0].location, "Dallas, TX", "e2e: kept the right one");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
