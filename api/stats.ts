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
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { clientIp } from '../lib/http';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

// The cookie is signed with a secret that is deliberately NOT the password: a signing key
// should be long and random, and a password is neither. ADMIN_SESSION_SECRET is preferred;
// ADMIN_PASSWORD remains the fallback so an existing deployment keeps working after this
// change rather than logging everyone out on deploy.
// Must match admin-login: ADMIN_SESSION_SECRET only, never the password.
const signingSecret = () => process.env.ADMIN_SESSION_SECRET || '';

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

// ---------------------------------------------------------------------------
// What counts as a lead
// ---------------------------------------------------------------------------
// The `leads` table takes three sources and only one of them carries contact details. A
// completed demo call or a dismissed exit-intent popup inserts a row with name, email and
// phone all null — the visitor never typed anything. Those are real intent signals worth
// keeping, but they are not leads: there is nobody to ring. They were being counted in the
// headline and listed as blank rows in the dashboard's Leads table.
//
// A lead is a row you could actually pick up the phone and call.
//
// This is computed here as well as in the database (migration 010 adds a generated column) so
// the dashboard is correct on a deployment where that migration has not been applied yet. The
// database column wins when present; this is the fallback, and the two definitions must agree.
const LOOSE_EMAIL = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

function classifyLead(row: any) {
  const has_name = filled(row?.name);
  const has_email = filled(row?.email);
  const has_phone = filled(row?.phone);
  // Prefer the generated column when migration 010 has run: it is the authority, and it also
  // accounts for is_bot, which rpc_leads already filters out but which may reappear if the
  // query changes.
  const is_qualified = typeof row?.is_qualified === 'boolean'
    ? row.is_qualified
    : (has_name && has_phone && has_email && LOOSE_EMAIL.test(String(row.email).trim()));
  return { ...row, has_name, has_email, has_phone, is_qualified };
}

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

// Cookie-gated, so this is a second line rather than the first: a leaked or stolen session
// cookie should not also come with unlimited query volume against every analytics RPC. Same
// hashed-IP key as the rest of the site, same in-memory ceiling — this is a lambda, not a
// database, and a warm instance covering the common case is enough.
const STATS_MAX = 120;
const STATS_WINDOW_MS = 5 * 60 * 1000;
const statsHits = new Map<string, number[]>();
function statsRateLimited(key: string) {
  const now = Date.now();
  const recent = (statsHits.get(key) || []).filter(t => now - t < STATS_WINDOW_MS);
  recent.push(now);
  statsHits.set(key, recent);
  if (statsHits.size > 5000) statsHits.clear();
  return recent.length > STATS_MAX;
}

export default async function handler(req: any, res: any) {
  try {
    if (!signingSecret()) {
      return res.status(503).json({ error: 'Dashboard is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET in the hosting dashboard.' });
    }
    if (!verifyAdminCookie(String(req.headers.cookie || ''))) {
      return res.status(401).json({ error: 'Not signed in.' });
    }

    const ipHash = createHash('sha256').update(clientIp(req) + (process.env.IP_HASH_SALT || '')).digest('hex');
    if (statsRateLimited(ipHash)) return res.status(429).json({ error: 'Too many requests. Slow down.' });

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
    // Heavy or rarely-opened views are lazy: the dashboard's first paint should not pay for a
    // 5,000-row click log or a 12-month audit nobody has asked to see yet.
    if (view === 'clicklog') {
      const { data, error } = await rpc('rpc_click_log', { days, lim: intParam(q.limit, 500, 1, 5000) });
      return res.status(200).json({ range_days: days, log: data || [], error });
    }
    if (view === 'audit') {
      const months = intParam(q.months, 12, 1, 36);
      const dim = ['source', 'country', 'device', 'campaign'].includes(String(q.dim)) ? String(q.dim) : 'source';
      const [monthly, breakdown] = await Promise.all([
        rpc('rpc_monthly', { months }),
        rpc('rpc_monthly_breakdown', { months, dim })
      ]);
      return res.status(200).json({
        months, dim,
        monthly: monthly.data || [],
        breakdown: breakdown.data || [],
        error: monthly.error || breakdown.error
      });
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
      overview, funnel, series, cta, sections, video, scroll,
      sources, countries, devices, referrers, errors, paths, leads,
      contact, clickTotals, clicks, pipeline
    ] = await Promise.all([
      rpc('rpc_overview', { days }),
      rpc('rpc_funnel', { days }),
      rpc('rpc_series', { days }),
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
      // 500, not 100: the list is now split into leads and signals, and a window where signals
      // outnumber leads would otherwise push real leads off the end of the page.
      rpc('rpc_leads', { days, lim: 500 }),
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
    const failures = [overview, funnel, series, cta, sections, video, scroll, sources, countries, devices, referrers, errors, paths, leads, contact, clickTotals, clicks, pipeline]
      .map(r => r.error).filter(Boolean) as string[];
    const distinctFailures = Array.from(new Set(failures));

    // Split the lead rows into the ones worth calling and the ones that are only a signal, and
    // correct the headline count. rpc_overview still reports every non-bot row as a "lead";
    // overriding it here keeps the definition in one place rather than duplicating a large SQL
    // function in a migration purely to change one tally. See migration 010 for the rationale.
    const allLeads = ((leads.data as any[]) || []).map(classifyLead);
    const qualifiedLeads = allLeads.filter(l => l.is_qualified);
    const leadSignals = allLeads.filter(l => !l.is_qualified);
    const overviewData: Record<string, any> = { ...(overview.data || {}) };
    overviewData.leads = qualifiedLeads.length;
    overviewData.lead_signals = leadSignals.length;
    overviewData.leads_all = allLeads.length;
    // Why each signal fell short, so the dashboard can explain itself rather than just hiding
    // rows the owner remembers seeing.
    overviewData.leads_missing_phone = allLeads.filter(l => !l.has_phone).length;
    overviewData.leads_missing_email = allLeads.filter(l => !l.has_email).length;
    overviewData.leads_missing_name = allLeads.filter(l => !l.has_name).length;

    return res.status(200).json({
      range_days: days,
      generated_at: new Date().toISOString(),
      degraded: distinctFailures.length > 0 ? distinctFailures : null,
      degraded_count: failures.length || undefined,
      overview: overviewData,
      funnel: funnel.data || [],
      series: series.data || [],
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
      // `leads` is now only the callable ones — that is what the word should mean everywhere,
      // including in the CSV/JSON export. The rest are still returned, labelled for what they
      // are, so nothing is hidden.
      leads: qualifiedLeads,
      lead_signals: leadSignals,
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
