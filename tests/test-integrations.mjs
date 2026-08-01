let fails = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};
const mockRes = () => {
  const r = { headers: {}, code: null, body: null };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.status = (c) => ((r.code = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
};

// --- inquire: disabled + validation ---
delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
const { default: inquire } = await import("../api/inquire.js");
let res = mockRes();
await inquire({ method: "GET" }, res);
eq(res.body.enabled, false, "inquire: disabled without env");
res = mockRes();
await inquire({ method: "POST", body: { to: "x@y.com", subject: "s", body: "b" } }, res);
eq(res.code, 501, "inquire: POST 501 without env");
process.env.GMAIL_USER = "bizbo0314@gmail.com"; process.env.GMAIL_APP_PASSWORD = "xxxx";
res = mockRes();
await inquire({ method: "GET" }, res);
eq(res.body, { enabled: true, from: "bizbo0314@gmail.com" }, "inquire: enabled reports from address");
res = mockRes();
await inquire({ method: "POST", body: { to: "not-an-email", subject: "s", body: "b" } }, res);
eq(res.code, 400, "inquire: invalid email rejected");

// --- analyze: disabled, then mocked end-to-end ---
delete process.env.ANTHROPIC_API_KEY;
const { default: analyze } = await import("../api/analyze.js");
res = mockRes();
await analyze({ method: "GET" }, res);
eq(res.body.enabled, false, "analyze: disabled without key");

process.env.ANTHROPIC_API_KEY = "sk-ant-test";
const deal = {
  name: "Profitable Austin Area HVAC", listingUrl: "https://x/1", source: "BizBuySell",
  location: "Austin, TX", asking: 675000, sde: 254696, notes: "Broker Jane",
  files: [
    { name: "P&L-2025.csv", url: "https://x.blob.vercel-storage.com/deals/pl.csv" },
    { name: "model.xlsx", url: "https://x.blob.vercel-storage.com/deals/m.xlsx" },
  ],
};
let apiBody = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("blob.vercel-storage.com")) {
    return new Response("month,revenue\nJan,100000", { status: 200 });
  }
  if (u.includes("api.anthropic.com")) {
    apiBody = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-8",
      content: [{ type: "text", text: "## 1. SDE verification\nLooks solid." }],
      stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("", { status: 404 });
};
res = mockRes();
await analyze({ method: "POST", body: { deal, criteria: { priceMin: 1, priceMax: 2e6, sdeMin: 1, multMax: 4, marginMin: 0.1, ageMin: 1 } } }, res);
eq(res.code, 200, "analyze: 200");
eq(res.body.report.includes("SDE verification"), true, "analyze: report returned");
eq(res.body.analyzedDocs, ["P&L-2025.csv"], "analyze: csv attached");
eq(res.body.skippedDocs[0].skipped, "model.xlsx", "analyze: xlsx skipped with reason");
eq(apiBody.model, "claude-opus-4-8", "analyze: opus 4.8 by default");
eq(apiBody.thinking, { type: "adaptive" }, "analyze: adaptive thinking");
const textBlock = apiBody.messages[0].content.at(-1);
eq(textBlock.text.includes("Broker Jane") && textBlock.text.includes("re-export"), true, "analyze: prompt carries notes + skip note");

// refusal path
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes("api.anthropic.com"))
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null }, usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("x", { status: 200 });
};
res = mockRes();
await analyze({ method: "POST", body: { deal: { name: "n", listingUrl: "u", files: [] } } }, res);
eq(res.body.error, "refused", "analyze: refusal handled before reading content");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
