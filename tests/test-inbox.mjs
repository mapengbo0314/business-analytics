delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
const { default: handler, matchDealKey } = await import("../api/inbox.js");

let fails = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
};

const saved = {
  "https://x.com/austin-hvac/2433694": { name: "Profitable Austin Area HVAC" },
  "https://x.com/dallas-hvac/bw2058311": { name: "Established Dallas HVAC Service Company" },
};
eq(matchDealKey(saved, { subject: "Re: Buyer inquiry — Profitable Austin Area HVAC (Listing BBS-1)", text: "Hi, attached is the NDA." }),
  "https://x.com/austin-hvac/2433694", "match: reply subject carries deal name");
eq(matchDealKey(saved, { subject: "Financials", text: "Regarding your interest in https://x.com/dallas-hvac/bw2058311 please sign..." }),
  "https://x.com/dallas-hvac/bw2058311", "match: quoted listing URL");
eq(matchDealKey(saved, { subject: "Newsletter: HVAC market update", text: "hvac hvac hvac" }), null, "match: unrelated email no match");
eq(matchDealKey(saved, { subject: "Re: Profitable Austin Area HVAC and Established Dallas HVAC Service Company", text: "" }), null, "match: ambiguous (two deals) no match");

const mockRes = () => { const r = { headers: {} }; r.setHeader = () => {}; r.status = (c) => ((r.code = c), r); r.json = (b) => ((r.body = b), r); return r; };
let res = mockRes();
await handler({ method: "GET" }, res);
eq(res.body.enabled, false, "handler: disabled without env");
res = mockRes();
await handler({ method: "POST", body: {} }, res);
eq(res.code, 501, "handler: POST 501 without env");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
