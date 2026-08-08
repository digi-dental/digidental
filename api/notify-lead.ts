// /api/notify-lead — Vercel serverless function
// Receives lead/form/demo events, inserts into Supabase, emails the owner via Resend.
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { createHash } from 'node:crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);
const resend = new Resend(process.env.RESEND_API_KEY!); // SECURITY: server-side only — set RESEND_API_KEY in .env / the hosting dashboard, never hardcode

// BUG-6: onboarding@resend.dev lands in spam and doesn't read as Digi Dental. Verify a domain
// in Resend (Domains → Add domain → DNS records) and set RESEND_FROM in the Vercel dashboard,
// e.g. RESEND_FROM="Digi Dental <noreply@digidental.com>". Until that's done the Resend default
// is kept so leads still arrive — it is a fallback, not the intended sender.
const FROM = process.env.RESEND_FROM || 'Digi Dental <onboarding@resend.dev>';

// BUG-7: this endpoint used to accept unlimited anonymous POSTs — free inbox spam and a Resend
// send per request. Three cheap layers, none of which can lock out a real lead:
//   1. honeypot field the form fills only if a bot fills it
//   2. per-IP rate limit (per warm instance — enough to stop a casual flood)
//   3. optional shared secret, enforced only when SITE_TOKEN is set on the server
const RATE_MAX = 6;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, number[]>();

function rateLimited(key: string) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // crude ceiling: this is a lambda, not a database
  return recent.length > RATE_MAX;
}

const str = (v: unknown, max = 200) => (v == null ? null : String(v).slice(0, max));

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(200).json({ ok: false }); } }
    const { name, practice_name, email, phone, country, monthly_call_volume, locations, source,
            website, vid, sid, utm, ref } = body || {};
    if (!['form', 'demo_call', 'exit_intent'].includes(source)) return res.status(200).json({ ok: false });

    // Honeypot: humans never see this field, so anything in it is a bot. Recorded, never emailed.
    if (website) {
      const { error } = await supabase.from('leads').insert({ name: str(name), practice_name: str(practice_name), email: str(email), source, is_bot: true });
      if (error) console.error('[notify-lead] bot insert failed:', error.message);
      return res.status(200).json({ ok: true }); // look identical to success so bots don't learn
    }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = createHash('sha256').update(ip + (process.env.IP_HASH_SALT || '')).digest('hex');
    if (rateLimited(ipHash)) return res.status(429).json({ ok: false });

    const expected = process.env.SITE_TOKEN;
    if (expected && req.headers['x-dd-site'] !== expected) return res.status(200).json({ ok: false });

    // Attribution travels with the lead so the dashboard can answer "which campaign produced
    // this booking". Nullable and best-effort by design: a visitor who blocks storage still
    // becomes a lead, just an unattributed one. Losing attribution is acceptable; losing a
    // lead is not.
    const u = (utm && typeof utm === 'object') ? utm : {};
    let referrerHost: string | null = null;
    if (ref) { try { referrerHost = new URL(String(ref)).hostname.replace(/^www\./, '').slice(0, 120); } catch { referrerHost = null; } }

    // The columns every version of this table has had. Attribution is added on top.
    const core = {
      name: str(name), practice_name: str(practice_name), email: str(email, 320), phone: str(phone, 40),
      country: str(country, 80), monthly_call_volume: str(monthly_call_volume, 40),
      locations: str(locations, 20), source
    };

    // The insert error is now read rather than discarded. Ignoring it is exactly how every lead
    // was silently lost while this endpoint kept reporting success and sending email.
    //
    // If the attribution columns do not exist yet, the code has deployed ahead of migration 005.
    // Rather than lose the lead over it, fall back to the core columns and log the gap. A lead
    // without attribution is a minor loss; a lead that never lands is the bug we just fixed.
    const { error: insertError } = await supabase.from('leads').insert({
      ...core,
      visitor_id: str(vid, 64), session_id: str(sid, 64),
      utm_source: str(u.source, 80), utm_medium: str(u.medium, 80), utm_campaign: str(u.campaign, 120),
      referrer_host: referrerHost
    });
    if (insertError) {
      console.error('[notify-lead] attributed insert failed, retrying without attribution:', insertError.message);
      const { error: retryError } = await supabase.from('leads').insert(core);
      if (retryError) console.error('[notify-lead] lead insert FAILED, lead not saved:', retryError.message, '| source:', source);
      else console.warn('[notify-lead] lead saved WITHOUT attribution — apply migration 005_analytics_core.sql');
    }

    // Mark the conversion on the analytics timeline too, so a lead appears in the visitor's
    // journey and in conversion path analysis. Never allowed to block the email.
    if (vid || sid) {
      const { error: evError } = await supabase.from('site_events').insert({
        event: 'lead_captured', category: 'CONVERSION',
        props: { source, qualified: ['200–500', '500–1,000', '1,000+'].includes(monthly_call_volume) },
        visitor_id: str(vid, 64), session_id: str(sid, 64),
        utm_source: str(u.source, 80), utm_medium: str(u.medium, 80), utm_campaign: str(u.campaign, 120),
        referrer_host: referrerHost, path: '/'
      });
      if (evError) console.error('[notify-lead] lead_captured event failed:', evError.message);
    }

    // An exit-intent event with no contact details is a signal, not a lead — it belongs in the
    // table, but it must not put an empty email in the owner's inbox on every desktop visit.
    const contactable = !!(email || phone);
    if (source === 'exit_intent' && !contactable) return res.status(200).json({ ok: true });

    const qualified = ['200–500', '500–1,000', '1,000+'].includes(monthly_call_volume) || parseInt(locations, 10) > 1;
    const leadSummaryHtml = `
      <h2>Digi Dental — new ${source === 'demo_call' ? 'demo call' : 'lead'}</h2>
      <p><strong>Name:</strong> ${str(name) || '—'}<br>
      <strong>Practice:</strong> ${str(practice_name) || '—'}<br>
      <strong>Email:</strong> ${str(email, 320) || '—'} &nbsp; <strong>Phone:</strong> ${str(phone, 40) || '—'}<br>
      <strong>Country:</strong> ${str(country, 80) || '—'} &nbsp; <strong>Calls/mo:</strong> ${str(monthly_call_volume, 40) || '—'} &nbsp; <strong>Locations:</strong> ${str(locations, 20) || '—'}<br>
      <strong>Source:</strong> ${source} &nbsp; <strong>At:</strong> ${new Date().toISOString()}<br>
      <strong>Qualification:</strong> ${qualified ? 'Fit (volume or multi-location)' : 'Smaller practice'}</p>
      ${source === 'demo_call' ? '<p>They just finished a live demo call on the site — call them back today.</p>' : ''}`;

    await resend.emails.send({
      from: FROM,
      to: process.env.NOTIFY_EMAIL_TO || 'bennysworkspace@gmail.com',
      subject: source === 'demo_call' ? 'Digi Dental: demo call completed' : `New Digi Dental lead: ${practice_name || name || 'unnamed'} (${monthly_call_volume || '?'} calls/mo)`,
      html: leadSummaryHtml,
    });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: false }); // graceful — client never surfaces a raw error
  }
}
