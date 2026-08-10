/**
 * Rendering tests: what a crawler reads, and how the dashboard accordion responds.
 *
 * Two things static analysis cannot answer. First, what a non-rendering crawler actually
 * sees — GPTBot, ClaudeBot and PerplexityBot largely do not execute JavaScript, and the
 * dc-runtime's directives (`sc-if`, `sc-for`) are inert markup until it mounts, so every
 * branch and every unresolved {{ hole }} is visible until CSS hides them. Second, that the
 * dashboard panels respond to clicks and *not* to the cursor passing over them.
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

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  // Stand in for the storage redirect so the panels have real images to size themselves to.
  if (u.startsWith('/api/image')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(SPRITE); }
  if (u.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f);
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript'
    : ext === '.png' ? 'image/png' : 'text/plain';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(PORT, r));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function open({ js = true, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ javaScriptEnabled: js, viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
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
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  if (js) {
    await page.waitForFunction(() => !!window.__ddRoot, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1600);
  }
  return { page, ctx, errors };
}

// ============================================================ the no-JavaScript view
{
  const { page, ctx } = await open({ js: false });
  const text = await page.evaluate(() => document.body.innerText);
  const flat = text.replace(/\s+/g, ' ').trim();

  check('crawler sees substantial copy without JS', flat.length > 12000, `${flat.length} chars`);

  // sc-if renders every branch pre-hydration, so the error boundary used to be the first
  // thing on the page. If it comes back, an AI crawler's opening line is "this page had
  // trouble rendering".
  check('error boundary is not in the crawler view', !/momentary hiccup/i.test(text),
    /momentary hiccup/i.test(text) ? 'crash markup is visible!' : 'hidden');
  check('page opens on real content', /Digi Dental/.test(flat.slice(0, 120)), flat.slice(0, 60));

  const holes = text.match(/\{\{[^}]{0,60}\}\}/g) || [];
  check('no template syntax leaks as text', holes.length === 0, holes.slice(0, 5).join(' ') || 'clean');

  // The FAQ is rendered from faqData by a loop, so without JS it is an empty template.
  // The <noscript> mirror is what carries it to non-rendering crawlers.
  const faqSchema = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
      .match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/)[1])['@graph']
    .find(n => n['@type'] === 'FAQPage').mainEntity;
  const missing = faqSchema.filter(q => !flat.includes(q.name.replace(/\s+/g, ' ').trim()));
  check('every FAQ question is readable without JS', missing.length === 0,
    missing[0]?.name || `${faqSchema.length} questions present`);
  const missingA = faqSchema.filter(q => !flat.includes(q.acceptedAnswer.text.slice(0, 60).replace(/\s+/g, ' ').trim()));
  check('every FAQ answer is readable without JS', missingA.length === 0,
    missingA[0]?.name || `${faqSchema.length} answers present`);

  const h1 = await page.evaluate(() => document.querySelectorAll('h1').length);
  check('exactly one h1 in the crawler view', h1 === 1, `${h1}`);
  await ctx.close();
}

// ============================================================ landmarks after hydration
{
  const { page, ctx, errors } = await open();
  const lm = await page.evaluate(() => ({
    main: document.querySelectorAll('main').length,
    nav: document.querySelectorAll('nav').length,
    footer: document.querySelectorAll('footer').length,
    footerInSection: !!document.querySelector('section footer'),
    mainInSection: !!document.querySelector('section main'),
    sections: document.querySelectorAll('[data-section]').length,
  }));
  check('exactly one <main> landmark', lm.main === 1, `${lm.main}`);
  check('footer is page-level, not inside a section', lm.footerInSection === false,
    lm.footerInSection ? 'nested — loses the contentinfo landmark' : 'body-level');
  check('main is not nested in a section', lm.mainInSection === false);
  check('all sections still tracked', lm.sections === 9, `${lm.sections}`);
  check('no page errors', errors.length === 0, errors[0] || 'none');

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal overflow on desktop', overflow <= 0, `${overflow}px`);
  await ctx.close();
}

// ============================================================ dashboard accordion
const selOf = page => page.evaluate(() =>
  [...document.querySelectorAll('.dd-dash-panel')].map(e => e.getAttribute('aria-selected')).join(','));

for (const [label, viewport, collapsedIsZero] of [
  ['desktop', { width: 1280, height: 900 }, false],
  ['mobile', { width: 390, height: 844 }, true],
]) {
  const { page, ctx, errors } = await open({ viewport });
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
