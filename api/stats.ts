// /api/stats — Vercel serverless function
// Everything behind the dashboard at /admin.html.
//
// This used to pull up to 50,000 raw rows with select('*') into the lambda and aggregate them
// in JavaScript on every load. It now calls SECURITY DEFINER functions that do the work next to
// the data and return finished numbers, so the payload is a few kilobytes regardless of how
// many events exist. See supabase/migrations/006_analytics_functions.sql.
//
// Views, selected with ?view=:
//   (default)  the whole dashboard in one round trip
//   visitors   the visitor list for the drill-down
//   journey    one visitor's full event timeline  (&vid=)
//   paths      conversion path analysis
//   breakdown  country / device / city / referrer  (&dim=)
//
// The browser never holds a database credential and raw event rows never leave the server.
// Requires the admin cookie set by /api/admin-login.
import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

// The cookie is signed with a secret that is deliberately NOT the password: a signing key
// should be long and random, and a password is neither. ADMIN_SESSION_SECRET is preferred;
// ADMIN_PASSWORD remains the fallback so an existing deployment keeps working after this
// change rather than logging everyone out on deploy.
const signingSecret = () => process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '';

// Bumping ADMIN_SESSION_VERSION invalidates every issued cookie at once, which is what you
// want if a laptop goes missing. It is part of the signed payload, so it cannot be edited
// client-side.
const sessionVersion = () => process.env.ADMIN_SESSION_VERSION || '1';

export function verifyAdminCookie(cookieHeader: string): boolean {
  const secret = signingSecret();
  if (!secret) return false; // never open when unconfigured
  const raw = /(?:^|;\s*)dd_admin=([^;]+)/.exec(cookieHeader || '');
  if (!raw) return false;
  const parts = decodeURIComponent(raw[1]).split('.');
  if (parts.length !== 3) return false;
  const [ver, expStr, sig] = parts;
  if (ver !== sessionVersion()) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(ver + '.' + expStr).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const intParam = (v: unknown, def: number, min: number, max: number) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// Every RPC is called the same way, and a failure in one panel must not blank the whole
// dashboard — an empty section with a logged reason beats a 500 page.
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`[stats] ${name} failed:`, error.message);
    return { data: null, error: error.message };
  }
  return { data, error: null };
}

export default async function handler(req: any, res: any) {
  try {
    if (!signingSecret()) {
      return res.status(503).json({ error: 'Dashboard is not configured. Set ADMIN_PASSWORD in the hosting dashboard.' });
    }
    if (!verifyAdminCookie(String(req.headers.cookie || ''))) {
      return res.status(401).json({ error: 'Not signed in.' });
    }

    const q = req.query || {};
    const days = intParam(q.days, 30, 1, 365);
    const view = String(q.view || 'dashboard');

    // ---- Drill-down views, each a single cheap call ----
    if (view === 'journey') {
      const vid = String(q.vid || '').slice(0, 64);
      if (!vid) return res.status(400).json({ error: 'A visitor id is required.' });
      const { data, error } = await rpc('rpc_visitor_journey', { vid, lim: 500 });
      return res.status(200).json({ visitor_id: vid, events: data || [], error });
    }
    if (view === 'visitors') {
      const { data, error } = await rpc('rpc_visitors', { days, lim: intParam(q.limit, 100, 1, 500) });
      return res.status(200).json({ range_days: days, visitors: data || [], error });
    }
    if (view === 'paths') {
      const { data, error } = await rpc('rpc_conversion_paths', { days });
      return res.status(200).json({ range_days: days, paths: data || [], error });
    }
    if (view === 'pipeline') {
      const { data, error } = await rpc('rpc_pipeline', { days, lim: 300 });
      return res.status(200).json({ range_days: days, cards: data || [], error });
    }
    if (view === 'clicks') {
      const { data, error } = await rpc('rpc_clicks', { days, lim: intParam(q.limit, 40, 1, 200) });
      return res.status(200).json({ range_days: days, clicks: data || [], error });
    }
    if (view === 'breakdown') {
      const dim = ['country', 'device', 'city', 'referrer', 'region'].includes(String(q.dim)) ? String(q.dim) : 'country';
      const { data, error } = await rpc('rpc_breakdown', { days, dim });
      return res.status(200).json({ range_days: days, dim, rows: data || [], error });
    }

    // ---- The dashboard itself: one round trip, all panels in parallel ----
    const [
      overview, funnel, daily, cta, sections, video, scroll,
      sources, countries, devices, referrers, errors, paths, leads,
      contact, clickTotals, clicks, pipeline
    ] = await Promise.all([
      rpc('rpc_overview', { days }),
      rpc('rpc_funnel', { days }),
      rpc('rpc_daily', { days }),
      rpc('rpc_cta_matrix', { days }),
      rpc('rpc_sections', { days }),
      rpc('rpc_video', { days }),
      rpc('rpc_scroll', { days }),
      rpc('rpc_sources', { days }),
      rpc('rpc_breakdown', { days, dim: 'country' }),
      rpc('rpc_breakdown', { days, dim: 'device' }),
      rpc('rpc_breakdown', { days, dim: 'referrer' }),
      rpc('rpc_errors', { days }),
      rpc('rpc_conversion_paths', { days }),
      rpc('rpc_leads', { days, lim: 100 }),
      rpc('rpc_contact', { days }),
      rpc('rpc_click_totals', { days }),
      rpc('rpc_clicks', { days, lim: 40 }),
      rpc('rpc_pipeline', { days, lim: 300 })
    ]);

    // If the very first call failed the schema is probably not there yet, which is worth
    // saying plainly rather than rendering a dashboard full of zeroes.
    // Truncating this list to three used to hide the fourth failure, which made it look like
    // one migration was partly applied when in fact a whole file had not run. Report the
    // distinct causes and say how many panels each affected.
    const failures = [overview, funnel, daily, cta, sections, video, scroll, sources, countries, devices, referrers, errors, paths, leads, contact, clickTotals, clicks, pipeline]
      .map(r => r.error).filter(Boolean) as string[];
    const distinctFailures = Array.from(new Set(failures));

    return res.status(200).json({
      range_days: days,
      generated_at: new Date().toISOString(),
      degraded: distinctFailures.length > 0 ? distinctFailures : null,
      degraded_count: failures.length || undefined,
      overview: overview.data || {},
      funnel: funnel.data || [],
      daily: daily.data || [],
      cta: cta.data || [],
      sections: sections.data || [],
      video: video.data || [],
      scroll: scroll.data || [],
      sources: sources.data || [],
      countries: countries.data || [],
      devices: devices.data || [],
      referrers: referrers.data || [],
      errors: errors.data || [],
      paths: paths.data || [],
      leads: leads.data || [],
      contact: contact.data || [],
      click_totals: clickTotals.data || {},
      clicks: clicks.data || [],
      pipeline: pipeline.data || []
    });
  } catch (e: any) {
    console.error('[stats] handler threw:', e && e.message);
    return res.status(500).json({ error: 'Could not build the report.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
