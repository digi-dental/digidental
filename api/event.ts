// /api/event — Vercel serverless function
// First-party funnel analytics (BUG-12). One row per event in `site_events`; no cookies, no
// personal data, no third party required. Plausible/GA4 mirror the same events client-side
// when they're present, but this endpoint is what makes day-one measurement possible.
//
// Accepts sendBeacon (Content-Type may be text/plain) as well as ordinary JSON fetches.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

// Only events the page is supposed to send. Anything else is dropped, so a stray script or a
// bored visitor with a console can't fill the table with junk event names.
const ALLOWED = new Set([
  'view_hero', 'cta_click', 'demo_start', 'demo_complete', 'demo_error', 'demo_blocked',
  'calc_interact', 'form_open', 'form_step_1', 'form_step_2', 'form_step_3', 'form_step_4',
  'form_step_5', 'form_submit', 'form_error', 'calendly_click', 'exit_intent_shown',
  'exit_intent_demo', 'video_play'
]);

const MAX_BODY = 4000; // bytes — an event this big is not one of ours

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    let body = req.body;
    if (typeof body === 'string') {
      if (body.length > MAX_BODY) return res.status(200).json({ ok: false });
      try { body = JSON.parse(body); } catch { return res.status(200).json({ ok: false }); }
    }
    const { event, props, sid, path, ref } = body || {};
    if (!event || !ALLOWED.has(String(event))) return res.status(200).json({ ok: false });

    // Same one-way hash as the demo gate: enough to count unique visitors and rate-limit,
    // never enough to identify one. Raw IPs are never stored.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = createHash('sha256').update(ip + (process.env.IP_HASH_SALT || '')).digest('hex');

    await supabase.from('site_events').insert({
      event: String(event).slice(0, 64),
      props: props && typeof props === 'object' ? props : {},
      session_id: String(sid || '').slice(0, 64),
      path: String(path || '/').slice(0, 200),
      referrer: String(ref || '').slice(0, 300),
      ip_hash: ipHash
    });
    return res.status(204).end(); // nothing for the page to do with a response
  } catch {
    return res.status(200).json({ ok: false }); // analytics must never surface an error
  }
}
