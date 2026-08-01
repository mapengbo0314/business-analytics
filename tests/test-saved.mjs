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

// unconfigured -> enabled:false
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const { default: handler } = await import("../api/saved.js");
let res = mockRes();
await handler({ method: "GET" }, res);
eq(res.body.enabled, false, "unconfigured GET -> enabled:false");

// configured with mocked Upstash
process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
const calls = [];
const deal = { name: "HVAC Co", listingUrl: "https://x.com/deal/12345/", asking: 500000 };
globalThis.fetch = async (url, opts) => {
  const cmd = JSON.parse(opts.body);
  calls.push(cmd);
  if (cmd[0] === "HGETALL") return { json: async () => ({ result: ["https://x.com/deal/12345", JSON.stringify(deal)] }) };
  return { json: async () => ({ result: 1 }) };
};

res = mockRes();
await handler({ method: "GET" }, res);
eq(res.body.enabled, true, "GET enabled");
eq(res.body.saved["https://x.com/deal/12345"].name, "HVAC Co", "GET parses hash pairs");

res = mockRes();
await handler({ method: "POST", body: { deal } }, res);
eq(res.body.ok, true, "POST ok");
eq(calls.at(-1).slice(0, 3), ["HSET", "deals:saved", "https://x.com/deal/12345"], "POST canonical HSET");

res = mockRes();
await handler({ method: "DELETE", query: { url: "https://X.com/deal/12345/" } }, res);
eq(calls.at(-1), ["HDEL", "deals:saved", "https://x.com/deal/12345"], "DELETE canonical HDEL");

res = mockRes();
await handler({ method: "POST", body: {} }, res);
eq(res.code, 400, "POST without deal -> 400");

console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
