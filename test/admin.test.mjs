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

// Nothing blank may be on screen when the Leads page opens. The signal rows have no name,
// email or phone on them — that is what makes them not leads — so they live behind a closed
// disclosure. `offsetParent === null` is the check that they are genuinely not rendered, rather
// than merely styled small.
const signalsHiddenByDefault = await page.evaluate(() => {
  const t = document.getElementById('signalTable');
  const wrap = document.getElementById('signalWrap');
  // Chromium keeps layout boxes for closed <details> (content-visibility:hidden), so
  // offsetParent still resolves. checkVisibility() is the one that accounts for it, with a
  // zero-height fallback for engines that lack it.
  const rendered = typeof t.checkVisibility === 'function'
    ? t.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true })
    : t.getBoundingClientRect().height > 0;
  return { collapsed: !wrap.open, notRendered: !rendered, countShown: document.getElementById('signalCount').textContent };
});
check('no blank rows are visible when the Leads page opens',
  signalsHiddenByDefault.collapsed && signalsHiddenByDefault.notRendered,
  JSON.stringify(signalsHiddenByDefault));
check('the signal count is still surfaced without opening it',
  signalsHiddenByDefault.countShown === '3', signalsHiddenByDefault.countShown);

// textContent, not innerText: the rows are inside a collapsed <details> and innerText returns
// '' for anything not being rendered.
await page.evaluate(() => { document.getElementById('signalWrap').open = true; });
await page.waitForTimeout(120);
const signalRows = await page.evaluate(() => [...document.querySelectorAll('#signalTable tbody tr')].map(r => r.textContent));

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

// ---------------------------------------------------------------- theme
{
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeBtn');
  const afterOne = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: localStorage.getItem('dd_admin_theme'),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check('the theme toggle switches theme', afterOne.attr === 'dark' || afterOne.attr === 'light',
    `${before || '(os)'} -> ${afterOne.attr}`);
  check('the choice is remembered', afterOne.stored === afterOne.attr, afterOne.stored);

  await page.click('#themeBtn');
  const afterTwo = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('toggling again goes back', afterTwo !== afterOne.attr, `${afterOne.attr} -> ${afterTwo}`);
}

// ---------------------------------------------------------------- contrast, both themes
// The dashboard gained a dark palette, and a palette nobody measured is a palette that fails
// somewhere. Same walker the public site uses: resolve the effective background by climbing
// ancestors and compositing alpha, then check WCAG AA on every visible text node.
{
  const measure = () => page.evaluate(() => {
    // The dashboard's tokens are oklch(), and Chromium serialises computed colours in the space
    // they were authored in — so getComputedStyle().color hands back "oklch(0.216 0.047 256)",
    // not "rgb(...)". A plain rgb regex rejects every one of them and the audit silently
    // measures nothing. Canvas is the normaliser: assigning any CSS colour to fillStyle and
    // reading it back returns hex or rgba, whatever the input space was.
    // Reading fillStyle back is not enough — Chromium round-trips "oklch(...)" unchanged,
    // preserving the authored colour space. Painting one pixel and reading it back forces the
    // actual conversion to sRGB, which is what the eye sees and what WCAG is defined against.
    // This also handles color-mix() and anything else the tokens grow into later.
    const cvEl = document.createElement('canvas');
    cvEl.width = cvEl.height = 1;
    const cv = cvEl.getContext('2d', { willReadFrequently: true });
    const parse = c => {
      if (!c) return null;
      const fast = c.match(/^rgba?\(([^)]+)\)$/);
      if (fast) {
        const p = fast[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      cv.clearRect(0, 0, 1, 1);
      cv.fillStyle = c;
      cv.fillRect(0, 0, 1, 1);
      const d = cv.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const lum = ({ r, g, b }) => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
    });
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const effBg = el => {
      let cur = el; const stack = [];
      while (cur && cur !== document.documentElement) {
        const bg = parse(getComputedStyle(cur).backgroundColor);
        if (bg && bg.a > 0) { stack.push(bg); if (bg.a === 1) break; }
        cur = cur.parentElement;
      }
      let base = parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      if (base.a < 1) base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
      return base;
    };
    const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const fails = new Map();
    let checked = 0;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim(); if (!t) continue;
      const el = n.parentElement; if (!el) continue;
      if (el.closest('[hidden]') || el.closest('details:not([open])')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
      const fg = parse(cs.color); if (!fg) continue;
      const bg = effBg(el);
      const flat = over(fg, bg);
      const r = ratio(flat, bg);
      const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
      const need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
      checked++;
      if (r + 0.005 >= need) continue;
      const key = `${hex(flat)} on ${hex(bg)}`;
      if (!fails.has(key)) fails.set(key, `${key} = ${r.toFixed(2)}:1 (needs ${need}) e.g. "${t.slice(0, 34)}"`);
    }
    return { checked, fails: [...fails.values()] };
  });

  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(150);
    const { checked, fails } = await measure();
    check(`${theme}: every text node meets WCAG AA contrast`, fails.length === 0,
      fails.slice(0, 3).join(' | ') || `${checked} text nodes`);
    check(`${theme}: contrast audit saw the page`, checked > 60, `${checked} text nodes`);
  }
}

check('no errors after exercising the page', errors.length === 0, errors[0] || 'none');

await browser.close();
server.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
