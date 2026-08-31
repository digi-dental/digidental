# Prospecting

ICP-scored lead generation for Digi Dental outreach.

## Files

| File | What it is |
|---|---|
| `icp-model.json` | The scoring rubric — six weighted criteria, hard disqualifiers, qualifying band |
| `scrape-icp.mjs` | Playwright crawler that pulls ICP signals off practice websites |
| `leads/` | Scored lead lists, one file per run |

## The model

Six criteria, 100 points. A practice qualifies for outreach at **75+**.

| Criterion | Weight | What earns it |
|---|---|---|
| Independent owner-operator | 20 | Not a DSO. One decision-maker, no procurement committee. |
| 2-4 dentists | 15 | Solo lacks call volume; 5+ drifts toward DSO buying behaviour. |
| High-ticket elective | 20 | Sedation, implants/All-on-4, Invisalign. A missed call is a $3-5k case. |
| Active new-patient marketing | 15 | $ exam offers, free consults, landing pages, call-tracking numbers. |
| Documented phone gap | 20 | No Saturday/evening, weekday closures, voicemail after close, one line for 2+ sites. |
| Recent growth trigger | 10 | New location, new associate, ownership change, added sedation/implant line. |

**Hard disqualifiers** (score irrelevant): DSO or corporate-managed; under ~200 inbound calls/month;
requires named PMS integration, BAA/HIPAA certification or multilingual support as a precondition.

## Running the scraper

```bash
export NODE_PATH=/opt/node22/lib/node_modules   # or npm i playwright locally
node prospecting/scrape-icp.mjs sites.json out.json
```

`sites.json` is `[{ "name": "...", "url": "https://...", "city": "..." }]`. The crawler loads each
homepage, discovers team / offers / contact / services subpages from the nav, and extracts phone
numbers, dentist names, service keywords, promo pricing and hours into a per-practice signal record.

It honours `HTTPS_PROXY` when set. Note that in restricted-egress environments the proxy may refuse
CONNECT to third-party domains (403), in which case the crawler cannot reach practice sites and
research has to fall back to search-indexed content.
