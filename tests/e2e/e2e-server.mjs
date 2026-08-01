// Local harness: serves the built app + real API handlers, with external
// fetches replaced by fixtures (sandbox has no egress) and an in-memory Redis.
import http from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.UPSTASH_REDIS_REST_URL = "https://mock.upstash.local";
process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";
process.env.GMAIL_USER = "bizbo0314@gmail.com";
process.env.GMAIL_APP_PASSWORD = "test-app-password";

// ---- fixtures: realistic Jina Reader markdown for marketplace search pages ----
const bbsMd = `Title: HVAC Businesses for sale
[Sell a business](https://www.bizbuysell.com/sell-a-business/)
[Find a broker](https://www.bizbuysell.com/business-brokers/)
[Businesses for sale in Texas](https://www.bizbuysell.com/texas-businesses-for-sale/)

[Profitable Austin Area HVAC Company](https://www.bizbuysell.com/business-opportunity/profitable-austin-area-hvac/2433694/)
Austin, TX · Asking Price: $675,000 · Cash Flow: $254,696 · Established: 1986

[Commercial HVAC Contractor With Recurring Contracts](https://www.bizbuysell.com/business-opportunity/commercial-hvac-contractor/2450001/)
Asking Price: $1.2M Cash Flow: $400K

[Phoenix Valley Air Conditioning Services](https://www.bizbuysell.com/business-opportunity/phoenix-valley-ac/2461111/)
Phoenix, AZ · Asking Price: $500,000 · Cash Flow: $180,000
`;
const bqMd = `Title: HVAC businesses
[Sell a business today](https://www.bizquest.com/sell-a-business/)
[Established Dallas HVAC Service Company](https://www.bizquest.com/business-for-sale/established-dallas-hvac-service-company/BW2058311/)
Dallas, TX Asking Price: $850,000 Cash Flow: $310,000 Gross Revenue: $2,100,000 Established: 2001
`;
// Returned for any query mentioning "plumbing" — proves a keyword switch
// replaces the pool instead of merging into the old results.
const plumbMd = `Title: Plumbing businesses
[Dallas Plumbing Works Company](https://www.bizquest.com/business-for-sale/dallas-plumbing-works-company/BW2058999/)
Dallas, TX Asking Price: $700,000 Cash Flow: $250,000 Gross Revenue: $1,500,000 Established: 2005
`;

// ---- in-memory redis ----
const hashes = {}, sets = {}, lists = {}, strings = {};
function redisExec(cmd) {
  const [op, key, ...rest] = cmd;
  switch (op) {
    case "GET": return strings[key] ?? null;
    case "SET": { strings[key] = rest[0]; return "OK"; }
    case "LPUSH": { lists[key] ||= []; lists[key].unshift(...rest); return lists[key].length; }
    case "LRANGE": {
      const l = lists[key] || [];
      const start = Number(rest[0]);
      const stop = Number(rest[1]);
      return l.slice(start, (stop === -1 ? l.length - 1 : stop) + 1);
    }
    case "LTRIM": {
      const l = lists[key] || [];
      const start = Number(rest[0]);
      const stop = Number(rest[1]);
      lists[key] = l.slice(start, (stop === -1 ? l.length - 1 : stop) + 1);
      return "OK";
    }
    case "LREM": {
      const l = lists[key] || [];
      const idx = l.indexOf(rest[1]);
      if (idx > -1) l.splice(idx, 1);
      return idx > -1 ? 1 : 0;
    }
    case "HSET": { hashes[key] ||= {}; for (let i = 0; i + 1 < rest.length; i += 2) hashes[key][rest[i]] = rest[i + 1]; return 1; }
    case "HGETALL": return Object.entries(hashes[key] || {}).flat();
    case "HDEL": { const h = hashes[key] || {}; let n = 0; for (const f of rest) if (f in h) { delete h[f]; n++; } return n; }
    case "HLEN": return Object.keys(hashes[key] || {}).length;
    case "SMEMBERS": return [...(sets[key] || [])];
    case "SADD": { sets[key] ||= new Set(); rest.forEach((v) => sets[key].add(v)); return rest.length; }
    default: return null;
  }
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith("https://mock.upstash.local")) {
    return new Response(JSON.stringify({ result: redisExec(JSON.parse(opts.body)) }), { status: 200 });
  }
  if (u.startsWith("https://r.jina.ai/")) {
    const target = decodeURIComponent(u.slice("https://r.jina.ai/".length));
    if (target.includes("plumbing")) return new Response(plumbMd, { status: 200 });
    if (target.includes("bizbuysell.com")) return new Response(bbsMd, { status: 200 });
    if (target.includes("bizquest.com")) return new Response(bqMd, { status: 200 });
    return new Response("", { status: 451 }); // jina couldn't fetch it either
  }
  if (u.includes("blob.vercel-storage.com")) {
    return new Response(u.endsWith(".csv") ? "month,revenue\nJan,100000\nFeb,120000" : "BINARY", { status: 200 });
  }
  return new Response("", { status: 403 }); // bing/ddg/mojeek/wayback/direct: blocked like prod
};

// ---- fake email plumbing (test seams) ----
const inquireMod = await import(`${ROOT}/api/inquire.js`);
const inboxMod = await import(`${ROOT}/api/inbox.js`);
const sentMails = [];
inquireMod._test.transport = {
  sendMail: async (m) => { sentMails.push(m); return { messageId: `fake-${sentMails.length}` }; },
};
const emailQueue = [];
inboxMod._test.fetchEmails = async () =>
  emailQueue.splice(0).map((e) => ({
    from: { value: [{ address: e.from }] },
    subject: e.subject,
    text: e.text,
    date: new Date(),
    attachments: (e.attachments || []).map((a) => ({ filename: a.filename, content: Buffer.from("x"), size: 5 })),
  }));
inboxMod._test.upload = async (parsed) =>
  (parsed.attachments || []).map((a) => ({
    name: a.filename,
    url: `https://x.blob.vercel-storage.com/deals/email/${a.filename}`,
    size: 5, at: Date.now(), via: "email",
  }));

// ---- route real handlers + static dist ----
const handlers = {
  "/api/scan": (await import(`${ROOT}/api/scan.js`)).default,
  "/api/saved": (await import(`${ROOT}/api/saved.js`)).default,
  "/api/listings": (await import(`${ROOT}/api/listings.js`)).default,
  "/api/upload": (await import(`${ROOT}/api/upload.js`)).default,
  "/api/inquire": inquireMod.default,
  "/api/analyze": (await import(`${ROOT}/api/analyze.js`)).default,
  "/api/inbox": inboxMod.default,
  "/api/prompt": (await import(`${ROOT}/api/prompt.js`)).default,
  "/test/queue-email": async (req, res) => { emailQueue.push(req.body); res.status(200).json({ ok: true, queued: emailQueue.length }); },
  "/test/sent": async (req, res) => res.status(200).json({ sent: sentMails }),
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const h = handlers[url.pathname];
  if (h) {
    let raw = "";
    for await (const c of req) raw += c;
    const req2 = {
      method: req.method,
      headers: req.headers,
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined,
    };
    const res2 = {
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { res.statusCode = c; return this; },
      json(b) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); },
    };
    try { await h(req2, res2); } catch (e) { res.statusCode = 500; res.end(String(e)); }
    return;
  }
  let file = join(ROOT, "dist", url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(file)) file = join(ROOT, "dist", "index.html");
  res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
  res.end(readFileSync(file));
});
server.listen(4173, () => console.log("harness up on http://localhost:4173"));
