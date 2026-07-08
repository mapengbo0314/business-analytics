// Gmail inbox ingestion: pulls broker replies into the pipeline automatically.
// Reads the same Gmail as /api/inquire over IMAP (the app password covers both),
// matches each new email to a pipeline deal, uploads attachments to the deal's
// document stack (Vercel Blob), and appends the message to the deal's notes.
// Unmatched emails land in a shared "inbox" list for manual assignment.
//
// Requires: GMAIL_USER + GMAIL_APP_PASSWORD and Upstash Redis env vars.
// Attachments additionally need BLOB_READ_WRITE_TOKEN (otherwise text-only).
//
// GET                                → { enabled, from, unmatched: [...] }
// POST {}                            → sync: { checked, matched, unmatched }
// POST { action:"assign", id, dealKey } → attach an unmatched email to a deal
// POST { action:"dismiss", id }      → drop an unmatched email from the list

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { redis, redisConfigured } from "./_lib/redis.js";

const SAVED_KEY = "deals:saved";
const UNMATCHED_KEY = "inbox:unmatched";
const LAST_UID_KEY = "inbox:lastUid";
const MAX_ATTACHMENT = 25 * 1024 * 1024;

const gmailConfigured = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const blobConfigured = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const enabled = () => gmailConfigured() && redisConfigured();

// Test seams: harnesses inject fake parsed emails / a fake attachment uploader
// so the full receive path runs without IMAP or Blob network access.
export const _test = { fetchEmails: null, upload: null };

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Match an email to exactly one pipeline deal — by quoted listing URL or by the
// deal's name appearing in the subject/body (our outbound subject line is
// "Buyer inquiry — <deal name>", so replies match). Ambiguity → no match.
export function matchDealKey(savedMap, email) {
  const hayRaw = `${email.subject || ""} ${email.text || ""}`.toLowerCase();
  const hay = norm(hayRaw);
  const hits = new Set();
  for (const [k, deal] of Object.entries(savedMap || {})) {
    if (hayRaw.includes(k)) { hits.add(k); continue; }
    const name = norm(deal && deal.name);
    if (name.length >= 8 && hay.includes(name)) hits.add(k);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

async function loadSaved() {
  const flat = (await redis(["HGETALL", SAVED_KEY])) || [];
  const saved = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      try { saved[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip */ }
    }
  }
  return saved;
}

async function loadUnmatched() {
  const items = (await redis(["LRANGE", UNMATCHED_KEY, "0", "49"])) || [];
  return items.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

function stageRank(id) {
  return ["watching", "inquired", "form", "nda", "docs", "dd", "go", "passed"].indexOf(id || "watching");
}

// Apply an email (note + uploaded files) to a deal and persist it.
async function applyToDeal(saved, dealKey, email) {
  const deal = saved[dealKey];
  if (!deal) return false;
  const noteLine = `📧 ${new Date(email.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${email.from}: ${email.snippet}`;
  deal.notes = deal.notes ? `${deal.notes}\n${noteLine}` : noteLine;
  if (email.files && email.files.length) {
    deal.files = [...(deal.files || []), ...email.files];
    if (stageRank(deal.stage) < stageRank("docs")) {
      deal.stage = "docs";
      deal.stageAt = Date.now();
    }
  }
  await redis(["HSET", SAVED_KEY, dealKey, JSON.stringify(deal)]);
  return true;
}

async function uploadAttachments(parsed) {
  if (_test.upload) return _test.upload(parsed);
  const files = [];
  if (!blobConfigured()) return files;
  const { put } = await import("@vercel/blob");
  for (const att of (parsed.attachments || []).slice(0, 6)) {
    if (!att.filename || !att.content || att.content.length > MAX_ATTACHMENT) continue;
    try {
      const blob = await put(`deals/email/${att.filename}`, att.content, {
        access: "public",
        addRandomSuffix: true,
      });
      files.push({ name: att.filename, url: blob.url, size: att.content.length, at: Date.now(), via: "email" });
    } catch { /* one bad attachment shouldn't sink the sync */ }
  }
  return files;
}

async function syncInbox() {
  const user = process.env.GMAIL_USER;
  const result = { checked: 0, matched: 0, unmatched: 0 };
  const saved = await loadSaved();

  // Shared per-message pipeline: match → attach docs/notes → or queue unmatched.
  const handleParsed = async (parsed, uid) => {
    const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "";
    if (fromAddr.toLowerCase() === user.toLowerCase()) return; // our own sends
    result.checked++;
    const email = {
      id: `em-${uid}-${Date.now()}`,
      at: parsed.date ? new Date(parsed.date).getTime() : Date.now(),
      from: fromAddr,
      subject: parsed.subject || "(no subject)",
      snippet: String(parsed.text || "").replace(/\s+/g, " ").trim().slice(0, 300),
      files: await uploadAttachments(parsed),
    };
    const dealKey = matchDealKey(saved, { subject: parsed.subject, text: parsed.text });
    if (dealKey && (await applyToDeal(saved, dealKey, email))) {
      result.matched++;
    } else {
      await redis(["LPUSH", UNMATCHED_KEY, JSON.stringify(email)]);
      result.unmatched++;
    }
  };

  if (_test.fetchEmails) {
    const fakes = (await _test.fetchEmails()) || [];
    let i = 0;
    for (const parsed of fakes) await handleParsed(parsed, `fake-${++i}`);
    await redis(["LTRIM", UNMATCHED_KEY, "0", "49"]);
    return result;
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass: process.env.GMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const lastUid = Number((await redis(["GET", LAST_UID_KEY])) || 0);
    const uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [])
      .filter((u) => u > lastUid)
      .sort((a, b) => a - b)
      .slice(-15); // newest 15 per sync — the 5h cadence keeps up
    if (!uids.length) return result;

    let maxUid = lastUid;
    for (const uid of uids) {
      maxUid = Math.max(maxUid, uid);
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      await handleParsed(await simpleParser(msg.source), uid);
    }
    await redis(["LTRIM", UNMATCHED_KEY, "0", "49"]);
    await redis(["SET", LAST_UID_KEY, String(maxUid)]);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    if (!enabled()) {
      return res.status(200).json({
        enabled: false,
        message: gmailConfigured()
          ? "Inbox sync needs Upstash Redis env vars (same ones as shared stars)."
          : "Add GMAIL_USER + GMAIL_APP_PASSWORD in Vercel to sync broker replies.",
      });
    }
    try {
      return res.status(200).json({ enabled: true, from: process.env.GMAIL_USER, unmatched: await loadUnmatched() });
    } catch (err) {
      return res.status(502).json({ error: "redis_error", detail: String(err) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });
  if (!enabled()) return res.status(501).json({ enabled: false, error: "not_configured" });

  const { action, id, dealKey } = req.body || {};
  try {
    if (action === "assign" || action === "dismiss") {
      const items = await loadUnmatched();
      const item = items.find((e) => e.id === id);
      if (!item) return res.status(404).json({ error: "email_not_found" });
      if (action === "assign") {
        const saved = await loadSaved();
        if (!(await applyToDeal(saved, String(dealKey || ""), item)))
          return res.status(400).json({ error: "unknown_deal" });
      }
      await redis(["LREM", UNMATCHED_KEY, "1", JSON.stringify(item)]);
      return res.status(200).json({ ok: true });
    }
    const result = await syncInbox();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return res.status(502).json({ error: "inbox_failed", detail: String(err && err.message ? err.message : err) });
  }
}
