/**
 * The booking modal, driven the way a lead drives it.
 *
 * This is the only form on the site, and it is the whole funnel: everything else on both
 * pages exists to get someone into it. It used to ask six questions and expect five of them
 * typed — a country picked out of a <select>, a location count keyed into a number field —
 * and it lost people in the middle. Now the three qualifying questions are ranges you tap,
 * and a tap advances the step by itself, so only the name, the practice, the email and the
 * phone still take keys.
 *
 * What is asserted here is that property, not the markup that currently implements it:
 * how much typing the flow costs, that every tap moves you on with no second click, and
 * that what lands in the lead payload still reads the way the owner's inbox and
 * api/notify-lead.ts's qualification check expect it to. The range labels lead with a digit
 * for exactly that reason, and that is the assertion most likely to catch a well-meaning
 * relabel later.
 *
 * Both pages, because they share one logic file and one block of modal markup, and a step
 * that only got fixed on `/` is precisely the regression a single-page test would miss.
 *
 * Run: node test/booking.test.mjs
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

// The lead the browser actually posts, captured rather than mocked away: the payload is the
// product of this form, and asserting on it is the point.
let posted = null;

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u.startsWith('/api/notify-lead')) {
    let body = '';
    req.on('data', d => { body += d; });
    return req.on('end', () => {
      try { posted = JSON.parse(body); } catch { posted = null; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  }
  if (u.startsWith('/api/image')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(SPRITE); }
  if (u.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  let f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f);
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript'
    : ext === '.css' ? 'text/css' : ext === '.png' ? 'image/png' : 'text/plain';
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

// React is pinned to unpkg in the page head and there is no network in CI, so it is served
// from node_modules — the same substitution test/render.test.mjs makes, for the same reason.
async function open(at, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.route('**/unpkg.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: fs.readFileSync(path.join(NM, route.request().url().includes('react-dom')
      ? 'react-dom/umd/react-dom.production.min.js'
      : 'react/umd/react.production.min.js'), 'utf8')
  }));
  await page.route('**/@vapi-ai/**', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'export default class{on(){}start(){}stop(){}};' }));
  await page.goto(`http://localhost:${PORT}${at}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ddRoot, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return { page, ctx, errors };
}

// Opens the modal from the nav and clears the two typed steps, leaving the caller on the
// first tap step. The nav CTA is the one entry point both pages share.
async function toFirstTapStep(page) {
  await page.locator('[data-cta="nav"]').first().click();
  await page.waitForSelector('[role="dialog"][aria-label="Book a strategy call"]', { timeout: 5000 });
  await page.fill('#bk0', 'Dr. Jane Rivera');
  await page.locator('[role="dialog"] button', { hasText: 'Continue' }).click();
  await page.fill('#bk1', 'Riverside Family Dental');
  await page.locator('[role="dialog"] button', { hasText: 'Continue' }).click();
}

const chips = page => page.locator('[role="dialog"] .dd-chips button');

const PAGES = [{ name: 'home', at: '/' }, { name: 'deep', at: '/how-it-works/' }];

for (const p of PAGES) {
  posted = null;
  const { page, ctx, errors } = await open(p.at);
  await toFirstTapStep(page);

  // ---- the three tap steps ----
  check(`${p.name}: country is a row of chips, not a dropdown`,
    await page.locator('[role="dialog"] select').count() === 0 && await chips(page).count() === 7,
    (await chips(page).allTextContents()).join(' / '));

  // The chip IS the Continue. A second button beside it would ask the same question twice.
  check(`${p.name}: a tap step offers nothing to press afterwards`,
    await page.locator('[role="dialog"] button', { hasText: /^(Continue|Submit)$/ }).count() === 0);

  const tall = await chips(page).first().boundingBox();
  check(`${p.name}: chips are a real thumb target`, tall.height >= 44, `${Math.round(tall.height)}px`);

  await chips(page).filter({ hasText: 'United States' }).click();
  check(`${p.name}: picking a country advanced on its own`,
    (await chips(page).allTextContents()).join(',') === '<200,200–500,500–1,000,1,000+',
    (await chips(page).allTextContents()).join(' / '));

  await chips(page).filter({ hasText: '500–1,000' }).click();
  check(`${p.name}: locations is a range, not a number field`,
    await page.locator('#bk4').count() === 0 && (await chips(page).allTextContents()).join(',') === '1,2,3–5,6+',
    (await chips(page).allTextContents()).join(' / '));

  await chips(page).filter({ hasText: '3–5' }).click();

  // ---- the last typed step, and the verdict ----
  check(`${p.name}: only name, practice, email and phone are typed`,
    await page.locator('[role="dialog"] input:not([type="hidden"])').count() === 3,
    'email, phone, honeypot');

  await page.fill('[role="dialog"] input[type="email"]', 'jane@riverside.com');
  await page.fill('[role="dialog"] input[type="tel"]', '+1 555 0134');
  await page.locator('[role="dialog"] button', { hasText: 'Submit' }).click();
  await page.waitForFunction(() => /You're a fit|Worth twenty minutes/.test(
    document.querySelector('[role="dialog"]')?.textContent || ''), { timeout: 5000 });

  const verdict = (await page.locator('[role="dialog"]').textContent()).replace(/\s+/g, ' ');
  check(`${p.name}: the tapped ranges drive the verdict copy`,
    verdict.includes("You're a fit.") && verdict.includes('500–1,000 calls a month'));
  check(`${p.name}: the last step is two buttons, calendar or WhatsApp`,
    await page.locator('[role="dialog"] a[href*="calendly"]').count() === 1
    && await page.locator('[role="dialog"] a[href*="wa.me"]').count() === 1);

  await page.waitForTimeout(500);
  check(`${p.name}: the lead carries the ranges as picked`,
    !!posted && posted.country === 'United States'
    && posted.monthly_call_volume === '500–1,000' && posted.locations === '3–5',
    posted ? `${posted.country} / ${posted.monthly_call_volume} / ${posted.locations}` : 'nothing posted');

  // api/notify-lead.ts flags a multi-site lead with parseInt(locations, 10) > 1, and so does
  // the verdict copy above. A range label that stops starting with its number breaks both.
  check(`${p.name}: a range still parses as a location count`,
    !!posted && parseInt(posted.locations, 10) === 3, posted ? String(parseInt(posted.locations, 10)) : '-');

  check(`${p.name}: no page errors`, errors.length === 0, errors[0] || 'none');
  await ctx.close();
}

// ---- stepping back into a tap step ----
// Back is the one route that lands someone on a question they have already answered. The
// chip has to show as chosen, and re-tapping it has to move on rather than sit there.
for (const p of PAGES) {
  const { page, ctx } = await open(p.at);
  await toFirstTapStep(page);
  await chips(page).filter({ hasText: 'Canada' }).click();
  await page.locator('[role="dialog"] button', { hasText: 'Back' }).click();

  check(`${p.name}: Back shows the answer already given`,
    await page.locator('[role="dialog"] .dd-chips button[aria-pressed="true"]').textContent() === 'Canada');

  await chips(page).filter({ hasText: 'Canada' }).click();
  check(`${p.name}: re-tapping the same chip moves on`,
    await chips(page).filter({ hasText: '<200' }).count() === 1);
  await ctx.close();
}

await browser.close();
server.close();

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
