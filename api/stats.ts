// /api/stats — Vercel serverless function
// Aggregates site_events + leads for the admin dashboard at /admin.html.
//
// Everything is computed server-side with the service-role key and returned as one JSON
// payload, so the browser never holds a database credential and the raw event rows never
// leave the server. Requires the admin cookie set by /api/admin-login.
import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

const MAX_ROWS = 50000;

export function verifyAdminCookie(cookieHeader: string): boolean {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) return false; // never open when unconfigured
  const raw = /(?:^|;\s*)dd_admin=([^;]+)/.exec(cookieHeader || '');
  if (!raw) return false;
  const [expStr, sig] = decodeURIComponent(raw[1]).split('.');
  if (!expStr || !sig) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createHmac('sha256', secret).update(expStr).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const distinct = (rows: any[], key = 'session_id') => new Set(rows.map(r => r[key]).filter(Boolean)).size;

function median(nums: number[]) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function countBy(rows: any[], pick: (r: any) => string | null | undefined) {
  const out: Record<string, { events: number; sessions: Set<string> }> = {};
  for (const r of rows) {
    const k = pick(r);
    if (!k) continue;
    (out[k] = out[k] || { events: 0, sessions: new Set() }).events++;
    if (r.session_id) out[k].sessions.add(r.session_id);
  }
  return Object.entries(out)
    .map(([label, v]) => ({ label, events: v.events, sessions: v.sessions.size }))
    .sort((a, b) => b.events - a.events);
}

export default async function handler(req: any, res: any) {
  try {
    if (!process.env.ADMIN_PASSWORD) {
      return res.status(503).json({ error: 'Dashboard is not configured. Set ADMIN_PASSWORD in the hosting dashboard.' });
    }
    if (!verifyAdminCookie(String(req.headers.cookie || ''))) {
      return res.status(401).json({ error: 'Not signed in.' });
    }

    const days = Math.min(365, Math.max(1, parseInt(String((req.query && req.query.days) || '30'), 10) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const { data: events } = await supabase
      .from('site_events').select('*').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(MAX_ROWS);
    const { data: leadRows } = await supabase
      .from('leads').select('*').gte('created_at', since)
      .order('created_at', { ascending: false }).limit(2000);

    const ev = events || [];
    const leads = (leadRows || []).filter(l => !l.is_bot);
    const of = (name: string) => ev.filter(r => r.event === name);

    const views = of('page_view');
    const sessionsWith = (name: string) => new Set(of(name).map(r => r.session_id).filter(Boolean));

    // Funnel: each step counted once per session, in the order a visitor meets them.
    const steps: [string, string][] = [
      ['Landed on the page', 'page_view'],
      ['Reached the demo', 'view_demo_proxy'],
      ['Started a demo call', 'demo_start'],
      ['Finished the demo call', 'demo_complete'],
      ['Opened the booking form', 'form_open'],
      ['Submitted the form', 'form_submit'],
      ['Clicked through to Calendly', 'calendly_click']
    ];
    const reachedDemo = new Set(
      of('section_time').filter(r => Number(r.props?.demo || 0) > 2).map(r => r.session_id).filter(Boolean)
    );
    const funnel = steps.map(([label, name]) => ({
      label,
      sessions: name === 'view_demo_proxy' ? reachedDemo.size : sessionsWith(name).size
    }));

    // Attention: median dwell seconds per section, from one summary event per visit.
    const dwell: Record<string, number[]> = {};
    for (const r of of('section_time')) {
      for (const [k, v] of Object.entries(r.props || {})) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) (dwell[k] = dwell[k] || []).push(n);
      }
    }
    const sections = Object.entries(dwell)
      .map(([label, arr]) => ({ label, median_seconds: median(arr), sessions: arr.length }))
      .sort((a, b) => b.median_seconds - a.median_seconds);

    // Video: real seconds watched, plus how far through people get.
    const watch = of('video_watch');
    const clips = ['vsl', 'demo_recording'].map(clip => {
      const w = watch.filter(r => r.props?.clip === clip).map(r => Number(r.props?.seconds) || 0);
      const marks = [25, 50, 75, 95].map(pct => ({
        pct,
        sessions: new Set(of('video_progress').filter(r => r.props?.clip === clip && Number(r.props?.percent) === pct).map(r => r.session_id)).size
      }));
      return {
        clip, plays: w.length,
        median_seconds: median(w),
        total_minutes: Math.round(w.reduce((a, b) => a + b, 0) / 60),
        marks
      };
    });

    const sessionEnds = of('session_end');
    const durations = sessionEnds.map(r => Number(r.props?.seconds) || 0).filter(n => n > 0);
    const depths = sessionEnds.map(r => Number(r.props?.max_depth) || 0).filter(n => n > 0);

    // Sessions per day, oldest first, with empty days filled so the shape is honest.
    const byDay: Record<string, Set<string>> = {};
    for (const r of views) {
      const d = String(r.created_at).slice(0, 10);
      (byDay[d] = byDay[d] || new Set()).add(r.session_id);
    }
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      daily.push({ date: d, sessions: byDay[d] ? byDay[d].size : 0 });
    }

    return res.status(200).json({
      range_days: days,
      generated_at: new Date().toISOString(),
      truncated: ev.length >= MAX_ROWS,
      totals: {
        visitors: distinct(views, 'ip_hash'),
        sessions: distinct(views),
        page_views: views.length,
        demo_starts: sessionsWith('demo_start').size,
        demo_completes: sessionsWith('demo_complete').size,
        calendly_clicks: sessionsWith('calendly_click').size,
        form_opens: sessionsWith('form_open').size,
        form_submits: sessionsWith('form_submit').size,
        leads: leads.length,
        median_seconds_on_page: median(durations),
        median_scroll_depth: median(depths),
        not_found: of('page_not_found').length
      },
      funnel,
      daily,
      clicks: countBy(of('cta_click'), r => r.props?.location),
      calendly: countBy(of('calendly_click'), r => r.props?.location),
      sections,
      clips,
      countries: countBy(views, r => r.country),
      devices: countBy(views, r => r.device),
      referrers: countBy(views, r => r.props?.referrer_host),
      scroll: [25, 50, 75, 90].map(d => ({
        label: d + '%',
        sessions: new Set(of('scroll_depth').filter(r => Number(r.props?.depth) === d).map(r => r.session_id)).size
      })),
      broken_links: countBy(of('page_not_found'), r => r.props?.path),
      leads: leads.slice(0, 50).map(l => ({
        created_at: l.created_at, name: l.name, practice_name: l.practice_name,
        email: l.email, phone: l.phone, country: l.country,
        monthly_call_volume: l.monthly_call_volume, locations: l.locations, source: l.source
      }))
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'Could not build the report.', detail: String(e && e.message || e).slice(0, 200) });
  }
}
