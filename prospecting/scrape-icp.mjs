import { chromium } from 'playwright';
import fs from 'fs';

const SITES = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// Subpage discovery patterns, in priority order
const PAGE_PATTERNS = [
  { key: 'team',    re: /(meet|our)?[-_/]?(team|doctors?|dentists?|staff|about[-_]?us|our[-_]?dentist)/i },
  { key: 'offers',  re: /(new[-_]?patient|special|offer|promo|deal|coupon)/i },
  { key: 'contact', re: /(contact|location|hours|appointment|schedule|office)/i },
  { key: 'services',re: /(service|treatment|sedation|implant|invisalign|procedure)/i },
];

const RX = {
  phone: /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g,
  doctor: /\bDr[.s]?\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,2})/g,
  money: /\$\s?\d{2,4}(?:\.\d{2})?/g,
};

const KW = {
  sedation:  /\b(sedation|iv sedation|oral sedation|nitrous|sleep dentistry|laughing gas)\b/i,
  implants:  /\b(dental implants?|implant placement|all[- ]on[- ]4|full mouth reconstruct)\b/i,
  invisalign:/\b(invisalign|clear aligner|clearcorrect|ortho)\b/i,
  veneers:   /\b(veneers|smile makeover|cosmetic dentistry)\b/i,
  emergency: /\b(emergency dent|same[- ]day)\b/i,
  dso:       /\b(our locations|all locations|\d+ locations|corporate|dental group of|supported by|management services|DSO|find a location|other offices)\b/i,
  newpatient:/\b(new patient special|new[- ]patient offer|free consult|complimentary consult|gift card|welcome offer|\$\d+ (exam|cleaning|new patient))\b/i,
  growth:    /\b(now open|newly opened|new location|coming soon|welcome dr|now welcoming|recently expanded|our newest|grand opening|now accepting new patients|second location)\b/i,
  saturday:  /\bsat(urday)?\b/i,
  sunday:    /\bsun(day)?\b/i,
  closed:    /\bclosed\b/i,
  voicemail: /\b(voicemail|leave a message|after hours|answering service)\b/i,
};

function normPhone(m) { return m.replace(/\D/g, '').replace(/^1/, ''); }

async function scrapeSite(browser, site) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  const out = { name: site.name, url: site.url, city: site.city, pages: {}, error: null };
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);

    const home = await page.evaluate(() => document.body.innerText);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({ href: a.href, text: a.innerText.trim() }))
    );
    out.pages.home = home;
    out.title = await page.title();

    const origin = new URL(site.url).origin;
    const picked = {};
    for (const { key, re } of PAGE_PATTERNS) {
      const hit = links.find(l => {
        try { return new URL(l.href).origin === origin && (re.test(l.href) || re.test(l.text)); }
        catch { return false; }
      });
      if (hit && !Object.values(picked).includes(hit.href)) picked[key] = hit.href;
    }
    out.subpages = picked;

    for (const [key, href] of Object.entries(picked)) {
      try {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        out.pages[key] = await page.evaluate(() => document.body.innerText);
      } catch (e) { out.pages[key] = ''; }
    }
    await page.close();
  } catch (e) {
    out.error = String(e).slice(0, 200);
  }
  await ctx.close();
  return out;
}

function analyze(site) {
  const all = Object.values(site.pages).join('\n\n');
  const phones = [...new Set([...all.matchAll(RX.phone)].map(m => normPhone(m[0])))]
    .filter(p => p.length === 10 && !/^(800|888|877|866|855|844|833)/.test(p));
  const doctors = [...new Set([...all.matchAll(RX.doctor)].map(m => m[1].trim().replace(/[.,]$/, '')))]
    .filter(n => n.length > 2 && !/^(Google|Who|The|Your|Our|And|Call|Visit)/i.test(n));
  const flags = {};
  for (const [k, re] of Object.entries(KW)) flags[k] = re.test(all);
  const money = [...new Set([...all.matchAll(RX.money)].map(m => m[0].replace(/\s/g, '')))].slice(0, 12);
  return { ...site, pages: undefined, textLen: all.length, phones, doctors, flags, money,
           hoursSnippet: (all.match(/[^\n]*\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[^\n]{0,120}/gi) || []).slice(0, 12) };
}

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  headless: true,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  proxy: PROXY ? { server: PROXY } : undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const results = [];
for (const site of SITES) {
  process.stderr.write(`-> ${site.name}\n`);
  const raw = await scrapeSite(browser, site);
  results.push(analyze(raw));
  await new Promise(r => setTimeout(r, 1200)); // be polite
}
await browser.close();
fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 2));
console.log('done', results.length);
