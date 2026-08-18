# SEO / AEO launch checklist

Everything here needs a human with logins. The code side is done and test-pinned; this is the
half no script can do. Work top to bottom — the order is by impact, not effort.

Domain: **https://www.digidental.us** (apex `digidental.us` 308-redirects to it).

---

## 1. Google Search Console — the single highest-value action

Nothing else matters until Google knows the site exists.

1. https://search.google.com/search-console → **Add property** → choose **Domain**, not URL
   prefix → enter `digidental.us`.
2. Google shows one `TXT` record. Namecheap → Domain List → digidental.us → **Advanced DNS** →
   Add New Record: type `TXT Record`, host `@`, value the `google-site-verification=…` string,
   TTL Automatic.
   **Do not remove the existing SPF record.** A domain may hold many TXT records but only one
   beginning `v=spf1`; deleting it breaks email authentication.
3. Wait for propagation, press **Verify**.
4. **Sitemaps** → submit `sitemap.xml`.
5. **URL Inspection** → paste `https://www.digidental.us/` → **Request Indexing**.
6. Record today's impressions (they will be zero). That zero is the baseline the week is
   measured against — without it there is no way to tell whether anything worked.

A Domain property covers the apex, `www`, `http`, `https` and every future subdomain in one
record, and survives any change to the HTML.

---

## 1b. Both pages, not just the homepage

The site is two indexable documents now. Everywhere below that says "the site", check both:

| URL | Targets |
| --- | --- |
| `https://www.digidental.us/` | brand + category ("AI receptionist for dental practices") |
| `https://www.digidental.us/how-it-works/` | research intent — how it works, what it costs, HIPAA, Dentrix/Eaglesoft/Open Dental, after-hours |

In GSC, request indexing for **both** URLs, and watch that they do not start trading places on
the same query: if `/how-it-works/` ever outranks `/` for the bare brand term, the two titles
have drifted too close together and the homepage title is the one to fix.

## 2. Bing Webmaster Tools — feeds Copilot and ChatGPT search

1. https://www.bing.com/webmasters → add `https://www.digidental.us`.
2. Easiest path: **Import from Google Search Console** once step 1 is done.
   Otherwise choose the meta-tag method, and paste the code into the hook already waiting in
   `index.html` — search for `msvalidate.01`, replace `PASTE_YOUR_BING_CODE_HERE`, and
   **uncomment the tag**. It ships commented on purpose: a meta tag with an empty `content`
   is a verification attempt that fails, and Bing reports the site as unverified without
   explaining why.
3. Submit `sitemap.xml`. It now lists **two** URLs — `/` and `/how-it-works/` — so confirm both
   are picked up rather than assuming a green tick means the whole site.
4. Run `npm run seo:submit`. That pushes the URL list to IndexNow, which Bing, Copilot, Yandex,
   Seznam and Naver all consume. Expect `HTTP 200` or `202`.
   - `403` means the key file is unreachable — check `https://www.digidental.us/ff9001e018464afabaaf0dbf8c193fa5.txt`
     returns the key and nothing else.
   - There is no Google equivalent. Google retired its sitemap ping in 2023 and never adopted
     IndexNow; step 1.5 above is the manual substitute.

---

## 3. Validate what the crawlers will actually see

- **Rich Results Test** — https://search.google.com/test/rich-results?url=https://www.digidental.us/
  Expect FAQ, Video, Organization and Service to all come back valid. Thirteen FAQ entries.
- **Schema Markup Validator** — https://validator.schema.org/ — paste the URL and confirm the
  nine-node graph resolves with no unreferenced ids.
- **PageSpeed Insights** — https://pagespeed.web.dev/analysis?url=https://www.digidental.us/
  Record LCP, CLS and INP. Measured CLS in a controlled browser is 0.0005; if the field data
  is materially worse, the likely causes are the voice SDK and the Google Fonts request, in
  that order.
- **Rendered vs. raw** — in Chrome, view-source and search for `Is this HIPAA-compliant`. It
  must be present in the raw HTML, not just after JavaScript runs. That is what GPTBot and
  ClaudeBot read, and it is test-pinned, but worth eyeballing once against production.

---

## 4. Claim the brand

The brand SERP for "digi dental" is currently fragmented across unrelated labs and apps. It is
winnable precisely because nothing is entrenched there.

- **Google Business Profile** — https://business.google.com. Category **Software company** or
  **Business service**, *not* anything dental: this is a vendor to practices, not a practice.
  Set it up as a service-area business listing the Arizona metros. Link the website.
- **LinkedIn** — post once from the founder profile linking `https://www.digidental.us/` and
  `https://www.digidental.us/how-it-works/#demo`. The profile is already in the site's `sameAs`,
  so the link back completes the entity association in both directions.
- **Medium** — the case study at
  `https://medium.com/@bennyco/the-real-cost-of-a-missed-call-at-your-dental-practice-and-why-voicemail-isnt-fixing-it-5ae0fdf3ac39`
  is the site's only off-domain document. Two things make it count: the article body should
  link back to `https://www.digidental.us/` and `https://www.digidental.us/how-it-works/`
  (the site already links out to it, and a citation that only runs one way is half a signal),
  and the Medium profile's website field should point at the canonical `www.` URL. The
  founder's `sameAs` already lists `https://medium.com/@bennyco`.
- **Facebook page** — same, and confirm the page's website field points at the canonical
  `www.` URL rather than the apex.
- **Directories** worth the time: Product Hunt, Capterra / G2 (dental practice-management
  category), Opencare vendor listings, and any AI-tool directory that accepts a manual
  submission. Each is a crawl-discovery trigger before it is ever a ranking signal.

---

## 5. After any content change

Re-request indexing in GSC and re-run `npm run seo:submit`. Crawls are cheap, and a refreshed
index entry is what makes today's edits visible to answer engines this week rather than next
month.

---

## What to expect, honestly

| Goal | Realistic timeline |
|---|---|
| Indexed at all; brand SERP for "digi dental" | days, once step 1 is done |
| Cited by ChatGPT / Perplexity / AI Overviews | days to two weeks — the AI surfaces are the strongest part of this site |
| Local long-tails ("dental AI answering service chandler az") | 2–6 weeks |
| Outranking Weave / Smith.ai for generic head terms | months, and not by on-page work — that is a domain-authority fight |

The week-one win is **indexing plus brand consolidation plus AI citations**. Anyone promising
head-term rankings in a week is selling something.
