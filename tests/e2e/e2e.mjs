// Full-loop Playwright E2E: scan → star → send inquiry from Gmail (fake SMTP)
// → faked broker reply auto-attaches → keyless full research prompt → unmatched
// email assignment → shared persistence across a wiped browser → keyword
// switching replaces results.
// Run with a playwright install on the module path, e.g.:
//   NODE_PATH=<dir-with-playwright>/node_modules PW_EXE=/opt/pw-browsers/chromium node e2e.mjs
import { chromium } from "playwright";

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"} ${label}`); if (!ok) fails++; };

const exe = process.env.PW_EXE;
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
await page.route("**/*", (route) =>
  route.request().url().startsWith("http://localhost") ? route.continue() : route.abort()
);
const readClip = () => page.evaluate(() => navigator.clipboard.readText()).catch(() => "");

// ---------- 1. scanning ----------
await page.goto("http://localhost:4173/");
await page.waitForSelector("text=Profitable Austin Area HVAC Company", { timeout: 30000 });
check(true, "scan: TX listing rendered (auto-scan on load)");
check(await page.isVisible("text=Established Dallas HVAC Service Company"), "scan: second source's listing rendered");
check(await page.isVisible("text=Commercial HVAC Contractor With Recurring Contracts"), "scan: no-location listing kept");
check(!(await page.isVisible("text=Phoenix Valley Air Conditioning Services")), "scan: AZ listing dropped for Texas filter");
check(!(await page.isVisible("text=Sell a business")), "scan: nav junk absent");
const chips = await page.textContent("body");
check(/BizBuySell · \d+ found/.test(chips), "chips: bizbuysell reports found count");
check(/BusinessBroker\.net · (blocked|error|rate-limited)/.test(chips), "chips: unreachable source reports blocked/error");
check(!chips.includes("DealStream"), "chips: dealstream removed everywhere");
check(chips.includes("★ shared with your team"), "header: shared mode detected");

await page.locator("input").first().fill("");
await page.click('button:has-text("Refresh now")');
await page.waitForSelector("text=Profitable Austin Area HVAC Company", { timeout: 30000 });
check(true, "scan: empty keyword allowed and returns listings");

const pool = await page.evaluate(() => fetch("/api/listings").then((r) => r.json()));
check(pool.enabled && pool.listings.length >= 3, `storage: /api/listings has ${pool.listings.length} stored companies`);
check(!(await page.isVisible('button:has-text("Analyze with Claude")')), "keyless: analyze button hidden without API key");

// ---------- 2. star (with attribution popup) -> pipeline ----------
const austin = page.locator("article", { hasText: "Profitable Austin Area HVAC Company" }).first();
await austin.locator('button[aria-label="Save deal"]').click();
await page.waitForSelector("text=WHO'S STARRING THIS?");
check(true, "star: attribution popup appears");
await page.fill('input[placeholder*="Your name"]', "Pengbo");
await page.click('button:has-text("★ Star deal")');
await page.waitForSelector("text=★ Pipeline (1)");
await page.click("text=★ Pipeline (1)");
await page.waitForSelector("text=PIPELINE —");
check(await page.isVisible("text=Next: read the listing and send the inquiry"), "pipeline: Watching hint");
check(await page.isVisible("text=BROKER INBOX — BIZBO0314@GMAIL.COM"), "inbox: panel visible with Gmail configured");

// ---------- 2b. step log: manual check-off ----------
check(await page.isVisible("text=STEP LOG — 0/10 STEPS TAKEN"), "steps: log starts at 0/10");
await page.locator('label:has-text("Read the full listing") input').click();
await page.waitForSelector("text=STEP LOG — 1/10 STEPS TAKEN");
check(true, "steps: manual check-off counts");
check(await page.locator('label:has-text("Read the full listing") input').isChecked(), "steps: checkbox stays checked");

await page.fill("textarea >> nth=0", "Broker: Jane D. — sharp, responsive.");
await page.locator("textarea").first().blur();
await page.waitForTimeout(400);

// ---------- 3. send inquiry FROM the user's Gmail (fake SMTP) ----------
await page.click('button:has-text("Request missing info")');
await page.waitForSelector('input[placeholder*="Broker"]');
check(await page.isVisible('button:has-text("Send from bizbo0314@gmail.com")'), "inquiry: direct-send button with Gmail configured");
await page.fill('input[placeholder*="Broker"]', "jane@broker.com");
await page.click('button:has-text("Send from bizbo0314@gmail.com")');
await page.waitForSelector("text=✓ Info request drafted", { timeout: 10000 });
check(true, "inquiry: sent flag shown after send");
check(await page.isVisible("text=Waiting on the buyer form"), "inquiry: stage auto-advanced to Inquired");
check(await page.isVisible("text=STEP LOG — 2/10 STEPS TAKEN"), "steps: sending the inquiry auto-logs its step");
const sent = await page.evaluate(() => fetch("/test/sent").then((r) => r.json()));
check(sent.sent.length === 1 && sent.sent[0].to === "jane@broker.com", "inquiry: mail captured by fake SMTP with right recipient");
check(sent.sent[0].subject.includes("Profitable Austin Area HVAC Company"), "inquiry: subject carries deal name (enables reply matching)");
check(sent.sent[0].from === "bizbo0314@gmail.com", "inquiry: sent from the user's Gmail");

// ---------- 4. keyless HITL: the full research prompt ----------
await page.click('button:has-text("Copy research prompt for Claude")');
await page.waitForSelector("text=✓ Copied — paste into claude.ai");
let clip = await readClip();
check(clip.includes("Profitable Austin Area HVAC Company") && clip.includes("MY BUY BOX"), "prompt: deal facts + buy box");
check(clip.includes("Jane D."), "prompt: notes included");
check(clip.includes("SDE verification") && clip.includes("6. Verdict"), "prompt: full six-section analysis request");
check(await page.isVisible("text=STEP LOG — 3/10 STEPS TAKEN"), "steps: copying the research prompt auto-logs the analyze step");

// ---------- 5. flow guards + follow-up ----------
await page.click('button:has-text("In due diligence")');
check(await page.isVisible("text=No broker docs uploaded"), "flow: DD-without-docs warning");
check(await page.isVisible('button:has-text("Re-ask Claude")'), "flow: follow-up button after first copy");
await page.click('button:has-text("Re-ask Claude")');
await page.waitForSelector("text=✓ Copied follow-up");
clip = await readClip();
check(clip.includes("Since the last analysis") && clip.includes("what CHANGED"), "flow: follow-up prompt content");
check((await page.textContent("body")).includes("analyzed 2×"), "flow: DD counter increments");
await page.click('button:has-text("NDA signed")');
await page.waitForSelector("text=Waiting on business docs / financials");
check(await page.isVisible("text=STEP LOG — 4/10 STEPS TAKEN"), "steps: moving to a stage logs the matching step (NDA)");

// ---------- 6. FAKED broker reply -> auto-attaches to the deal ----------
await page.evaluate(() =>
  fetch("/test/queue-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "jane@broker.com",
      subject: "Re: Buyer inquiry — Profitable Austin Area HVAC Company",
      text: "NDA attached, please sign. Financials included. - Jane",
      attachments: [{ filename: "NDA.pdf" }, { filename: "financials.csv" }],
    }),
  })
);
await page.click('button:has-text("Check inbox now")');
await page.waitForSelector("text=1 matched to deals", { timeout: 15000 });
check(true, "inbox: faked broker reply matched to the deal");
await page.waitForSelector("text=📄 NDA.pdf");
check(await page.isVisible("text=📄 financials.csv"), "inbox: attachments landed in the deal's doc stack");
check(await page.isVisible("text=Next: run due diligence"), "inbox: stage auto-advanced to Docs received");
check(await page.isVisible("text=STEP LOG — 5/10 STEPS TAKEN"), "steps: docs arriving by email auto-logs the docs step");
const notesVal = await page.inputValue("textarea >> nth=0");
check(notesVal.includes("NDA attached, please sign"), "inbox: email text appended to shared notes");

// ---------- 7. the whole-ass prompt now carries the docs ----------
await page.click('button:has-text("Copy research prompt again")');
await page.waitForSelector("text=✓ Copied — paste into claude.ai");
clip = await readClip();
check(clip.includes("month,revenue"), "prompt: csv document contents INLINED");
check(clip.includes("NDA.pdf"), "prompt: binary doc listed for attachment");
check(clip.includes("NDA attached, please sign"), "prompt: broker email history included");
check(await page.isVisible("text=Also attach these files in claude.ai: NDA.pdf"), "prompt: attach reminder shown");

// ---------- 8. unmatched email -> manual assignment ----------
await page.evaluate(() =>
  fetch("/test/queue-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "other@broker.com",
      subject: "Following up",
      text: "Great chatting today about opportunities in your area.",
    }),
  })
);
await page.click('button:has-text("Check inbox now")');
await page.waitForSelector("text=1 need assignment", { timeout: 15000 });
await page.waitForSelector("text=Following up", { timeout: 10000 }); // list refresh lands just after the status message
check(true, "inbox: unmatched email queued for assignment");
await page.selectOption("select", { label: "Profitable Austin Area HVAC Company" });
await page.click('button:has-text("Attach")');
await page.waitForFunction(() => !document.body.textContent.includes("Following up"), { timeout: 10000 });
check(true, "inbox: assigned email removed from queue");
const notesVal2 = await page.inputValue("textarea >> nth=0");
check(notesVal2.includes("Great chatting today"), "inbox: assigned email text landed on the deal");

check(await page.isVisible("text=Uploads are off"), "docs: Blob setup hint still shown when not configured");

// ---------- 9. shared persistence across a wiped browser ----------
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector("text=★ Pipeline (1)", { timeout: 30000 });
await page.click("text=★ Pipeline (1)");
await page.waitForSelector("text=Next: run due diligence");
check(await page.isVisible("text=📄 NDA.pdf"), "wipe: broker docs survive a wiped browser");
const notesVal3 = await page.inputValue("textarea >> nth=0");
check(notesVal3.includes("Jane D.") && notesVal3.includes("NDA attached"), "wipe: notes + email history survive");
check(await page.isVisible("text=STEP LOG — 5/10 STEPS TAKEN"), "wipe: step log survives a wiped browser");
check(await page.locator('label:has-text("Read the full listing") input').isChecked(), "wipe: manually-checked step survives");

// ---------- 10. switching the keyword REPLACES results (no stale carry-over) ----------
await page.click('button:has-text("Deals above fit")');
await page.waitForSelector("text=Commercial HVAC Contractor With Recurring Contracts", { timeout: 30000 });
await page.locator("input").first().fill("plumbing");
await page.click('button:has-text("Refresh now")');
await page.waitForSelector("text=Dallas Plumbing Works Company", { timeout: 30000 });
check(true, "keyword switch: new keyword's listings shown");
check(!(await page.isVisible("text=Commercial HVAC Contractor With Recurring Contracts")), "keyword switch: old keyword's results replaced, not merged");
check(!(await page.isVisible("text=Established Dallas HVAC Service Company")), "keyword switch: stale results gone from all sources");
check(await page.isVisible("text=★ Pipeline (1)"), "keyword switch: starred pipeline deal untouched");

await browser.close();
console.log(fails ? `\n${fails} FAILURES` : "\nALL PASS");
process.exit(fails ? 1 : 0);
