# Phase 2: AI price lookup and admin review

## Goal
When a customer uploads photos (phase 1), FurniSwap automatically drafts a trade-in credit.
The team reviews the draft on a private admin page, adjusts it if needed, and sends it to
the customer on WhatsApp.

## Decisions so far
| Topic | Decision |
|---|---|
| Sources | OLX (olx.com.pk) for used prices; Interwood + Habitt for new prices (shown as reference only) |
| Pricing | Existing site calculator: benchmark × age × material × condition, **capped by OLX used prices** |
| AI model | Claude Haiku 5.5 (~$0.01 per quote + ~$0.02 web search, about $3 per 100 quotes) |
| Form | Photos only; AI estimates type, material, condition and age |
| Review | New admin page, login by Cloudflare email code (owner + team emails) |

## How it works

### 1. Identify + research (Claude Haiku 5.5)
For each new submission, the server:
- downloads the photos from the submission's Drive folder
- sends them to Claude with the calculator's categories
- uses Claude's built-in **web search** tool, limited to `olx.com.pk`, `interwood.pk` and `habitt.com`

Claude returns structured JSON:
- `typeKey`: one of the calculator's 16 categories (e.g. `sofa-5`)
- `material`, `condition`, `ageEstimate`, and a confidence for each
- `comparables`: title, price, source, link, used/new, and how similar it is

**Why web search and not direct scraping:** OLX blocks automated visitors with a "Security
check" page, and getting around bot protection isn't acceptable. Search results still carry
listing titles, prices and links. Interwood and Habitt are Shopify stores that allow crawling.

### 2. Price (plain code, no AI)
The site's `ValuationEngine` moves into a shared module (`functions/_lib/valuation.js`), so
the website calculator and the server use the same numbers:
1. `credit range = benchmark[typeKey] × ageFactor × materialFactor × conditionRate(min..max)`
2. **OLX cap:** if 3 or more comparable used OLX listings are found, the credit is capped at
   `OLX_CAP_PCT` (default **70%**) of their median price. With fewer, no cap is applied and
   the quote is flagged "low market data".
3. Low AI confidence (for example, the photos don't show the item clearly) flags the quote
   "needs a human look".

New-store prices from Interwood and Habitt are shown on the admin page as context only.

### 3. When it runs
- **Right after upload:** in the background (Cloudflare allows about 30 seconds after the reply).
- **Fallback:** anything still `new` or `failed` is priced when the admin page is opened, or
  by pressing **Re-run AI** on a submission.

No extra server or cron job is needed.

### 4. Storage and status
Drive stays the single place where data lives:
- `quote.json` (AI result, comparables, calculated range, flags) is written into the submission folder
- the status is kept on the folder: `new → priced → approved → sent` (or `failed`)

### 5. Admin page (`/admin`)
- Protected by **Cloudflare Access** (free for up to 50 users). Only listed emails can log in,
  using a one-time code sent by email. The server also checks the Access login on every admin API call.
- Shows:
  - a list of submissions by status, with photo thumbnails, the AI type/condition, the credit
    range and any flags
  - for each submission: full photos, comparable listings with links, the calculation
    breakdown and an editable final credit
- Actions:
  - **Approve**
  - **Re-run AI**
  - **Send on WhatsApp**: opens WhatsApp with the customer's number and the quote message
    filled in; a team member presses Send
- The old in-page admin panel (its passcode was readable in the page source) should be
  removed once this replaces it.

## Files
- `functions/_lib/valuation.js`: shared calculator
- `functions/_lib/drive.js`: Drive helpers, moved out of `quote-upload.js`
- `functions/_lib/pricing.js`: Claude call, OLX cap, writing `quote.json`
- `functions/api/quote-upload.js`: starts pricing in the background
- `functions/api/admin/*.js`: list, view, approve, re-run, photo proxy
- `admin.html`: the admin page
- `package.json`: `@anthropic-ai/sdk` (Cloudflare installs it at deploy)

## Owner setup (one time)
1. Create an Anthropic API key at console.anthropic.com with prepaid credit (about $5 covers
   about 30 quotes) and add it as the Pages secret `ANTHROPIC_API_KEY`.
2. Approve creating the Cloudflare Access app for `/admin` with your team's emails. Claude can
   set this up through the Cloudflare connector once you approve it.

## Testing
- Run against the existing test submission and 3–4 real furniture photo sets (sofa, bed,
  dining set, wardrobe).
- For each, check the type and condition, that the comparable links are real and similar,
  and that the OLX cap works when it should.
- Check that the admin page refuses visitors who aren't logged in, and that the photo and
  approve endpoints refuse requests without a valid Access login.
- Check the end-to-end flow on furniswap.pk: upload, draft appears, approve, WhatsApp
  message opens with the correct numbers.

## Running cost
Around $0.03 per quote (Claude Haiku + web search). Cloudflare Access and Pages are free at
this size.
