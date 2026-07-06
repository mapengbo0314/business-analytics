# Deal Scanner — acquisition screening dashboard

Scans BusinessesForSale.com, BizBuySell and BizQuest for businesses matching a keyword,
scores each listing against your buy box, hides anything below your FIT cutoff, never
repeats a listing you've saved or passed, and (optionally) emails a daily digest.

## Deploy in ~10 minutes, $0 hosting

1. **Push to GitHub.** Create a new repo and push this folder to it.
2. **Import to Vercel.** vercel.com → Add New → Project → pick the repo → Deploy.
   Vercel auto-detects Vite. That's it — the app is live.
3. **(Optional) Enable live scanning.** Project → Settings → Environment Variables:
   - `ANTHROPIC_API_KEY` — from console.anthropic.com. Without it, the app still
     works as a tracker; the Scan button will explain what's missing.
4. **(Optional) Enable the 7:00 AM daily digest email.** Add:
   - `RESEND_API_KEY` — from resend.com (free: 100 emails/day)
   - `DIGEST_TO` — defaults to pengbo.dev@gmail.com
   - `WATCH_KEYWORD` / `WATCH_LOCATION` — defaults: HVAC / Texas
   - `FIT_MIN` — defaults to 40
   The cron is already configured in `vercel.json` (12:00 UTC = 7:00 AM CDT).
5. **(Optional) No-repeat digests across days.** Create a free Upstash Redis database
   (Vercel Marketplace → Upstash) and add:
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   Without these the digest still sends, but can't remember yesterday's listings.
6. **(Optional) Protect the cron endpoint.** Add `CRON_SECRET` (any random string);
   Vercel automatically sends it with cron invocations.

## Local development

```bash
npm install
npm run dev        # UI at localhost:5173 (API routes need `vercel dev` instead)
```

## Honest notes

- Broker inquiry emails open in **your own email app** (mailto) — best deliverability,
  and you paste the broker's address from the listing page. The listing sites hide
  broker emails behind contact forms, so fully-automatic sending isn't possible anyway.
- Scan results are marked "not yet validated" until you click through — search
  snippets can be stale. The nightly digest fetches nothing it can't link to.
- Respect each site's terms: this scans via web search rather than crawling the
  sites directly, and the best long-term ingestion is their own saved-search
  email alerts.
# business-analytics
