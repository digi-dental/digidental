/**
 * SEO / AEO regression tests.
 *
 * These are static-analysis checks over the files that actually ship. They exist because SEO
 * decays silently: nothing throws when a canonical URL drifts, when the FAQ on the page stops
 * matching the FAQ in the schema, or when a new <img> lands without an alt. Google penalises
 * exactly those mismatches, and you find out weeks later in a rankings chart.
 *
 * Run: node test/seo.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const html = read('index.html');
const html404 = read('404.html');
const sitemap = read('sitemap.xml');
const robots = read('robots.txt');
const llms = read('llms.txt');
const siteInfo = read('api/site-info.ts');

const ORIGIN = 'https://www.digidental.us';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- canonical identity
{
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const ogUrl = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1];
  const loc = sitemap.match(/<loc>([^<]+)<\/loc>/)?.[1];
  const robotsMap = robots.match(/^Sitemap:\s*(\S+)/m)?.[1];
  const siteConst = siteInfo.match(/const SITE = '([^']+)'/)?.[1];

  check('canonical is the custom domain', canonical === `${ORIGIN}/`, canonical);
  check('og:url agrees with canonical', ogUrl === canonical, ogUrl);
  check('sitemap <loc> agrees with canonical', loc === canonical, loc);
  check('robots.txt Sitemap: agrees', robotsMap === `${ORIGIN}/sitemap.xml`, robotsMap);
  check('api/site-info SITE agrees', siteConst === ORIGIN, siteConst);

  // The deployment host serves byte-identical content. If it reappears in a URL we are
  // telling crawlers the real site lives somewhere else.
  const stray = [['index.html', html], ['404.html', html404], ['sitemap.xml', sitemap],
                 ['robots.txt', robots], ['llms.txt', llms], ['api/site-info.ts', siteInfo]]
    .filter(([, body]) => /digidental\.vercel\.app/.test(body)).map(([f]) => f);
  check('no digidental.vercel.app left in any shipped file', stray.length === 0, stray.join(', ') || 'clean');
}

// ---------------------------------------------------------------- structured data
let graph;
{
  const raw = html.match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/)?.[1];
  let parsed = null, err = '';
  try { parsed = JSON.parse(raw); } catch (e) { err = e.message; }
  check('JSON-LD parses', parsed !== null, err || `${parsed?.['@graph']?.length} nodes`);
  graph = parsed?.['@graph'] ?? [];

  const ids = new Set(graph.filter(n => n['@id']).map(n => n['@id']));
  const refs = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (Object.keys(o).length === 1 && o['@id']) refs.push(o['@id']);
      Object.values(o).forEach(walk);
    }
  })(graph);
  const dangling = refs.filter(r => r.startsWith(`${ORIGIN}/#`) && !ids.has(r));
  check('every internal @id reference resolves', dangling.length === 0, dangling.join(', ') || `${refs.length} refs`);

  const types = graph.map(n => n['@type']);
  for (const t of ['Organization', 'WebSite', 'WebPage', 'Service', 'FAQPage', 'Person', 'VideoObject', 'ImageObject']) {
    check(`graph contains ${t}`, types.includes(t), types.join(', '));
  }

  // Google drops a VideoObject silently if any of these is absent.
  const vids = graph.filter(n => n['@type'] === 'VideoObject');
  const incomplete = vids.filter(v => !v.name || !v.description || !v.thumbnailUrl || !v.uploadDate);
  check('every VideoObject has the fields Google requires', incomplete.length === 0,
    incomplete.map(v => v['@id']).join(', ') || `${vids.length} videos complete`);
}

// ---------------------------------------------------------------- FAQ drift
{
  // The page renders FAQs from faqData in the component; the schema is a separate hand-written
  // copy in <head>. Marking up an answer the visitor cannot see is a structured-data violation,
  // so the two must stay identical.
  const block = html.match(/const faqData = \[([\s\S]*?)\n\s*\];/)?.[1]
             ?? html.match(/faqData = \[([\s\S]*?)\n\s*\];/)?.[1] ?? '';
  const pageQs = [...block.matchAll(/\{\s*q:\s*(['"])([\s\S]*?)\1\s*,/g)].map(m => m[2]);
  const faqNode = graph.find(n => n['@type'] === 'FAQPage');
  const schemaQs = (faqNode?.mainEntity ?? []).map(q => q.name);

  check('FAQ questions found on the page', pageQs.length > 0, `${pageQs.length} on page`);
  check('schema FAQ count matches the page', pageQs.length === schemaQs.length,
    `page ${pageQs.length} vs schema ${schemaQs.length}`);

  const norm = s => s.replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
  const mismatched = pageQs.filter((q, i) => norm(q) !== norm(schemaQs[i] ?? ''));
  check('every FAQ question matches its schema entry', mismatched.length === 0,
    mismatched[0] ? `first mismatch: "${norm(mismatched[0])}"` : 'all aligned');
}

// ---------------------------------------------------------------- headings
{
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map(m => Number(m[1]));
  const h1s = levels.filter(l => l === 1).length;
  check('exactly one <h1>', h1s === 1, `${h1s} found`);

  let skipped = null;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) { skipped = `h${levels[i - 1]} -> h${levels[i]}`; break; }
  }
  check('no skipped heading levels', skipped === null, skipped || levels.map(l => `h${l}`).join(' '));
}

// ---------------------------------------------------------------- images
{
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
  check('page has images to check', imgs.length > 0, `${imgs.length} <img>`);

  const noAlt = imgs.filter(t => !/\salt=/.test(t));
  check('every <img> declares alt', noAlt.length === 0, noAlt[0]?.slice(0, 80) || `${imgs.length} ok`);

  // Intrinsic dimensions reserve space before the bytes arrive; without them the layout
  // jumps when each sprite loads, which is exactly what CLS measures. The dashboard captures
  // are the one case where the size genuinely is not knowable at author time — their frames
  // reserve space with an aspect-ratio instead, overwritten with the real ratio on load.
  const fixed = imgs.filter(t => !/\{\{/.test(t));
  const noDims = fixed.filter(t => !(/\swidth=/.test(t) && /\sheight=/.test(t)) && !/width:\d+px/.test(t));
  check('every fixed-size <img> reserves layout space', noDims.length === 0, noDims[0]?.slice(0, 80) || `${fixed.length} sized`);
  check('runtime-sized images reserve space via aspect-ratio',
    /\.dd-dash-scroll img\{[^}]*aspect-ratio:var\(--ar/.test(html.replace(/\n\s*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'dd-dash-scroll img has an --ar fallback');

  // One eager image (the nav mark, above the fold). Everything else defers.
  const eager = imgs.filter(t => !/loading="lazy"/.test(t) && !/\{\{/.test(t));
  check('at most one eagerly-loaded image', eager.length <= 1,
    `${eager.length} eager` + (eager.length ? `: ${eager[0].slice(0, 60)}` : ''));

  const localSrcs = [...html.matchAll(/<img[^>]*src="(?!https?:|\/api\/|\{\{)([^"]+)"/g)].map(m => m[1]);
  const missing = localSrcs.filter(s => !fs.existsSync(path.join(ROOT, s.replace(/^\//, ''))));
  check('every local image file exists', missing.length === 0, missing.join(', ') || `${localSrcs.length} resolved`);

  // Sprites render at <=100px. Shipping a 1024px master wastes ~950KB of the page budget.
  const oversized = fs.readdirSync(path.join(ROOT, 'uploads'))
    .filter(f => f.endsWith('.png'))
    .filter(f => fs.statSync(path.join(ROOT, 'uploads', f)).size > 60_000);
  check('no sprite exceeds 60KB', oversized.length === 0, oversized.join(', ') || 'all compressed');
}

// ---------------------------------------------------------------- social / share
{
  const need = ['og:type', 'og:site_name', 'og:url', 'og:title', 'og:description',
                'og:image', 'og:image:width', 'og:image:height', 'og:image:alt', 'og:locale'];
  const missing = need.filter(p => !new RegExp(`property="${p}"`).test(html));
  check('Open Graph card is complete', missing.length === 0, missing.join(', ') || `${need.length} tags`);

  const tw = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'];
  const twMissing = tw.filter(p => !new RegExp(`name="${p}"`).test(html));
  check('Twitter card is complete', twMissing.length === 0, twMissing.join(', ') || `${tw.length} tags`);

  // A declared size that does not match the file makes the card render wrong or get dropped.
  const w = Number(html.match(/property="og:image:width" content="(\d+)"/)?.[1]);
  const h = Number(html.match(/property="og:image:height" content="(\d+)"/)?.[1]);
  const buf = fs.readFileSync(path.join(ROOT, 'og-image.png'));
  const realW = buf.readUInt32BE(16), realH = buf.readUInt32BE(20);
  check('og:image dimensions match the real file', w === realW && h === realH, `declared ${w}x${h}, actual ${realW}x${realH}`);
}

// ---------------------------------------------------------------- crawl directives
{
  check('robots.txt keeps the admin page out', /^Disallow:\s*\/admin\.html/m.test(robots));
  check('robots.txt keeps the API out', /^Disallow:\s*\/api\//m.test(robots));
  check('robots.txt still exposes /api/site-info', /^Allow:\s*\/api\/site-info/m.test(robots));
  check('404 page is noindex', /<meta name="robots" content="noindex/.test(html404));
  check('homepage is indexable', /<meta name="robots" content="index, follow/.test(html));

  const bots = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot', 'Applebot-Extended'];
  const absent = bots.filter(b => !new RegExp(`User-agent:\\s*${b}`, 'i').test(robots));
  check('answer-engine crawlers are named explicitly', absent.length === 0, absent.join(', ') || `${bots.length} allowed`);
}

// ---------------------------------------------------------------- sitemap
{
  const opens = (sitemap.match(/<url>/g) || []).length;
  const closes = (sitemap.match(/<\/url>/g) || []).length;
  check('sitemap tags balance', opens === closes && opens > 0, `${opens} <url>`);
  check('sitemap declares the video namespace', /xmlns:video=/.test(sitemap));
  const vids = (sitemap.match(/<video:video>/g) || []).length;
  const schemaVids = graph.filter(n => n['@type'] === 'VideoObject').length;
  check('sitemap lists the same videos as the schema', vids === schemaVids, `sitemap ${vids}, schema ${schemaVids}`);
  const lastmod = sitemap.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
  check('lastmod is a valid ISO date', /^\d{4}-\d{2}-\d{2}$/.test(lastmod || ''), lastmod);
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
