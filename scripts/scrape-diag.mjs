// Diagnostic: run the REAL scraper chain against the live sites and print
// full traces + a raw-markdown sample around the first detail link (to see the
// true price layout). Runs on GitHub Actions (datacenter IPs, like Vercel) via
// .github/workflows/scrape-diag.yml.
import { SOURCE_IDS, SOURCES, scanSource, fetchViaJina } from "../api/_lib/scrape.js";

const kw = process.env.DIAG_KEYWORD ?? "HVAC";
const loc = process.env.DIAG_LOCATION ?? "Texas";
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);

for (const id of SOURCE_IDS) {
  const t0 = Date.now();
  const r = await scanSource(id, kw, loc, 1, true);
  console.log(`\n===== ${id} — status=${r.status} via=${r.via || "-"} http=${r.httpStatus} found=${r.listings.length} in ${Date.now() - t0}ms =====`);
  for (const a of r.attempts || []) {
    console.log(`  [${a.via}] ${a.httpStatus} found=${a.found} ${a.url}`);
    // A 200 with zero extracted listings is the interesting case: show what
    // the page actually said so extraction gaps are visible in the log.
    if (a.httpStatus === 200 && !a.found) console.log(`    SAMPLE: ${clip(a.sample, 350)}`);
  }
  for (const l of r.listings.slice(0, 4)) {
    console.log(`  LISTING: ${l.name} | asking=${l.asking} sde=${l.sde} rev=${l.revenueT12} | ${l.location} | ${l.listingUrl}`);
  }
  if (r.droppedByLocation) console.log(`  droppedByLocation=${r.droppedByLocation}`);
  if (r.droppedByKeyword) console.log(`  droppedByKeyword=${r.droppedByKeyword}`);
  if (r.droppedSold) console.log(`  droppedSold=${r.droppedSold}`);
}

// Raw-markdown layout probe: fetch bizquest's HVAC index via Jina and print the
// 600 chars around its first detail link, so price-vs-link layout is visible.
console.log("\n\n========== RAW MARKDOWN LAYOUT PROBE ==========");
for (const id of ["bizbuysell", "bizquest", "businessbroker", "sunbelt"]) {
  const src = SOURCES[id];
  const url = (src.pageUrl || src.searchUrl)(kw, loc, 1);
  const j = await fetchViaJina(url);
  console.log(`\n----- ${id} (${url}) http=${j.status} len=${(j.body || "").length} -----`);
  const body = j.body || "";
  const re = (src.detailRe || src.linkRe);
  // find the first URL (markdown link or bare) that matches the detail pattern
  const link = [...body.matchAll(/\[([^\]]{3,600}?)\]\((https?:\/\/[^)\s]+)\)/g)].find((x) => re.test(x[2]));
  const bare = [...body.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)].find((x) => re.test(x[0]));
  const at = link ? link.index : bare ? bare.index : -1;
  if (at >= 0) {
    console.log(`CONTEXT (400 before .. 400 after the first detail ${link ? "markdown link" : "bare URL"}):`);
    console.log(clip(body.slice(Math.max(0, at - 400), at + 400), 850));
  } else {
    console.log("no detail-pattern URL found anywhere; first 800 chars of body:");
    console.log(clip(body, 800));
  }
}
console.log("\nDIAG COMPLETE");
