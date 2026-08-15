/**
 * Admin dashboard tests.
 *
 * The dashboard had no coverage at all, which is how a Leads table full of blank rows survived:
 * nothing anywhere asserted what a lead is. These tests drive the real page against a stubbed
 * /api/stats and check the things that are easy to get quietly wrong — the lead/signal split,
 * that every panel explains itself, and that the export contains every dataset rather than only
 * the tabs that happened to be open.
 *
 * Run: node test/admin.test.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CHROME = process.env.DD_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8274;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// One qualified lead, and three rows that look like leads but are not: a completed demo call
// with nothing filled in, an exit-intent row with only an email, and a form row missing a
// phone. All three used to be counted and listed as leads.
const LEADS = [
  { created_at: '2026-08-12T10:00:00Z', name: 'Dana Reyes', practice_name: 'Reyes Family Dental',
    email: 'dana@reyesdental.com', phone: '+1 480 555 0142', country: 'United States',
    monthly_call_volume: '200–500', locations: '2', source: 'form', visitor_id: 'v-1',
    utm_source: 'google', utm_campaign: 'east-valley', referrer_host: 'google.com' },
  { created_at: '2026-08-12T09:00:00Z', name: null, practice_name: null, email: null, phone: null,
    country: null, monthly_call_volume: null, locations: null, source: 'demo_call', visitor_id: 'v-2',
    utm_source: null, utm_campaign: null, referrer_host: null },
  { created_at: '2026-08-11T09:00:00Z', name: '', practice_name: '', email: 'someone@example.com',
    phone: '', country: null, monthly_call_volume: null, locations: null, source: 'exit_intent',
    visitor_id: 'v-3', utm_source: null, utm_campaign: null, referrer_host: null },
  { created_at: '2026-08-10T09:00:00Z', name: 'Sam Okafor', practice_name: 'Bright Smile',
    email: 'sam@brightsmile.com', phone: '   ', country: 'United States',
    monthly_call_volume: '50–200', locations: '1', source: 'form', visitor_id: 'v-4',
    utm_source: null, utm_campaign: null, referrer_host: null },
];

// Mirrors what api/stats.ts sends: `leads` pre-split to the callable ones, signals alongside.
const LOOSE_EMAIL = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const filled = v => typeof v === 'string' && v.trim() !== '';
const isQualified = r => filled(r.name) && filled(r.phone) && filled(r.email) && LOOSE_EMAIL.test(r.email.trim());

const DASHBOARD = {
  range_days: 30,
  generated_at: '2026-08-13T12:00:00Z',
  overview: {
    visitors: 420, returning_visitors: 60, sessions: 510, median_seconds: 96, median_scroll: 62,
    form_opens: 40, form_submits: 12, demo_starts: 30, demo_completes: 18,
    leads: LEADS.filter(isQualified).length,
    lead_signals: LEADS.filter(r => !isQualified(r)).length,
  },
  funnel: [{ step: 'view', visitors: 420 }, { step: 'demo', visitors: 30 }],
  series: [{ day: '2026-08-10', visitors: 20, clicks: 44, sessions: 24, demo_starts: 2, form_submits: 1, contacts: 1, leads: 1 },
           { day: '2026-08-11', visitors: 31, clicks: 61, sessions: 35, demo_starts: 3, form_submits: 2, contacts: 2, leads: 0 }],
  cta: [{ placement: 'hero', impressions: 300, clicks: 42, rate: 14 }],
  sections: [{ section: 'hero', visitors: 400, median_seconds: 12, exits: 30 }],
  video: [{ clip: 'vsl', q: 25, visitors: 120 }],
  scroll: [{ depth: 50, visitors: 220 }],
  sources: [{ label: 'google', value: 200 }],
  countries: [{ label: 'United States', value: 380 }],
  devices: [{ label: 'mobile', value: 260 }],
  referrers: [{ label: 'google.com', value: 190 }],
  errors: [{ event: 'form_error', detail: 'phone', hits: 3 }],
  paths: [{ step: 'demo_complete', lift: 3.2 }],
  leads: LEADS.filter(isQualified),
  lead_signals: LEADS.filter(r => !isQualified(r)),
  contact: [{ channel: 'whatsapp', visitors: 20 }],
  click_totals: { total_clicks: 900, clicks_per_visitor: 2.1 },
  clicks: [{ label: 'Book a Strategy Call', value: 120 }],
  pipeline: [{ stage: 'demoed', visitor_id: 'v-2', last_seen: '2026-08-12T09:00:00Z' }],
};

const served = { clicklog: 0, audit: 0, visitors: 0, breakdown: 0 };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === '/api/stats') {
    const view = u.searchParams.get('view') || 'dashboard';
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (view === 'clicklog') { served.clicklog++; return send({ log: [{ at: '2026-08-12T10:00:00Z', label: 'Book', country: 'US' }] }); }
    if (view === 'audit') { served.audit++; return send({ monthly: [{ month: '2026-08', conversions: 5 }], breakdown: [{ month: '2026-08', key: 'google', conversions: 3 }] }); }
    if (view === 'visitors') { served.visitors++; return send({ visitors: [{ visitor_id: 'v-1', events: 9 }] }); }
    if (view === 'breakdown') { served.breakdown++; return send({ rows: [{ label: u.searchParams.get('dim'), value: 1 }] }); }
    return send(DASHBOARD);
  }
  const f = path.join(ROOT, u.pathname === '/' ? 'admin.html' : u.pathname);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.png' ? 'image/png' : 'text/plain' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
// GSAP is decorative and comes from a CDN; stub it so the test does not depend on the network.
await page.route('**/gsap**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await page.goto(`http://localhost:${PORT}/admin.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(700);

check('dashboard renders without JavaScript errors', errors.length === 0, errors[0] || 'none');
check('the app shell is visible', await page.evaluate(() => !document.getElementById('app').hidden));

// ---------------------------------------------------------------- lead qualification
await page.evaluate(() => document.querySelector('[data-nav="leads"], #nav button[data-id="leads"]')?.click());
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#nav button')].find(x => /leads/i.test(x.textContent));
  if (b) b.click();
});
await page.waitForTimeout(300);

const leadRows = await page.evaluate(() => [...document.querySelectorAll('#leadTable tbody tr')].map(r => r.innerText));
const signalRows = await page.evaluate(() => [...document.querySelectorAll('#signalTable tbody tr')].map(r => r.innerText));

check('only contactable leads are listed as leads', leadRows.length === 1, `${leadRows.length} rows`);
check('the qualified lead shows its full detail',
  /Dana Reyes/.test(leadRows[0] || '') && /dana@reyesdental\.com/.test(leadRows[0] || '')
  && /480 555 0142/.test(leadRows[0] || '') && /Reyes Family Dental/.test(leadRows[0] || ''),
  (leadRows[0] || '').replace(/\s+/g, ' ').slice(0, 90));

check('rows with no contact details are not leads', signalRows.length === 3, `${signalRows.length} signals`);
check('a blank-name blank-phone row never reaches the leads table',
  !leadRows.some(r => /demo_call|exit_intent/.test(r)));
// The whitespace-only phone is the case a plain null check misses.
check('a whitespace-only phone does not qualify',
  !leadRows.some(r => /Sam Okafor/.test(r)) && signalRows.some(r => /phone/.test(r)),
  signalRows.find(r => /Sam/.test(r))?.replace(/\s+/g, ' ').slice(0, 80) || 'n/a');
check('each signal says what it was missing', signalRows.every(r => /name|email|phone/.test(r)));

// Read the value node, not the tile: the tile's innerText runs the figure straight into the
// description below it ("1" + "3 more showed intent…" reads as "13").
const headline = await page.evaluate(() => {
  const t = [...document.querySelectorAll('#stats .stat')].find(x => /Leads you can call/i.test(x.textContent));
  return t ? { value: t.querySelector('.v').textContent.trim(), desc: t.querySelector('.d').textContent.trim() } : null;
});
check('the overview headline counts only contactable leads', headline && headline.value === '1',
  headline ? `value "${headline.value}"` : 'tile not found');
check('the headline says where the other rows went', !!headline && /3 more showed intent/.test(headline.desc),
  headline ? headline.desc : '');

// ---------------------------------------------------------------- explainers
const panels = await page.evaluate(() =>
  [...document.querySelectorAll('.card-head')].map(h => ({
    title: (h.querySelector('.card-title')?.textContent || '').trim(),
    desc: (h.querySelector('.card-desc')?.textContent || '').trim(),
  })).filter(p => p.title));
const undocumented = panels.filter(p => p.desc.length < 25);
check('every panel explains itself in plain language', undocumented.length === 0,
  undocumented.map(p => p.title).join(', ') || `${panels.length} panels documented`);

// ---------------------------------------------------------------- export completeness
const exported = await page.evaluate(async () => {
  // Intercept the download rather than writing a file: the assertion is about what the export
  // contains, and jsdom-free Chromium downloads are awkward to read back.
  const captured = [];
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = blob => { captured.push(blob); return 'blob:stub'; };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  document.getElementById('expBtn').click();
  document.querySelector('[data-exp="json"]').click();
  await new Promise(r => setTimeout(r, 1200));
  URL.createObjectURL = realCreate;
  HTMLAnchorElement.prototype.click = realClick;
  if (!captured.length) return null;
  return JSON.parse(await captured[captured.length - 1].text());
});

check('export produced a file', !!exported);
if (exported) {
  const names = Object.keys(exported.datasets || {});
  const required = ['overview', 'daily_series', 'funnel', 'cta_placements', 'clicked_controls',
    'contact_channels', 'sections', 'scroll_depth', 'video', 'traffic_sources', 'countries',
    'devices', 'referrers', 'conversion_paths', 'errors', 'pipeline',
    'leads_contactable', 'lead_signals_no_contact_details'];
  const missing = required.filter(n => !names.includes(n));
  check('export includes every dashboard metric', missing.length === 0, missing.join(', ') || `${names.length} datasets`);

  // These three are lazily loaded. The export used to omit them unless you had opened their
  // tabs first, which made the file's contents depend on where you happened to be standing.
  check('export pulls in the lazily-loaded click log', names.includes('click_log'));
  check('export pulls in the 12-month audit', names.includes('monthly'));
  check('export pulls in the visitor list', names.includes('visitors'));
  check('export fetched the lazy views itself', served.clicklog > 0 && served.audit > 0 && served.visitors > 0,
    JSON.stringify(served));

  check('exported leads are only the contactable ones',
    (exported.datasets.leads_contactable || []).length === 1,
    `${(exported.datasets.leads_contactable || []).length} rows`);
  check('exported leads carry every field worth calling on',
    ['name', 'email', 'phone', 'practice_name', 'country', 'monthly_call_volume']
      .every(k => k in (exported.datasets.leads_contactable[0] || {})));
  check('exported signals are labelled, not silently dropped',
    (exported.datasets.lead_signals_no_contact_details || []).length === 3);
}

check('no errors after exercising the page', errors.length === 0, errors[0] || 'none');

await browser.close();
server.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
