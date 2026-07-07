# Deal Scanner — acquisition screening dashboard

Scrapes business-for-sale sources directly — **no LLM, no AI API key** — scores each
listing against your buy box, hides anything below your FIT cutoff, never repeats a
listing you've saved or passed, and (optionally) emails a digest **every 5 hours**.

## How listings are collected (no AI involved)

- **Direct scraping** — DealStream, BusinessBroker.net and Synergy Business Brokers
  are fetched and parsed straight from their search pages.
- **Search-index scraping** — BizBuySell, BizQuest and BusinessesForSale.com run
  bot protection (Akamai/Cloudflare) that blocks datacenter IPs, so their listings
  are read out of public search indexes (Bing RSS, DuckDuckGo HTML fallback) instead.
- The UI shows a per-source status chip after every pass (`N found` / `blocked` /
  `error`) — untick any source that isn't responding, so you always select
  companies from sites that are actually valid.

## The 5-hour refresh

Three mechanisms, so it works on any Vercel plan:

1. `/api/scan` responses are edge-cached with `s-maxage=18000` — each unique
   site+keyword+location is re-scraped at most once per 5 hours.
2. The frontend auto-scans on load when its cached results are older than 5 hours,
   and re-scans every 5 hours while the tab is open.
3. `vercel.json` schedules the email digest cron. It's set to `0 12 * * *` (daily)
   because **Vercel's Hobby plan only allows daily crons** — on a Pro plan you can
   change it to `0 */5 * * *` for a 5-hourly digest. Listings in the app refresh
   every 5 hours either way via mechanisms 1 and 2.

## Deploy

1. **Push to GitHub**, then import the repo at vercel.com. Vite is auto-detected.
   Scraping works out of the box — no environment variables needed.
2. **(Optional) Enable the 5-hourly digest email.** Add env vars:
   - `RESEND_API_KEY` — from resend.com (free: 100 emails/day)
   - `DIGEST_TO` — defaults to pengbo.dev@gmail.com
   - `WATCH_KEYWORD` / `WATCH_LOCATION` — defaults: HVAC / Texas
   - `FIT_MIN` — defaults to 40
   The digest only sends when there's something new above the cutoff.
3. **(Optional, $0) Shared starred deals + no-repeat digests.** Create a free
   Upstash Redis database (Vercel dashboard → Storage/Marketplace → Upstash →
   free plan, ~500K commands/month) and add:
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   With these set, ★ stars sync through `/api/saved` so everyone who opens the
   app shares one saved list (existing per-browser stars upload themselves on
   first visit), and the digest remembers what it already emailed. Note there's
   no per-user login — anyone with the app URL shares the same star list.
4. **(Optional, $0) Broker document uploads.** Vercel dashboard → Storage →
   Create → **Blob** → connect to this project (adds `BLOB_READ_WRITE_TOKEN`),
   then redeploy. Each pipeline deal gets an upload button for the docs the
   broker sends after the NDA (P&L, balance sheets, tax returns — pdf/xlsx/csv/
   docx/zip/images, up to 100MB each). Files upload from the browser straight
   to Blob storage, and the links attach to the deal so everyone sees the same
   document stack. Blob URLs are public-but-unguessable — fine for a small
   trusted group, but don't post them anywhere.
5. **(Optional, $0) Send inquiries from your own Gmail.** Enable 2-Step
   Verification on the Google account, create an **App Password**
   (myaccount.google.com → Security → 2-Step Verification → App passwords),
   then add env vars:
   - `GMAIL_USER` — e.g. bizbo0314@gmail.com
   - `GMAIL_APP_PASSWORD` — the 16-character app password
   The inquiry dialog gains a "Send from …" button (SMTP, ~500 emails/day free)
   and sending auto-advances the deal to "Inquired". Without these it falls
   back to opening your email app.
6. **(Optional, pay-per-use) In-app Claude analysis.** Add `ANTHROPIC_API_KEY`
   (console.anthropic.com) and each pipeline deal gets an **"Analyze with
   Claude"** button: the deal's uploaded documents (PDF/CSV/TXT/images) are
   sent to Claude server-side and the structured DD report is saved onto the
   deal — shared, like everything else. Typical cost is cents to ~$1 per
   analysis (model: `claude-opus-4-8`; override with `ANALYZE_MODEL`).
   Scanning never uses this key — only analysis does. Without the key, the
   copy-prompt buttons remain the manual fallback.
7. **(Optional) Protect the cron endpoint.** Add `CRON_SECRET` (any random string);
   Vercel automatically sends it with cron invocations.

## Local development

```bash
npm install
npm run dev        # UI at localhost:5173 (API routes need `vercel dev` instead)
```

## Honest notes

- Scraped figures are extracted verbatim from listing pages/snippets; anything not
  stated is "Not stated" — never estimated. Click through before trusting numbers.
- Site availability can shift: bot walls, layout changes and search-index coverage
  all vary. The per-source status chips are the source of truth for what's working
  right now — that's by design, so you can always pick a valid site.
- Broker inquiry emails open in **your own email app** (mailto) — the listing sites
  hide broker emails behind contact forms, so fully-automatic sending isn't possible.
- Respect each site's terms; the most durable ingestion is still their own
  saved-search email alerts.
