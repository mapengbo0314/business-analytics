const { default: handler } = await import("../api/prompt.js");
let fails = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};
const mockRes = () => { const r = {}; r.setHeader = () => {}; r.status = (c) => ((r.code = c), r); r.json = (b) => ((r.body = b), r); return r; };

globalThis.fetch = async (url) =>
  String(url).endsWith(".csv")
    ? new Response("month,revenue\nJan,100000\nFeb,120000", { status: 200 })
    : new Response("", { status: 404 });

const deal = {
  name: "Profitable Austin Area HVAC", location: "Austin, TX", source: "BizBuySell",
  listingUrl: "https://x/1", asking: 675000, sde: 254696, revenueT12: null, established: 1986,
  stage: "docs",
  notes: "Broker: Jane D.\n📧 Jul 8 jane@broker.com: NDA attached, please sign.",
  files: [
    { name: "financials.csv", url: "https://x.blob.vercel-storage.com/deals/f.csv" },
    { name: "NDA.pdf", url: "https://x.blob.vercel-storage.com/deals/nda.pdf" },
    { name: "model.xlsx", url: "https://x.blob.vercel-storage.com/deals/m.xlsx" },
  ],
  ddReport: "## Previous verdict: proceed with conditions",
};
let res = mockRes();
await handler({ method: "POST", body: { deal, criteria: { priceMin: 200000, priceMax: 1500000, sdeMin: 150000, multMax: 4, marginMin: 0.15, ageMin: 5 } } }, res);
eq(res.code, 200, "prompt: 200");
const p = res.body.prompt;
eq(p.includes("Profitable Austin Area HVAC") && p.includes("$675K"), true, "prompt: deal facts");
eq(p.includes("MY BUY BOX") && p.includes("4×"), true, "prompt: buy box");
eq(p.includes("NDA attached, please sign"), true, "prompt: email history from notes");
eq(p.includes("month,revenue"), true, "prompt: csv contents inlined");
eq(res.body.inlined, ["financials.csv"], "prompt: inlined list");
eq(res.body.attach, ["NDA.pdf", "model.xlsx"], "prompt: binary docs in attach list");
eq(p.includes("NDA.pdf, model.xlsx"), true, "prompt: attach instruction in text");
eq(p.includes("PREVIOUS ANALYSIS") && p.includes("proceed with conditions"), true, "prompt: previous analysis for follow-up");
eq(p.includes("SDE verification") && p.includes("6. Verdict"), true, "prompt: six analysis sections");

// GET is keyless-enabled always
res = mockRes();
await handler({ method: "GET" }, res);
eq(res.body, { enabled: true }, "prompt: GET always enabled (no key needed)");

// no docs / no notes still works
res = mockRes();
await handler({ method: "POST", body: { deal: { name: "Bare Deal Co", listingUrl: "u" } } }, res);
eq(res.code, 200, "prompt: bare deal 200");
eq(res.body.prompt.includes("None yet."), true, "prompt: empty notes handled");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
