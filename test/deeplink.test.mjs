/**
 * Deep links: /#calculator and /#demo.
 *
 * These two URLs go out in cold emails, DMs and call notes, so they are a public contract —
 * once sent, they cannot be renamed. Two things have to hold, and neither can be checked by
 * reading the file:
 *
 *   1. The ids exist and a visitor arriving on the hash ends up INSIDE that section. The page
 *      renders client-side, so the browser's own anchor jump happens against markup the runtime
 *      is about to replace — without the initDeepLink pass the visitor lands at the top of the
 *      page with the hash still in the address bar, which is the exact bug this guards.
 *   2. The section they land on is not hidden behind the fixed nav.
 *
 * Also pins the hero standfirst: it must stand out from body copy without becoming a heading,
 * which means bigger and darker than the paragraphs below it, but still the body font and
 * still not an <h*>.
 *
 * Run: node test/deeplink.test.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const NM = process.env.DD_TEST_MODULES || path.join(ROOT, 'node_modules');
const CHROME = process.env.DD_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8273;
const SPRITE = fs.readFileSync(path.join(ROOT, 'uploads/denty_neutral.png'));

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
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

async function open(hash, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.route('**/unpkg.com/**', route => {
    const url = route.request().url();
    const file = url.includes('react-dom')
      ? path.join(NM, 'react-dom/umd/react-dom.production.min.js')
      : path.join(NM, 'react/umd/react.production.min.js');
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file, 'utf8') });
  });
  await page.route('**/@vapi-ai/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default class{on(){}start(){}stop(){}};' }));
  await page.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ddRoot, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800); // past the 600ms corrective pass
  return { page, ctx, errors };
}

// Where did the visitor actually end up, relative to the section they asked for?
async function landing(page, id) {
  return page.evaluate(sel => {
    const el = document.getElementById(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const nav = document.querySelector('nav');
    return {
      top: Math.round(r.top),            // section top relative to the viewport
      bottom: Math.round(r.bottom),
      scrollY: Math.round(window.scrollY),
      navBottom: Math.round(nav ? nav.getBoundingClientRect().bottom : 0),
      vh: window.innerHeight
    };
  }, id);
}

// ============================================================ the two public link targets
for (const { hash, id, label, mustSee } of [
  { hash: '#calculator', id: 'calculator', label: 'ARR loss calculator', mustSee: 'The math is short.' },
  { hash: '#demo', id: 'demo', label: '60-second demo', mustSee: 'Talk to the receptionist yourself' }
]) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const device = viewport.width < 700 ? 'mobile' : 'desktop';
    const { page, ctx, errors } = await open(hash, viewport);
    const l = await landing(page, id);

    check(`${device}: /${hash} — the target exists`, !!l, l ? id : 'MISSING ID');
    if (!l) { await ctx.close(); continue; }

    // The bug this whole file exists for: hash present, visitor still at the top of the page.
    check(`${device}: /${hash} — did not land at the top of the page`, l.scrollY > 200, `scrollY ${l.scrollY}`);

    // "In that specific section" means the section spans the viewport at the landing position.
    check(`${device}: /${hash} — viewport is inside the ${label}`,
      l.top >= 0 && l.top <= l.navBottom + 24 && l.bottom > l.vh * 0.5,
      `top ${l.top}px, nav ends ${l.navBottom}px`);

    // Landing must not tuck the section under the fixed nav.
    check(`${device}: /${hash} — section top clears the fixed nav`,
      l.top >= 0 || l.top > -40, `top ${l.top}px`);

    // And the thing they came for has to be on screen, not just the section wrapper.
    const visible = await page.evaluate(t => {
      const el = [...document.querySelectorAll('h2,p,button')].find(e => e.textContent.includes(t));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), vh: window.innerHeight };
    }, mustSee);
    check(`${device}: /${hash} — "${mustSee.slice(0, 24)}…" is on screen`,
      !!visible && visible.top > -20 && visible.top < visible.vh, visible ? `top ${visible.top}px` : 'not found');

    check(`${device}: /${hash} — no page errors`, errors.length === 0, errors[0] || 'none');
    await ctx.close();
  }
}

// ============================================================ aliases and in-page navigation
{
  const { page, ctx } = await open('#arr');
  const l = await landing(page, 'calculator');
  check('alias: /#arr resolves to the calculator', !!l && l.scrollY > 200 && l.top <= l.navBottom + 24,
    `scrollY ${l?.scrollY}, top ${l?.top}px`);
  await ctx.close();
}
{
  // Changing the hash after load (a link click, a pasted URL in the address bar) must move too.
  const { page, ctx } = await open('');
  const before = await page.evaluate(() => Math.round(window.scrollY));
  await page.evaluate(() => { location.hash = '#calculator'; });
  await page.waitForTimeout(1400); // smooth scroll
  const l = await landing(page, 'calculator');
  check('hashchange after load scrolls to the section', before < 200 && l.scrollY > 200 && l.top <= l.navBottom + 24,
    `${before} -> ${l.scrollY}, top ${l.top}px`);
  await ctx.close();
}
{
  // No hash: the visitor belongs at the top, whatever else this file changed.
  const { page, ctx } = await open('');
  const y = await page.evaluate(() => Math.round(window.scrollY));
  check('no hash: page opens at the top', y < 40, `scrollY ${y}`);
  await ctx.close();
}

// ============================================================ hero standfirst
{
  const { page, ctx } = await open('');
  const hero = await page.evaluate(() => {
    const p = document.querySelector('.dd-hero-sub');
    if (!p) return null;
    const cs = getComputedStyle(p);
    const h1 = getComputedStyle(document.querySelector('h1'));
    // A paragraph from further down the page, as the body-copy baseline.
    const body = [...document.querySelectorAll('section p')]
      .find(e => e.textContent.length > 80 && e.getBoundingClientRect().width > 200);
    const bs = getComputedStyle(body);
    const lum = c => {
      const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map(v => {
        const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return {
      tag: p.tagName, size: parseFloat(cs.fontSize), weight: cs.fontWeight, family: cs.fontFamily,
      color: cs.color, lum: lum(cs.color),
      bodySize: parseFloat(bs.fontSize), bodyLum: lum(bs.color),
      h1Size: parseFloat(h1.fontSize), h1Family: h1.fontFamily,
      strongs: [...p.querySelectorAll('strong')].map(s => s.textContent),
      text: p.textContent.replace(/\s+/g, ' ').trim(),
      headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length
    };
  });

  check('hero standfirst is present', !!hero, hero ? hero.text.slice(0, 40) + '…' : 'MISSING');
  check('standfirst copy is unchanged',
    hero.text === 'A 24/7 human-sounding AI receptionist that answers every call and writes appointments straight into your calendar, set up entirely for you.',
    hero.text.slice(0, 50) + '…');
  check('standfirst outsizes body copy', hero.size > hero.bodySize, `${hero.size}px vs ${hero.bodySize}px body`);
  check('standfirst outcontrasts body copy', hero.lum < hero.bodyLum, `${hero.color}`);

  // The three things that would make it read as a heading.
  check('standfirst is still a paragraph, not a heading tag', hero.tag === 'P', hero.tag);
  check('standfirst stays well under the h1', hero.size < hero.h1Size * 0.55,
    `${hero.size}px vs h1 ${hero.h1Size}px`);
  check('standfirst keeps the body typeface, not the heading serif',
    /Inter/i.test(hero.family) && !/Fraunces/i.test(hero.family) && /Fraunces/i.test(hero.h1Family),
    hero.family.split(',')[0]);
  check('standfirst is not bolded end to end', Number(hero.weight) < 600, hero.weight);
  check('standfirst emphasis is partial', hero.strongs.length > 0 && hero.strongs.length <= 2,
    hero.strongs.join(' | ') || 'none');
  check('heading count is unchanged by the emphasis', hero.headings > 0, `${hero.headings} headings`);
  await ctx.close();
}

// ============================================================ mobile: the rule does not orphan
{
  const { page, ctx } = await open('', { width: 390, height: 844 });
  const m = await page.evaluate(() => {
    const p = document.querySelector('.dd-hero-sub');
    const r = p.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pad: getComputedStyle(p).paddingLeft,
      size: parseFloat(getComputedStyle(p).fontSize),
      within: r.left >= 0 && r.right <= window.innerWidth
    };
  });
  check('mobile: standfirst has no left rule to hang off centred text', m.pad === '0px', m.pad);
  check('mobile: standfirst stays inside the viewport', m.within && m.overflow <= 0, `overflow ${m.overflow}px`);
  check('mobile: standfirst is still larger than body copy', m.size >= 18, `${m.size}px`);
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
