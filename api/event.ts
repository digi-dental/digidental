// /api/event — Vercel serverless function
// First-party funnel analytics. One row per event in `site_events`; no third party involved.
//
// Accepts sendBeacon (Content-Type may be text/plain) as well as ordinary JSON fetches.
//
// Two things this endpoint learned the hard way (see the analytics audit):
//   1. It writes to a table that has to exist. For months it did not, and because the insert
//      result was thrown away, every single event was lost while the endpoint kept answering
//      204. Failures are now logged server-side so they surface in the runtime logs.
//   2. Analytics must never break the page, so the *response* is still always a success. Those
//      are different things: the visitor sees nothing, the operator sees everything.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

// The event taxonomy, as four classes. The category is stored alongside the event so the
// dashboard can ask for a whole class of behaviour without matching on names, and so a new
// event added later cannot silently land outside every filter.
//
// BEHAVIOR   — what they did on the page, no intent implied
// INTENT     — a deliberate step towards buying
// CONVERSION — the outcomes worth counting
// TECHNICAL  — something went wrong, or a dead end was hit
const CATEGORY: Record<string, string> = {
  // BEHAVIOR
  page_view: 'BEHAVIOR', view_hero: 'BEHAVIOR', section_view: 'BEHAVIOR',
  scroll_depth: 'BEHAVIOR', section_time: 'BEHAVIOR', video_play: 'BEHAVIOR',
  video_progress: 'BEHAVIOR', video_watch: 'BEHAVIOR', calc_interact: 'BEHAVIOR',
  session_end: 'BEHAVIOR',
  // Every link and button click on the page, captured by one delegated listener so a control
  // added later is measured without anyone remembering to instrument it. This is what makes
  // "how many clicks happened" answerable rather than "how many clicks we thought to count".
  element_click: 'BEHAVIOR',
  // INTENT
  cta_impression: 'INTENT', cta_click: 'INTENT', form_open: 'INTENT',
  form_step_1: 'INTENT', form_step_2: 'INTENT', form_step_3: 'INTENT',
  form_step_4: 'INTENT', form_step_5: 'INTENT', demo_start: 'INTENT',
  exit_intent_shown: 'INTENT', exit_intent_demo: 'INTENT',
  // CONVERSION
  demo_complete: 'CONVERSION', form_submit: 'CONVERSION', calendly_click: 'CONVERSION',
  lead_captured: 'CONVERSION',
  // Reaching for a real contact channel — WhatsApp, email or phone. Counted separately from
  // element_click because these are outcomes, not interactions, and they are the answer to
  // "how many people actually messaged or emailed me".
  contact_click: 'CONVERSION',
  // TECHNICAL
  demo_error: 'TECHNICAL', demo_blocked: 'TECHNICAL', form_error: 'TECHNICAL',
  page_not_found: 'TECHNICAL'
};

// The allowlist is simply the taxonomy's keys, so adding an event in one place is enough and
// the two can never drift apart. Anything unrecognised is dropped, which keeps a stray script
// or a bored visitor with a console from filling the table with junk.
const ALLOWED = new Set(Object.keys(CATEGORY));

const MAX_BODY = 4000; // bytes — an event this big is not one of ours

const clean = (v: unknown, max: number) => {
  const s = v == null ? '' : String(v).slice(0, max).trim();
  return s || null;
};

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    let body = req.body;
    if (typeof body === 'string') {
      if (body.length > MAX_BODY) return res.status(200).json({ ok: false });
      try { body = JSON.parse(body); } catch { return res.status(200).json({ ok: false }); }
    }
    const { event, props, sid, vid, path, ref, utm } = body || {};
    if (!event || !ALLOWED.has(String(event))) return res.status(200).json({ ok: false });

    // Same one-way hash as the demo gate: enough to rate-limit and spot abuse, never enough to
    // identify anyone. Raw IPs are never stored. Note this is no longer used as visitor
    // identity — visitor_id is, because IPs both rotate and are shared.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = createHash('sha256').update(ip + (process.env.IP_HASH_SALT || '')).digest('hex');

    // Geography comes free from Vercel's edge headers, so no IP lookup and no third party.
    // These are coarse (country/region/city), and the IP itself is still never stored.
    const country = String(req.headers['x-vercel-ip-country'] || '').slice(0, 2).toUpperCase() || null;
    const region = clean(req.headers['x-vercel-ip-country-region'], 8);
    const city = (() => { try { return clean(decodeURIComponent(String(req.headers['x-vercel-ip-city'] || '')), 80); } catch { return null; } })();
    const ua = String(req.headers['user-agent'] || '');
    const device = /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : (/iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop');

    // Referrer host is stored separately so the dashboard never has to parse a URL, and the
    // full referrer is kept for anything the host alone cannot answer.
    const referrer = clean(ref, 300);
    let referrerHost: string | null = null;
    if (referrer) { try { referrerHost = new URL(referrer).hostname.replace(/^www\./, '').slice(0, 120); } catch { referrerHost = null; } }

    // Campaign tags arrive already parsed from the page so a raw query string never has to be
    // unpicked in SQL later.
    const u = (utm && typeof utm === 'object') ? utm : {};

    const { error } = await supabase.from('site_events').insert({
      event: String(event).slice(0, 64),
      category: CATEGORY[String(event)] || 'BEHAVIOR',
      props: props && typeof props === 'object' ? props : {},
      visitor_id: clean(vid, 64),
      session_id: clean(sid, 64),
      ip_hash: ipHash,
      path: clean(path, 200) || '/',
      referrer,
      referrer_host: referrerHost,
      utm_source: clean(u.source, 80),
      utm_medium: clean(u.medium, 80),
      utm_campaign: clean(u.campaign, 120),
      country, region, city, device
    });

    // Loud on the server, silent to the visitor. This is the line whose absence hid a total
    // analytics outage: supabase-js returns errors rather than throwing, so without reading
    // `error` a failed insert is indistinguishable from a successful one.
    if (error) console.error('[event] insert failed:', error.message, '| event:', String(event));

    return res.status(204).end(); // nothing for the page to do with a response
  } catch (e: any) {
    console.error('[event] handler threw:', e && e.message);
    return res.status(200).json({ ok: false }); // analytics must never surface an error
  }
}
