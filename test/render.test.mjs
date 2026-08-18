/**
 * Rendering tests: what a crawler reads, and how the dashboard accordion responds.
 *
 * Two things static analysis cannot answer. First, what a non-rendering crawler actually
 * sees — GPTBot, ClaudeBot and PerplexityBot largely do not execute JavaScript, and the
 * dc-runtime's directives (`sc-if`, `sc-for`) are inert markup until it mounts, so every
 * branch and every unresolved {{ hole }} is visible until CSS hides them. Second, that the
 * dashboard panels respond to clicks and *not* to the cursor passing over them.
 *
 * Both pages are exercised. They share one stylesheet and one logic class, so a rule or a
 * method that is correct on `/` and broken on `/how-it-works/` is exactly the regression a
 * single-page test would have missed.
 *
 * Run: node test/render.test.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const NM = process.env.DD_TEST_MODULES || path.join(ROOT, 'node_modules');
const CHROME = process.env.DD_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8271;
const SPRITE = fs.readFileSync(path.join(ROOT, 'uploads/denty_neutral.png'));

// Serve the SAME response headers production does. A Content-Security-Policy that blocks a
// script the page needs fails silently in a plain static server and catastrophically in
// production, so the policy is exercised here rather than trusted.
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
function headersFor(urlPath) {
  const out = {};
  for (const rule of VERCEL.headers || []) {
    let re;
    try { re = new RegExp('^' + rule.source.replace(/\/\(\.\*\)$/, '(?:/.*)?') + '$'); }
    catch { continue; }
    if (re.test(urlPath)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const extra = headersFor(u);
  // Stand in for the storage redirect so the panels have real images to size themselves to.
  if (u.startsWith('/api/image')) { res.writeHead(200, { ...extra, 'Content-Type': 'image/png' }); return res.end(SPRITE); }
  if (u.startsWith('/api/')) { res.writeHead(200, { ...extra, 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  // Directory-index resolution, the way Vercel serves static output: /how-it-works/ and
  // /how-it-works both come from how-it-works/index.html.
  let f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f);
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript'
    : ext === '.css' ? 'text/css' : ext === '.png' ? 'image/png' : 'text/plain';
  res.writeHead(200, { ...extra, 'Content-Type': type });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function open({ at = '/', js = true, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ javaScriptEnabled: js, viewport });
  const page = await ctx.newPage();
  const errors = [];
  const csp = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) csp.push(t); });
  if (js) {
    await page.route('**/unpkg.com/**', route => {
      const url = route.request().url();
      const file = url.includes('react-dom')
        ? path.join(NM, 'react-dom/umd/react-dom.production.min.js')
        : path.join(NM, 'react/umd/react.production.min.js');
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file, 'utf8') });
    });
    await page.route('**/@vapi-ai/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default class{on(){}start(){}stop(){}};' }));
  }
  await page.goto(`http://localhost:${PORT}${at}`, { waitUntil: 'domcontentloaded' });
  if (js) {
    await page.waitForFunction(() => !!window.__ddRoot, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1600);
  }
  return { page, ctx, errors, csp };
}

// ============================================================ the no-JavaScript view
// Both pages, because the split is exactly the kind of change that quietly leaves one of
// them rendering the crash boundary or a page full of {{ holes }} to an AI crawler.
const PAGES = [
  { name: 'home', at: '/', minChars: 5000 },
  { name: 'deep', at: '/how-it-works/', minChars: 9000 },
];

for (const p of PAGES) {
  const { page, ctx } = await open({ at: p.at, js: false });
  const text = await page.evaluate(() => document.body.innerText);
  const flat = text.replace(/\s+/g, ' ').trim();

  check(`${p.name}: crawler sees substantial copy without JS`, flat.length > p.minChars, `${flat.length} chars`);

  // sc-if renders every branch pre-hydration, so the error boundary used to be the first
  // thing on the page. If it comes back, an AI crawler's opening line is "this page had
  // trouble rendering".
  check(`${p.name}: error boundary is not in the crawler view`, !/momentary hiccup/i.test(text),
    /momentary hiccup/i.test(text) ? 'crash markup is visible!' : 'hidden');
  check(`${p.name}: page opens on real content`, /Digi Dental/.test(flat.slice(0, 120)), flat.slice(0, 60));

  const holes = text.match(/\{\{[^}]{0,60}\}\}/g) || [];
  check(`${p.name}: no template syntax leaks as text`, holes.length === 0, holes.slice(0, 5).join(' ') || 'clean');

  const h1 = await page.evaluate(() => document.querySelectorAll('h1').length);
  check(`${p.name}: exactly one h1 in the crawler view`, h1 === 1, `${h1}`);

  // Both pages have to reach the other one with a real <a href>, or a non-rendering crawler
  // never discovers the second document at all.
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')));
  const wanted = p.name === 'home' ? '/how-it-works/' : '/';
  check(`${p.name}: links to the other page without JS`,
    hrefs.some(h => h === wanted || (wanted === '/how-it-works/' && h.startsWith('/how-it-works/'))),
    `${hrefs.length} links`);

  if (p.name === 'deep') {
    // The FAQ is rendered from faqData by a loop, so without JS it is an empty template.
    // The <noscript> mirror is what carries it to non-rendering crawlers.
    const faqSchema = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'how-it-works/index.html'), 'utf8')
        .match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/)[1])['@graph']
      .find(n => n['@type'] === 'FAQPage').mainEntity;
    const missing = faqSchema.filter(q => !flat.includes(q.name.replace(/\s+/g, ' ').trim()));
    check('every FAQ question is readable without JS', missing.length === 0,
      missing[0]?.name || `${faqSchema.length} questions present`);
    const missingA = faqSchema.filter(q => !flat.includes(q.acceptedAnswer.text.slice(0, 60).replace(/\s+/g, ' ').trim()));
    check('every FAQ answer is readable without JS', missingA.length === 0,
      missingA[0]?.name || `${faqSchema.length} answers present`);
  }
  await ctx.close();
}

// ============================================================ landmarks after hydration
// Section counts are asserted per page: `/` is the five-block hand-raiser, `/how-it-works/`
// is the deep dive. If a section silently stops rendering, the analytics that key off
// data-section go quiet rather than erroring, so the count is the alarm.
for (const [name, at, sections] of [['home', '/', 5], ['deep', '/how-it-works/', 8]]) {
  const { page, ctx, errors, csp } = await open({ at });
  const lm = await page.evaluate(() => ({
    main: document.querySelectorAll('main').length,
    nav: document.querySelectorAll('nav').length,
    footer: document.querySelectorAll('footer').length,
    footerInSection: !!document.querySelector('section footer'),
    mainInSection: !!document.querySelector('section main'),
    sections: document.querySelectorAll('[data-section]').length,
  }));
  check(`${name}: exactly one <main> landmark`, lm.main === 1, `${lm.main}`);
  check(`${name}: footer is page-level, not inside a section`, lm.footerInSection === false,
    lm.footerInSection ? 'nested — loses the contentinfo landmark' : 'body-level');
  check(`${name}: main is not nested in a section`, lm.mainInSection === false);
  check(`${name}: all sections still tracked`, lm.sections === sections, `${lm.sections} of ${sections}`);
  check(`${name}: no page errors`, errors.length === 0, errors[0] || 'none');

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${name}: no horizontal overflow on desktop`, overflow <= 0, `${overflow}px`);

  // The test server replays vercel.json's real headers, so the CSP is enforced here exactly as
  // in production. This caught a policy that blanked the entire page: the dc-runtime compiles
  // each logic class from a string, so without 'unsafe-eval' nothing mounts at all.
  const blocked = csp.filter(m => !/fonts\.googleapis/.test(m));
  check(`${name}: no CSP violations under the production policy`, blocked.length === 0, blocked[0]?.slice(0, 140) || 'clean');
  check(`${name}: app actually mounted under CSP`, lm.main === 1 && lm.sections === sections,
    `main ${lm.main}, sections ${lm.sections}`);

  // The nav is the site's only always-visible route to the other page.
  const desktopLinks = await page.evaluate(() =>
    [...document.querySelectorAll('.dd-navdesk a')].map(a => a.getAttribute('href')));
  check(`${name}: desktop nav offers the deep-dive routes`,
    ['/how-it-works/', '/how-it-works/#pricing', '/how-it-works/#faq', '/how-it-works/#demo']
      .every(h => desktopLinks.includes(h)), desktopLinks.join(' '));
  await ctx.close();
}

// ============================================================ the mobile nav menu
// Below 900px the links collapse behind one control. A menu that opens onto nothing, or
// that cannot be closed from the keyboard, is worse than no menu.
{
  const { page, ctx, errors } = await open({ at: '/', viewport: { width: 390, height: 844 } });
  const burgerVisible = await page.evaluate(() => {
    const b = document.querySelector('.dd-navburger');
    return !!b && getComputedStyle(b).display !== 'none';
  });
  check('mobile: the menu control is visible', burgerVisible);
  const deskHidden = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.dd-navdesk')).display === 'none');
  check('mobile: the desktop link row is hidden', deskHidden);
  check('mobile: no panel before it is opened', (await page.locator('#dd-nav-panel').count()) === 0);

  await page.evaluate(() => document.querySelector('.dd-navburger').click());
  await page.waitForTimeout(400);
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('#dd-nav-panel a')].map(a => a.getAttribute('href')));
  check('mobile: opening the menu reveals every route', links.length >= 5, links.join(' '));
  check('mobile: the menu reaches the deep page', links.includes('/how-it-works/'), links.join(' '));
  const expanded = await page.evaluate(() => document.querySelector('.dd-navburger').getAttribute('aria-expanded'));
  check('mobile: the control reports its state', expanded === 'true', `aria-expanded=${expanded}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('mobile: Escape closes the menu', (await page.locator('#dd-nav-panel').count()) === 0);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile: nav causes no horizontal overflow', overflow <= 0, `${overflow}px`);
  check('mobile nav: no page errors', errors.length === 0, errors[0] || 'none');
  await ctx.close();
}

// ============================================================ stat count-up stability
{
  // The count grows the string as well as the number ("0" -> "8,000"), and the stat reads
  // "$<count>–$10,000". On a phone that line fits one row early in the count and needs two
  // by the end, so it re-wraps mid-animation and the block jumps. The fix holds the box open
  // with a hidden copy of the final string and paints the running value over it, out of flow.
  const { page, ctx, errors } = await open({ at: '/', viewport: { width: 390, height: 844 } });
  await page.evaluate(() => document.querySelector('[data-section="cost"]').scrollIntoView());

  // Drive the shipped animateCount directly so the sampling window cannot miss the short
  // low-digit phase, and measure offsetWidth rather than getBoundingClientRect: the stats sit
  // inside a data-reveal block whose entrance transform inflates the visual rect and would
  // masquerade as layout drift.
  const samples = await page.evaluate(async () => {
    const app = window.__ddRoot;
    const spans = [...document.querySelectorAll('[data-count]')];
    document.querySelector('[data-section="cost"]').scrollIntoView();
    await new Promise(r => setTimeout(r, 60));
    spans.forEach(s => { s.textContent = '0'; app.animateCount(s); });
    const W = spans.map(() => new Set());
    const R = spans.map(() => new Set());
    const t0 = performance.now();
    while (performance.now() - t0 < 3800) {
      spans.forEach((s, i) => {
        W[i].add(s.offsetWidth);                       // layout width, transform-independent
        R[i].add(s.parentElement.getClientRects().length);  // line boxes the stat occupies
      });
      await new Promise(r => setTimeout(r, 25));
    }
    return spans.map((s, i) => ({
      count: s.dataset.count,
      widths: [...W[i]].sort((a, b) => a - b),
      rows: [...R[i]].sort(),
    }));
  });

  check('stat count-ups were sampled while running', samples.length === 4, `${samples.length} stats`);

  // Before the fix this span went 23 -> 69 -> 101 -> 103px as the digits arrived. That 80px
  // swing is what carried the line past the wrap threshold and back on a phone.
  const drift = samples.filter(s => s.widths.length > 1);
  check('mobile: animated number holds one fixed width', drift.length === 0,
    drift.map(s => `${s.count}: ${s.widths.join('->')}px`).join(', ') || `pinned at ${samples.map(s => s.widths[0]).join('/')}px`);

  const reflowed = samples.filter(s => s.rows.length > 1);
  check('mobile: stat never changes line count mid-count', reflowed.length === 0,
    reflowed.map(s => `${s.count}: ${s.rows.join('->')} rows`).join(', ') || 'no re-wrap');

  const finals = await page.evaluate(() => [...document.querySelectorAll('[data-count]')]
    .map(s => ({ want: Number(s.dataset.count).toLocaleString('en-US'), got: s.textContent, kids: s.children.length })));
  const wrong = finals.filter(f => f.want !== f.got);
  check('every count-up lands on its target value', wrong.length === 0,
    wrong.map(f => `${f.got} != ${f.want}`).join(', ') || finals.map(f => f.got).join(', '));
  check('helper spans are cleaned up when the count finishes', finals.every(f => f.kids === 0),
    finals.map(f => f.kids).join(','));
  check('count-up produced no errors', errors.length === 0, errors[0] || 'none');
  await ctx.close();
}

// ============================================================ dashboard accordion
const selOf = page => page.evaluate(() =>
  [...document.querySelectorAll('.dd-dash-panel')].map(e => e.getAttribute('aria-selected')).join(','));

for (const [label, viewport, collapsedIsZero] of [
  ['desktop', { width: 1280, height: 900 }, false],
  ['mobile', { width: 390, height: 844 }, true],
]) {
  const { page, ctx, errors } = await open({ at: '/how-it-works/', viewport });
  await page.evaluate(() => document.querySelector('[data-section="dashboard"]').scrollIntoView());
  await page.waitForTimeout(1400);

  const n = await page.evaluate(() => document.querySelectorAll('.dd-dash-panel').length);
  check(`${label}: four panels render`, n === 4, `${n}`);

  // The regression this replaced: onMouseEnter meant that dragging the cursor toward a
  // panel re-selected every panel it crossed, while each was mid width-transition.
  const before = await selOf(page);
  for (const i of [2, 3, 4, 3, 2]) {
    await page.hover(`.dd-dash-panel:nth-child(${i})`).catch(() => {});
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(600);
  check(`${label}: hovering across panels changes nothing`, (await selOf(page)) === before,
    `${before} -> ${await selOf(page)}`);

  // Clicking each panel selects exactly it.
  let ok = true, detail = '';
  for (const i of [3, 4, 2, 1]) {
    await page.evaluate(k => document.querySelectorAll('.dd-dash-panel')[k - 1].click(), i);
    await page.waitForTimeout(700);
    const sel = (await selOf(page)).split(',');
    const open = sel.map((v, k) => v === 'true' ? k + 1 : null).filter(Boolean);
    if (open.length !== 1 || open[0] !== i) { ok = false; detail = `clicked ${i}, open [${open}]`; break; }
  }
  check(`${label}: clicking a panel opens exactly that panel`, ok, detail || 'all four switch cleanly');

  const bodies = await page.evaluate(() => [...document.querySelectorAll('.dd-dash-panel')].map(e => ({
    sel: e.getAttribute('aria-selected'),
    h: Math.round(e.querySelector('.dd-dash-inner').getBoundingClientRect().height),
  })));
  const openH = bodies.find(b => b.sel === 'true')?.h ?? 0;
  check(`${label}: the open panel has height`, openH > 100, `${openH}px`);
  if (collapsedIsZero) {
    const shut = bodies.filter(b => b.sel !== 'true');
    check('mobile: collapsed panels are fully closed', shut.every(b => b.h === 0),
      `heights [${shut.map(b => b.h)}]`);
  }

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${label}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
  check(`${label}: no page errors`, errors.length === 0, errors[0] || 'none');
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
