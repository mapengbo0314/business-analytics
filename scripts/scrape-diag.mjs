// Diagnostic: run the REAL scraper chain against the live sites and print
// full traces. Executed on GitHub Actions runners (datacenter IPs, like
// Vercel) via .github/workflows/scrape-diag.yml.
import { SOURCE_IDS, scanSource } from "../api/_lib/scrape.js";

const kw = process.env.DIAG_KEYWORD ?? "HVAC";
const loc = process.env.DIAG_LOCATION ?? "Texas";

const clip = (s, n) => String(s || "").replace(/\s+/g, " ").slice(0, n);

for (const id of SOURCE_IDS) {
  const t0 = Date.now();
  const r = await scanSource(id, kw, loc, 1, true);
  console.log(`\n===== ${id} — status=${r.status} via=${r.via || "-"} http=${r.httpStatus} found=${r.listings.length} in ${Date.now() - t0}ms =====`);
  for (const a of r.attempts || []) {
    console.log(`  [${a.via}] ${a.httpStatus} found=${a.found} ${a.url}`);
    console.log(`    sample: ${clip(a.sample, 700)}`);
  }
  for (const l of r.listings.slice(0, 3)) {
    console.log(`  LISTING: ${l.name} | asking=${l.asking} sde=${l.sde} | ${l.location} | ${l.listingUrl}`);
  }
  if (r.droppedByLocation) console.log(`  droppedByLocation=${r.droppedByLocation}`);
  if (r.droppedByKeyword) console.log(`  droppedByKeyword=${r.droppedByKeyword}`);
  if (r.droppedSold) console.log(`  droppedSold=${r.droppedSold}`);
}
console.log("\nDIAG COMPLETE");
