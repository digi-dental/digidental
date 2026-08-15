# Digi Dental — one-page conversion funnel

Single-page site selling a done-for-you AI receptionist for dental practices.
Design + full front-end lives in `index.html` (open in a browser, or deploy the
repo to Vercel — the root serves it automatically).
Repo scaffolding for the production build (React + Vite + Tailwind + Vercel functions + Supabase):

- `api/demo-session.ts` — one-demo-per-IP gate (called by `startDemo()` before every demo call)
- `api/notify-lead.ts` — Supabase insert + owner email via Resend (honeypot + per-IP rate limit)
- `api/event.ts` — first-party funnel analytics, one row per event in `site_events`
- `api/video.ts` — stable URLs for the two marketing videos, so no expiring token lives in the page
- `api/site-info.ts` — public JSON summary for AI agents (no deps, no secrets)
- `supabase/migrations/` — `001` leads + demo sessions, `002` site events (+ the KPI queries)
- `.env.example` — every required variable, placeholder values only
- `vercel.json` — response headers for the SEO/AI files (content types, CORS, caching)

## SEO and AI discoverability
Canonical origin: **`https://www.digidental.us`**. The bare apex `digidental.us`
is an A record to Vercel (`216.198.79.1`) which 308-redirects to `www`.

The page renders client-side, so anything inside `<x-dc>` (including `<helmet>`)
is invisible to crawlers that don't run JavaScript. All crawler-facing tags
therefore live in the **static `<head>`** of `index.html`: title, description,
canonical, robots, hreflang, Open Graph/Twitter, and a JSON-LD `@graph` of nine
nodes — Organization, WebSite, WebPage, Service with offers, FAQPage, Person
(founder, an E-E-A-T signal), two VideoObjects and an ImageObject logo.

Supporting files served from the root: `robots.txt` (search engines + ~35 named
AI crawlers, points at the sitemap), `sitemap.xml` (with image **and video**
extensions — the `<video>` elements are client-rendered, so the clips would
otherwise be undiscoverable), `llms.txt` (llmstxt.org index) and `llms-full.txt`
(the long brief, including the full FAQ verbatim), `og-image.png` (social card),
and `/api/site-info` (JSON).

### robots.txt groups do not inherit
A robots.txt group does **not** inherit from `User-agent: *`. The moment a crawler
finds a group naming it, that group becomes the only one it obeys (RFC 9309 §2.2.1).

This file used to give every named bot a bare `Allow: /` and keep the admin and API
disallows in the wildcard group alone. The effect was the exact opposite of how it
read: Googlebot, GPTBot, ClaudeBot, PerplexityBot and every other named agent were
being told `/admin.html` and the whole API were fair game, while only *unnamed*
crawlers were restricted. The tests asserting "robots.txt keeps the admin page out"
passed throughout, because they only ever looked at the wildcard group.

Every group now repeats the same rule set in full. Multiple `User-agent` lines
stacked before one rule block form a single group that applies to all of them, which
is what keeps the repetition manageable. **If you add a rule, add it to all three
groups** — `test:seo` parses the file into real groups and fails if one drifts.

Three `/api/` paths are deliberately punched through the `/api/` disallow:

| Path | Why it must stay crawlable |
| --- | --- |
| `/api/site-info` | The JSON summary answer engines are meant to read |
| `/api/video` | The `<video:content_loc>` in `sitemap.xml` and the `contentUrl` on both VideoObject nodes. Blocked, Google cannot verify either clip and silently drops both video rich results |
| `/api/image` | The founder portrait behind the Person node and the ImageObject logo |

The `Allow:` lines are ordered before the competing `Disallow:` so first-match-wins
parsers reach the same verdict as RFC 9309's longest-match ones. A test pins that too.

### llms.txt and llms-full.txt
`llms.txt` follows the [llmstxt.org](https://llmstxt.org) format: one H1, a blockquote
summary, free prose, then H2 sections whose bodies are **markdown link lists**. The
previous version had the H1 and the blockquote but every H2 held prose bullets, which
is why validators reported it as invalid.

Deep content moved to `llms-full.txt`, the conventional companion file — pricing
arithmetic, timeline, data handling, positioning and the verbatim FAQ. `llms.txt`
still carries pricing and the metro list inline in its prose block, because plenty of
crawlers read the index and never follow a link.

`test:seo` validates the format (single H1, blockquote, every section a link list,
absolute URLs, own-domain links resolving to files that exist) and checks the two
files cross-reference each other and quote the same setup fee as `index.html` and
`api/site-info.ts`.

### What a non-rendering crawler sees
Googlebot executes JavaScript. **GPTBot, ClaudeBot and PerplexityBot largely do not.**
The dc-runtime keeps its content as real markup, so the copy is in the served
HTML — but two things polluted it before the runtime mounts:

- `sc-if` is a directive, not an HTML conditional. With no JS **every branch
  renders**, so the error boundary ("A momentary hiccup. This page had trouble
  rendering.") was literally the first thing an AI crawler read.
- Unresolved `{{ holes }}` render as literal text — 17 of them.

Both are now hidden by CSS scoped to `x-dc` / `sc-if` / `sc-for`, tags the runtime
**removes from the DOM on hydration**. That scoping is the whole safety argument:
the rules can only match before hydration, so they are provably inert for anyone
running JavaScript. Do not widen those selectors.

The FAQ is rendered from `faqData` by a loop, so it does not exist pre-hydration
at all. A `<noscript>` mirror carries the identical text, generated from the page's
own FAQPage schema and pinned by tests. Result: **17,457 characters of clean
crawler-readable copy, zero template syntax, all nine Q&As.**

True SSR would need a build step or a server framework; this is the progressive-
enhancement equivalent for a single static file.

**`npm run test:seo` guards all of it.** 88 static checks: one canonical origin
across every file, no dangling JSON-LD `@id`s, the FAQ schema matching the FAQ
the visitor actually sees, one `<h1>` with no skipped levels, every `<img>` with
alt and reserved layout space, complete OG/Twitter cards with `og:image`
dimensions matching the real file, and admin/API kept out of robots.txt. SEO
decays silently; nothing here throws on its own.

Note: `index.html` is regenerated by Claude Design exports. A fresh export
**overwrites the static `<head>`** — re-apply the SEO block after each sync, then
run `npm run test:seo` to confirm nothing was lost.

## Dashboard preview accordion
Four screenshots in `[data-section="dashboard"]`, one open at a time.

**Click-driven, deliberately.** It was `onMouseEnter`, which meant moving the cursor
toward a panel re-selected every panel it crossed — while each was mid
width-transition, so the element under the pointer kept changing and the selection
thrashed. `npm run test:render` sweeps the cursor across all four and asserts the
selection does not move.

Two layouts, same 0.55s curve:
- **≥1000px** — a row. Collapsed panels are 74px rails with rotated labels; the open
  one animates `width`.
- **<1000px** — a column. The rail becomes a tappable header and the body animates
  `grid-template-rows: 0fr → 1fr`, which resolves to the content's real height.
  `max-height` was rejected: a guessed ceiling makes the easing finish early and stutter.

`.dd-dash-body` is reset to `display:block` on desktop so the grid transition cannot
fight the width transition.

## Changing the domain
Canonical, hreflang, Open Graph, JSON-LD `@id`s, sitemap, robots and llms.txt all
carry an absolute base URL. To move to a different domain, update every occurrence
in one pass from the repo root:

    grep -rl 'www.digidental.us' --exclude-dir=.git --exclude-dir=node_modules . \
      | xargs sed -i 's|www\.digidental\.us|YOUR-DOMAIN.com|g'

Then update `ORIGIN` in `test/seo.test.mjs` and run `npm run test:seo` — it fails
on any file left behind. Point the domain at the Vercel project (Settings →
Domains) and set it as the primary domain so other hosts redirect to it.

## Google Search Console
Verify the **domain property** (`digidental.us`), not a URL prefix. A domain
property covers the apex, `www`, `http` and `https` and every subdomain in one
record, so nothing needs re-verifying when a hostname changes.

1. https://search.google.com/search-console → Add property → **Domain** →
   `digidental.us`.
2. Google shows one `TXT` record. In Namecheap → Domain List → digidental.us →
   Advanced DNS → Add New Record: type `TXT Record`, Host `@`, Value the
   `google-site-verification=…` string, TTL Automatic. **Do not delete the
   existing SPF TXT record** — a domain may hold many TXT records but only one
   starting `v=spf1`.
3. Wait for propagation, then press Verify.
4. Sitemaps → submit `sitemap.xml`.
5. Settings → Crawl stats is the closest thing to a log-file analyser available
   on this stack: Vercel's Hobby plan exposes no raw access logs, so bot
   behaviour is read from Search Console rather than from the origin.

If DNS verification is blocked for any reason, the fallback is a
`<meta name="google-site-verification" content="…">` in the static `<head>` of
`index.html`, directly under the canonical link. That only verifies the exact
URL prefix it is served from, which is why DNS is preferred.

## Where real keys go
Real values are entered ONLY in your local `.env` (gitignored) and in the hosting
dashboard (Vercel → Project → Settings → Environment Variables). Never in code.

- `VITE_*` vars are public by design (anon key is protected by RLS; the Voice Infrastructure key is the PUBLIC web key).
- `RESEND_API_KEY`, `RESEND_FROM`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `NOTIFY_EMAIL_TO`,
  `SITE_TOKEN`, `VIDEO_VSL_URL` and `VIDEO_DEMO_URL` are server-side only.

## Demo call hard limits
The client stops the call at 60s, but the real limit lives in the Voice Infrastructure dashboard:
set `maxDurationSeconds: 60` and a spend cap on the demo assistant.

The visitor-level limit is enforced server-side, in two steps: `startDemo()` asks
`/api/demo-session` whether this hashed IP may call, and `goLive()` posts `{ claim: true }`
to spend it once the call is actually connected — so a denied microphone or a dropped
connection costs the visitor nothing. Only an explicit `already_demoed` blocks a call;
transport errors deliberately **fail open**, because a hot lead must never be turned away
by our own hiccup. `localStorage` remains as the instant, no-round-trip layer above it.

## Analytics
Every funnel step fires through `track()` in `index.html`. Three sinks, one taxonomy:

1. `/api/event` → the `site_events` table. Always on, no third-party tracker.
   **Apply `supabase/APPLY_TO_SUPABASE.sql` first** (migrations `005`, `006` and `007` in one
   paste) — until `site_events` exists, events are accepted and dropped. If the dashboard
   reports functions missing from the schema cache, only the tail of that 39 KB file failed to
   paste: run the matching single-migration file instead — `supabase/APPLY_007_ONLY.sql` or
   `supabase/APPLY_008_ONLY.sql`. Each is ~10 KB and prints the functions it created, so a
   truncated paste is visible rather than silent. (`002` and `003` are
   superseded by `005`; they are kept only as history and must not be run.)
2. Plausible — set `PLAUSIBLE_DOMAIN` in `index.html` to the live domain and the script
   loads itself; every event mirrors automatically.
3. GA4 — drop a `gtag` snippet in and every event mirrors to it. Nothing else to wire.

### Identity
Three separate ideas, deliberately not conflated:

| | Stored in | Lives for | Used for |
|---|---|---|---|
| `visitor_id` | `localStorage` | until storage is cleared | counting people, returning visits, journeys |
| `session_id` | `sessionStorage` | one visit, 30-min idle rollover | grouping the steps of a visit |
| `ip_hash` | server only | per request | abuse control **only**, never identity |

Both ids are random and carry no personal data. `ip_hash` used to double as the visitor
count, which was wrong in both directions: IPs rotate on mobile networks and are shared
across an office. The privacy copy in `index.html` discloses the stored identifier.

### Taxonomy
Events carry a `category` so a whole class can be filtered without matching on names. The
allowlist in `api/event.ts` is derived from the same map, so the two cannot drift.

- **BEHAVIOR** — `page_view`, `view_hero`, `section_view`, `scroll_depth`, `section_time`,
  `video_play`, `video_progress`, `video_watch`, `calc_interact`, `session_end`,
  `element_click`
- **INTENT** — `cta_impression`, `cta_click`, `form_open`, `form_step_1..5`, `demo_start`,
  `exit_intent_shown`, `exit_intent_demo`
- **CONVERSION** — `demo_complete`, `form_submit`, `calendly_click`, `lead_captured`,
  `contact_click`
- **TECHNICAL** — `demo_error`, `demo_blocked`, `form_error`, `page_not_found`

`cta_impression` is what makes click-through a real rate rather than a reflection of page
position: mark any new button with `data-cta="<placement>"` and the impression fires when it
scrolls into view. The placement string must match the `location` the click handler reports,
or the two will not line up. Videos are named with `data-clip`, never by DOM order.

`element_click` and `contact_click` come from a single delegated listener on the document, so
**every** link and button is counted without anyone having to instrument it — including
controls added later. That matters: before it existed, fewer than half the WhatsApp and email
links on the page had a handler, so "how many people actually emailed me" had no answer.
`contact_click` carries `channel` (`whatsapp` / `email` / `phone`), and Calendly is folded in
alongside it by `rpc_contact` so all four routes to you are compared on one footing.

### The dashboard's own views
`/admin.html` is one page with real views rather than a long scroll: the sidebar swaps content
instead of jumping a few hundred pixels. The Overview leads with one large chart that switches
between visitors, clicks, visits, demos, forms, contacts and leads — every series arrives in a
single `rpc_series` call, so switching is instant and all of them cover the same days.

**Click log** (`rpc_click_log`) is the record behind the click-through rates: one row per click
with the timestamp, what was clicked, which section, the channel, country/region/city, device,
source and the anonymous visitor id. Nothing new is collected; it is the events already stored,
shown individually rather than only in aggregate.

**Audit** (`rpc_monthly`, `rpc_monthly_breakdown`) works in calendar months rather than a
rolling window, so one month can be compared with the last, and splits those conversions by
source, country, device or campaign.

**Export** covers `.md` (a full written report), `.csv` (every dataset), `.json` (raw), and
`.png` of the current chart, rendered from its own SVG onto a canvas.

### Aggregation
All of it happens in Postgres, in the functions created by `006`. `/api/stats` just calls
them and returns the result, so the payload stays small no matter how many events exist.
Adding a panel means adding a function, not looping in JavaScript.

## What counts as a lead
A lead is **someone you could pick up the phone and call**: name, email and phone all present
and non-blank, with a plausible email, and not a bot.

This needed saying out loud because the `leads` table takes three sources and only one of them
carries contact details. A completed demo call or a dismissed exit-intent popup inserts a row
with name, email and phone all null — the visitor never typed anything. Those rows were being
counted in the headline lead number and listed in the dashboard's Leads table as blank rows, so
the count was inflated and the table was mostly empty.

Those rows are still stored and still shown — they are real interest and worth knowing about —
but under **Intent signals**, in a disclosure that is **collapsed by default**, each one labelled
with what it was missing. Collapsed because the rows have no name, email or phone on them, so
leaving them open put a stack of blank rows in the middle of the Leads page — the exact thing
this change set out to remove. The count is on the tile above either way.

The definition lives in three places that have to agree, and each exists for a reason:

| Where | Why it is there |
| --- | --- |
| `supabase/migrations/010_qualified_leads.sql` | `leads.is_qualified`, a stored generated column. The authority, and indexable |
| `api/stats.ts` (`classifyLead`) | Prefers the column, falls back to computing it. This is what makes the dashboard correct on a database where 010 has not been applied yet |
| `admin.html` (`qualified`) | Last line of defence, so an older API build cannot put a blank row back in the leads list |

**The booking form now requires a phone number.** The field existed but was optional, so most
submissions arrived without one and would not have qualified. `PHONE_RE` accepts anything
containing a digit: practices write numbers a dozen different ways, and rejecting an unusual
format loses a real buyer, which is a far worse failure than letting a typo through.

`npm run test:admin` drives the real dashboard against a stubbed API and pins all of it,
including the cases a plain null check misses — a whitespace-only phone, an email that is
present but malformed.

## Admin dashboard
`/admin.html` is a private traffic dashboard built to answer 24 specific business questions;
each panel is labelled with the ones it covers. Visitors and returning visitors, the funnel
in unique visitors, CTA impressions/clicks/CTR and downstream submits, section reach and exit
rate, video completion, scroll reach, traffic source through to leads, countries, devices,
referrers, errors and dead links, conversion path analysis, a visitor list with a full
journey drill-down, and the lead table with attribution.

### Theme and shadcn
`npx shadcn@latest mcp init --client claude` has been run; the server is configured in
`.mcp.json`. The dashboard has no build step and no React, so components are not installed from
the registry — the shadcn *system* is reproduced natively: the same token names, the full button
variant set (default / secondary / outline / ghost / destructive, plus icon and sm sizes), the
3px translucent focus ring shadcn uses rather than a hard outline, Skeleton, and empty states.

It now ships the `.dark` palette too, which it never had — opening the dashboard at night meant a
full-brightness cream page. The toggle sits in the top bar; unset follows the OS. The choice is
stamped on `<html>` by a tiny inline script in `<head>` so a dark-mode user never sees the cream
palette flash before the stylesheet loads.

Both palettes are contrast-tested. That caught three AA failures in the **light** theme that had
been there since the dashboard was written and had never been measured: the brand teal was
3.41:1 as the active sidebar label, 4.18:1 as a link, and 4.00:1 behind the white text on a
filled button. `--primary` and `--sidebar-primary` moved to `#0B6E66`, the same shade the public
site uses, and dark's `--destructive` was lifted for the same reason.

Note on the test: the tokens are `oklch()`, and Chromium serialises computed colours in the space
they were authored in. The audit paints each colour to a 1×1 canvas and reads the pixel back,
because reading `fillStyle` returns the `oklch()` string unchanged and a plain rgb regex silently
matches nothing — which is exactly what happened first time, reporting a clean pass over zero
nodes.

### Reading the dashboard
Every panel carries a grey caption under its title saying, in plain terms, what it measures and
what a good or bad number looks like. `test:admin` asserts that no panel ships without one, so
a new chart cannot arrive unexplained.

### Export
The **Export** button in the top bar produces the whole dashboard as Markdown, CSV or JSON, and
the chart alone as PNG. The Leads view has its own **Export leads** button for just the call
list.

The click log, the 12-month audit, the visitor list and the city/region breakdowns are loaded
lazily, only when their tab is opened. That meant an export taken straight after signing in
silently omitted all of them, and the file's contents depended on which tabs you happened to
have clicked — not something anyone would think to check. Every export now fetches whatever is
missing first. CSV and JSON contain exactly the same datasets under the same names.

Changing the date range clears all the lazy caches together, so an export cannot mix a 7-day
click log into a 90-day report.

- **Set `ADMIN_PASSWORD`** in Vercel → Settings → Environment Variables. Until it is set,
  `/api/stats` and `/api/admin-login` return 503 and the dashboard shows nothing. It never
  falls open.
- **Set `ADMIN_SESSION_SECRET`** to a long random value. It signs the session cookie and is
  deliberately separate from the password, because a signing key should be random and a
  password you type is not. Falls back to the password if unset.
- Bump `ADMIN_SESSION_VERSION` to sign every session out at once. `ADMIN_SESSION_HOURS`
  controls how long a login lasts (default 168 = 7 days).
- Login attempts are counted in Postgres, so the limit survives cold starts. The old
  in-memory limit reset on every new lambda instance.
- `/api/stats` aggregates server-side with the service-role key, so the browser never holds
  a database credential and raw event rows never leave the server.
- The page is `noindex`, `no-store`, disallowed in `robots.txt` and refuses to be framed —
  but that is tidiness. The password is the security.
- Needs migrations `005` and `006` applied, otherwise there is nothing to read.

## Voice demo (Vapi)
The in-browser demo call uses the official **`@vapi-ai/web` SDK, pinned to an exact version** in
the `<head>` of `index.html`.

> It previously loaded `cdn.jsdelivr.net/gh/VapiAI/html-script-tag@**latest**`. An unpinned
> dependency means every page load takes whatever upstream published last, so the call path can
> change with no deploy on our side — which is how working calls became
> `error-assistant-did-not-receive-customer-audio`. Change the pinned version deliberately, and
> test a real call afterwards. Never go back to a floating tag.

**Configuration.** `VAPI_PUBLIC_KEY` and `VAPI_ASSISTANT_ID` are class properties in `index.html`
(mirrored by `VITE_VAPI_PUBLIC_KEY` / `VITE_VAPI_ASSISTANT_ID` in `.env` for a bundled build).
The public web key is the *only* Vapi key that may appear client-side; a private/server key must
never be in the browser. The assistant id is validated as a UUID before any call: if it is
missing, a placeholder, or malformed, the page shows an error and **starts no call at all**,
rather than creating one with no assistant attached.

**Microphone.** Permission is requested explicitly before connecting, and the resulting track is
inspected (`readyState`, `enabled`, `muted`). `NotAllowedError`, `NotFoundError`,
`NotReadableError` and `OverconstrainedError` each get their own message, and a denial shows
browser-specific instructions with a Retry. Once live, `getLocalAudioLevel()` is sampled: eight
seconds of silence with nothing ever heard raises a "we can't hear you" hint, which is the
client-side view of the same failure Vapi reports as *did not receive customer audio*.

**Lifecycle.** One client per page, listeners attached once, so retries never duplicate handlers
or create a second call. `start()` returns a Promise and is handled as one — the old code called
it inside a `try/catch` and returned, so a rejection escaped and the UI hung on "Connecting…".
The call is only shown as connected when the SDK emits `call-start`; the microphone is released on
`call-end`, never during setup.

**Requirements.** Calls start from a click, never on load. Microphone access needs HTTPS (or
localhost). `vercel.json` sets `Permissions-Policy: … microphone=(self)`. If the page is ever
embedded, the parent iframe needs `allow="microphone; autoplay"`. There is no CSP on the site
today; if one is added it must permit the jsDelivr script and Daily's WebRTC endpoints
(`*.daily.co`, `wss:`), or calls will fail to connect.

**Diagnostics** are development-only — localhost, a Vercel preview, or `?debug=1`. They log
configuration state, device label, track state and call lifecycle. No transcripts, no audio, no
keys, no visitor identifiers.

**Tests.** `npm test` drives the real page in headless Chromium with the SDK and microphone
stubbed: missing assistant id, permission failures, duplicate clicks, listener reuse and cleanup.

## Videos and images (Supabase storage)
Both clips are served through `/api/video?clip=vsl|demo` and the portrait and console
captures through `/api/image?name=…`, so the page carries no expiring token.

Each route picks its target in this order:

1. The env var (`VIDEO_VSL_URL`, `VIDEO_DEMO_URL`, `IMAGE_PROFILE_URL`, …), if set.
2. **The bucket's public URL, if the bucket is public.** Probed with one `HEAD` per warm
   lambda rather than configured, so the day a bucket is flipped to public these routes
   start using never-expiring URLs on their own, with no env var and no redeploy.
3. The hardcoded signed URL, as a fallback. Those tokens expire **2027-07-24** (vsl),
   **2027-08-07** (demo) and **2027-08-10** (images).

### Buckets are public
Both `digi_dental-VSL` and `Images` were made public on 2026-08-15. That removes the token-expiry
class of bug entirely and turns on Supabase image transformations, so the `srcset` on the founder
photo and the console captures now serve genuinely smaller files rather than redirecting every
variant to the same original.

The signed URLs stay in the code as a third fallback. They cost nothing while unused and they are
what keeps the site up if a bucket is ever flipped back.

Three unused clips are still in `digi_dental-VSL` and are now publicly reachable by anyone who
guesses the URL: `Digi Dental.mp4`, `digi_dental.mp4` and `vid-testimonials.mp4`. They are
unlisted marketing footage, not sensitive, but they serve no purpose — delete them from
Storage → `digi_dental-VSL` when convenient. Supabase blocks deletion via SQL
(`storage.protect_delete()`), so it has to be the dashboard or the Storage API with a
service-role key.

### Video weight and region
The project lives in **ap-southeast-2 (Sydney)** and each clip is roughly **50 MB**. For a
US dental audience that is a long way to stream from, and it is the most likely cause of
the `net::ERR_CONNECTION_FAILED` entries in the PageSpeed run — a cross-Pacific range
request on a throttled mobile profile times out and the browser reports it as a connection
failure rather than a slow one.

Nothing here fixes that, because the fix is not a code change. In rough order of value:

1. **Transcode the clips.** ~50 MB is 5–10× larger than a marketing video needs to be.
   H.264 at a sane bitrate, or AV1, would cut it hard with no visible loss.
2. **Put video on a video host** — Cloudflare Stream, Mux or Bunny. Adaptive bitrate and
   global edge delivery, which is what a 50 MB hero clip actually wants.
3. **Move the Supabase project to a US region**, which helps the API calls too.

The players use `preload="metadata"`, so only the moov atom is fetched on page load — the
50 MB is not on the critical path either way.

## Dashboard preview section
The section between the FAQ and the final CTA shows four captures of the Vapi console the
practice owner works in. It sits there deliberately: objections have just been answered and the
price is known, so the last thing before the ask is evidence that a real system exists.

The interaction is the supplied React accordion — one panel open, the others collapsed to
labelled rails — **ported natively**. This site has no React build step, no Tailwind and no
`components/ui` directory; it is a single static HTML file driven by the `dc-runtime` in
`support.js`. Dropping in a `.tsx` component would require adding a bundler and restructuring the
deployment, so the behaviour was reproduced in the existing architecture instead. (To use the
component as written you would need `npx shadcn@latest init`, Tailwind and TypeScript, which
means converting this page into a React app — a much larger change than the section warrants.)

**On aspect ratios.** These are full-page captures whose dimensions are not known when the markup
is written, so nothing assumes one. Each frame takes its ratio from the image's own
`naturalWidth`/`naturalHeight` on load, and captures taller than roughly 1.2:1 scroll inside their
frame rather than stretching the page. Verified against both a 1:4 and a 2.4:1 image: rendered
height matches the natural ratio exactly, so nothing is cropped or letterboxed.

**Images** are served through `/api/image?name=…` for the same reason as the videos: the supplied
Supabase signed URLs expire **2027-08-10**. Set `IMAGE_*_URL` env vars, or make the bucket public,
and the expiry stops mattering. The founder portrait uses the same route.

## Before launch checklist
No `PLACEHOLDER` strings remain in rendered copy. What is still open, in priority order:

1. **Legal review.** The Privacy and Terms modals in `index.html`, the HIPAA FAQ answer and
   the contracts/data FAQ answer are final, honest copy that claims no certification — but
   they have not been read by a lawyer. Both modals carry a `LEGAL REVIEW REQUIRED` comment
   listing exactly what to check (subprocessors, jurisdiction sections, entity name and
   governing law, which are deliberately not invented).
2. **Commercial promises.** The split start is confirmed: $1,000 up front, the second $1,000
   due only if a real patient is booked within 14 days of go-live. It appears in the pricing
   section, the Terms modal, `llms.txt` and `api/site-info.ts` — change all four together.
   The go-live line is deliberately a speed claim with **no refund remedy**, because that
   promise was never confirmed; the comment above the badge in `index.html` has the exact
   wording to turn it into a real guarantee if you decide to stand behind one.
3. **Care-plan pricing.** $149/mo and $299/mo are carried over unverified from the previous
   copy. Confirm they are current before the next push; if they changed, update `index.html`,
   the JSON-LD offers, `llms.txt` and `api/site-info.ts`.
4. **Resend sender.** Verify a domain in Resend and set `RESEND_FROM`; until then leads send
   from `onboarding@resend.dev` and land in spam.
5. **Supabase publishable key.** The browser-fallback key in `index.html` is a new-style
   `sb_publishable_…` key, which really is that short. Confirm it with the curl in the comment
   above it: 401 means replace it, 403 means it is fine and RLS is working.
6. **Founder block.** Replace the monogram with a real photo and rewrite the two sentences in
   your own words. No testimonials, client counts or usage numbers until they are real.
7. **Statistics** were sourced June 2026 — refresh annually. Stat 4 is now labelled as our own
   arithmetic rather than an uncited external figure.

## Stat count-up
The four figures in `[data-section="cost"]` count up over 3.4s via `animateCount`.

**The count grows the string, not just the number.** `"0"` → `"8,000"` is four
characters wider, and the stat around it reads `$<count>–$10,000`. Measured, that
span's layout width went **23 → 69 → 101 → 103px** during a single run. On a phone
the line fits one row at the start of that swing and needs two by the end, so it
re-wrapped mid-count and the block jumped — worse on Android, where Chrome re-runs
font boosting whenever the layout changes.

The fix holds the box open with a hidden copy of the **final** string and paints the
running value over it, absolutely positioned so it contributes no width. Reserving
with the real final glyphs rather than a measured pixel value keeps it exact when
Fraunces finishes loading and the metrics change underneath, and it does not rely on
the font carrying tabular figures. Width is now a single value for the whole run.

Scoped to `max-width:900px`. Desktop columns are wide enough that the line never
re-wraps, and there the number growing outward from centre is the nicer read.

When measuring this, use `offsetWidth`, not `getBoundingClientRect()` — the stats sit
in a `data-reveal` block whose entrance transform inflates the visual rect and looks
exactly like layout drift.

## Performance and Core Web Vitals
The page renders client-side, so the critical path is
`HTML → support.js → React UMD from unpkg → first paint`. Left alone that is three
serial round trips before a single pixel of content.

**The fonts and preconnects were in the wrong place.** They lived in the `<helmet>`
block, which the runtime injects into `<head>` only *after* React has mounted. A
preconnect that fires after hydration has missed the entire window it exists to
optimise, and the Google Fonts stylesheet had not started downloading by the time
there was text to paint. Both are static `<head>` tags now. This was most of the 4s
mobile LCP.

Also in the static head, in order:

- `preconnect` to `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com` (three, under
  the four-origin rule of thumb).
- `preload as=script` for the two React UMD bundles, so they download **in parallel with
  `support.js`** instead of after it. Their `src`, `integrity` and `crossorigin` must stay
  byte-identical to `REACT_URL` / `REACT_SRI` / `REACT_DOM_URL` / `REACT_DOM_SRI` in
  `support.js` — if they drift the preload is a wasted download, and nothing warns you.
- A ~10-line critical CSS block (page background, colour, font stack) so the first frame
  is the right colour rather than a white flash.

`support.js` stays **synchronous**, deliberately. It kicks off the React fetch at parse
time and calls `hideRawTemplate()` immediately; `defer` would delay both and flash the raw
template.

### The voice SDK is no longer in the initial load
`@vapi-ai/web` pulls in `daily-js` — 67 KiB, ~58 KiB of it unused — on a page where most
visitors never press the demo button. It used to be an eager `import` in the helmet block.
It is now fetched on the first credible signal that a call is coming: the `#demo` section
entering the viewport (400px rootMargin) or `requestIdleCallback`, whichever lands first.
`startDemo()` awaits the same promise, so clicking before the warm-up finished waits for
the download rather than silently getting the simulated call.

### Caching
| Path | Policy | Note |
| --- | --- | --- |
| `/uploads/*` | `max-age=31536000, immutable` | **Rename a sprite to change it.** These URLs are not content-hashed, so an edit in place will not reach anyone who has already loaded the page |
| `/support.js` | `max-age=31536000, immutable` | Safe only because the URL carries `?v=<sha256 prefix>` |
| favicons | `max-age=2592000` | 30 days; browsers refetch these rarely anyway |
| `/`, `/index.html` | `max-age=0, s-maxage=3600` | Always revalidated, edge-cached |

`index.html` loads `./support.js?v=ae4f0ac844` — the first 10 hex of its sha256. That is
what makes the `immutable` header safe. Nothing recomputes it at request time, so it *can*
drift: **`test:seo` recomputes the hash and fails if it disagrees with the file on disk.**
After rebuilding `support.js`, run `npm test` and paste in the hash it reports.

### Responsive images
`profile.jpg` is a 1775×1775 original never displayed above 470 CSS px — PageSpeed put
~412 KiB of that down as pure waste. `/api/image` now accepts `?w=` and `?fmt=` and hands
off to Supabase's transformation endpoint, and the founder photo and the four console
captures carry `srcset`/`sizes`. **This only starts saving bytes once the `Images` bucket
is public** (transformations require it) — until then every variant redirects to the same
original, which costs nothing extra.

The existence probe for the founder photo carries the same `srcset` and `sizes` as the
element it is probing for, so the check and the render share one download instead of two.

### Known, not done
- **`support.js` is unminified** (~5.7 KiB of the reported saving). It is a generated
  bundle (`dc-runtime`) in a project with no build step, so a committed minified copy would
  drift from its source on the next regeneration. Brotli at the edge already recovers most
  of it. Revisit if a build step ever lands.
- ~~**Non-composited animation.**~~ Fixed — see below. The first pass through this audit
  dismissed it as a misread of `backdrop-filter`. That was wrong: the scroll reveal really was
  transitioning `filter` on 32 elements.

## Accessibility
Contrast is measured, not eyeballed. `test:render` walks every text node on the rendered
page, resolves the *effective* background by climbing ancestors and compositing alpha, and
asserts WCAG AA (4.5:1, or 3:1 for large text) at both desktop and mobile widths — 215 and
213 nodes respectively.

Reasoning about this from the stylesheet gets it wrong in both directions, which is why it
is a rendering test. What it caught:

| Was | Ratio | Now |
| --- | --- | --- |
| `#3D4F66` on navy (footer legal) | 2.09:1 | `#7C8CA6` |
| `#8A93A1` on cream / white (26 uses) | 2.95 / 3.10:1 | `#68717F` |
| `#5A6E86` on navy | 3.34:1 | `#8A9BB5` |
| `#0F8B80` teal as body text on light | 3.97:1 | `#0B6E66` |
| `#FAF9F6` on `#0F8B80` — **every primary CTA** | 3.97:1 | fill darkened to `#0B6E66`, hover to `#095B54` |
| `#0F8B80` teal as text on navy | 4.18:1 | `#3FBFA9` |

Links are underlined by default rather than on hover — colour alone was the only thing
marking "Privacy" or "Benny" as links (WCAG 1.4.1). Every CTA already declared
`text-decoration:none` inline and an inline style beats the rule, so the buttons stayed
clean without needing an exception list. Nav and icon-only links (`.dd-icon-link`) opt out:
neither sits inside a block of text, which is the case 1.4.1 is about. A test enforces it,
and deliberately does **not** accept font-weight as an affordance — weight is usually
inherited from the surrounding block rather than applied to the link, and counting it let
three of the five footnote citation markers pass while identical markup in a lighter
paragraph failed.

ARIA was already in good shape and is unchanged: `aria-expanded` + `aria-selected` on the
FAQ and dashboard panels, `role="dialog"` + `aria-modal` + focus handling on all four
modals, `role="alert"` / `role="status"` on the live regions.

### Fullscreen
`object-fit`, `width`, `aspect-ratio` and the card chrome are all overridden with `!important`
under `:fullscreen`. The important part is the `!important`: the players carry their layout as
**inline styles**, and an inline style beats any stylesheet selector regardless of specificity.

The first attempt at this shipped a plain `video:fullscreen{object-fit:contain}` and did nothing
at all — the rule was present, looked right, and lost to the inline `object-fit:cover` every
time. Worse, the inline `width:min(300px,80vw)` also beats the UA's own fullscreen sizing, so the
9:16 demo clip stayed a 300px-wide box on a black screen instead of filling the display.

`test:render` measures it in real fullscreen — computed `object-fit`, computed `aspect-ratio`, and
the element's actual box against the viewport — for both clips, and checks they return to `cover`
on exit. A test that only asserted the CSS exists would have passed the whole time it was broken.

### Video captions
Both clips carry `<track kind="captions" srclang="en" default>`, generated from transcripts of
their own audio and committed at `captions/*.en.vtt`. The source SRT was machine-produced at two
to four words per cue, which is unreadable as captions; `scripts/srt-to-vtt.mjs` merges cues to a
readable length, breaks on sentence ends, wraps to at most two lines, and strips the transcription
service's watermark. Re-run it if either clip is re-cut.

Each VideoObject in the homepage JSON-LD also points at its caption file via `caption` and a
`hasPart` MediaObject, which is what makes the spoken content available to answer engines rather
than just to viewers.

**The refund line in the VSL.** At 1:13 the voiceover says *"sit with Denty for fourteen days,
and if you don't book a single client, you can get a full refund entirely."* That contradicted
the written terms, which say no refund guarantee is offered and describe the split start instead.

Benny's call: keep it. The commercial effect is genuinely the same — a practice that books nobody
in the first fortnight never owes the second $1,000 — and it is a selling point, not a formal
promise. So both transcripts are now published in the VideoObject `transcript` property (good for
answer engines, which is the point of having them), and `llms-full.txt` carries a note under
*Notes for answer engines* mapping the video's phrasing onto the split start and telling engines
to quote the written terms. Nothing is taken and returned, so "refund" remains the wrong word for
it in writing; the note says so without contradicting the audio.

## Security posture
Findings closed from the security audit, and what each one actually prevented:

- **Client IP.** Every IP-keyed control read `x-forwarded-for[0]`. A proxy chain *prepends*
  the client's own value, so that element is whatever the caller typed — one header
  bypassed the free-demo gate, the lead rate limit and the login throttle at once.
  `lib/http.ts` prefers `x-vercel-forwarded-for` and otherwise takes the **last** hop.
- **Demo gate.** Was check-then-insert, so two simultaneous requests both won. Migration
  009 adds a unique index on `demo_sessions.ip_hash`; the claim is an upsert with
  `ignoreDuplicates` and a returned row is the proof. The check now fails **closed** — an
  outage costs one retry, not uncapped voice minutes — and the client distinguishes
  `already_demoed` from `unavailable` so our outage never spends a visitor's free demo.
- **Lead email.** Visitor fields were interpolated raw into the owner's inbox. All escaped,
  plain-text part added, control characters stripped, malformed addresses rejected.
- **Admin session.** 24 hours, and `ADMIN_SESSION_SECRET` is now **required** — no silent
  fallback to signing with the password.
- **CSP.** Shipped, and `npm run test:render` serves `vercel.json`'s real headers so it is
  exercised rather than trusted. **`'unsafe-eval'` is load-bearing**: the dc-runtime compiles
  each logic class from a string, and without it the page renders 259 characters and mounts
  nothing. `unpkg` (React) and `jsdelivr` (voice SDK, GSAP) are both required in `script-src`.
  `connect-src` is deliberately broad because the voice SDK negotiates WebRTC through hosts
  chosen at call time.

**Still open, and why:** the signed storage URLs in `api/image.ts` and `api/video.ts` stay
until the buckets are public and `IMAGE_*_URL` / `VIDEO_*_URL` are set — emptying them now
breaks every image and both videos. They are download-only and expire 2027-08-10;
`npm run test:security` pins them to those two files so the count can only go down.

## Conversion changes
From the marketing audit. Every one is placement or framing — no commercial term moved.

- The **split start** now leads the hero trust line. It was the strongest argument on the
  page and lived in pricing, where anyone who bounced early never saw it.
- The **live demo** is a real secondary button, not an underlined line of text.
- One CTA name everywhere: "Claim your practice audit slot" is gone.
- **Year-one cost** as a `<details>` in the pricing card, because owners annualise whatever
  they are shown and a guess is always worse than the arithmetic.
- The three objections that stop a decision — HIPAA, PMS, go-live — render inline under the
  demo and the pricing card, from the **same `faqData`** as the FAQ section, so an answer
  cannot say two different things in two places.
- The founder card sells **accountability**, not endorsement. There is a
  `SOCIAL PROOF SLOT` for real customer quotes: populate `SOCIAL_PROOF` and the section
  renders itself, tracked as `data-section="social_proof"`. **Leave it empty until a real
  practice agrees to be quoted** — the page's credibility rests on sourced numbers and a
  live demo, and one invented quote undoes both.
