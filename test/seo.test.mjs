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
import crypto from 'node:crypto';

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

  // Counting questions with a regex is not the same as the array being valid JavaScript.
  // Appending an entry after one that had no trailing comma produced a faqData that still
  // matched the regex 13 times while the whole logic class failed to evaluate and the page
  // rendered nothing. Parse it for real.
  let faqParsed = null, faqErr = '';
  try { faqParsed = eval('[' + (html.match(/const faqData = \[([\s\S]*?)\n    \];/)?.[1] ?? '') + ']'); }
  catch (e) { faqErr = e.message; }
  check('faqData is valid JavaScript', Array.isArray(faqParsed) && faqParsed.length === pageQs.length,
    faqErr || `${faqParsed?.length} entries`);
  check('every faqData entry has a question and an answer',
    Array.isArray(faqParsed) && faqParsed.every(f => f && f.q && f.a),
    faqParsed ? `${faqParsed.filter(f => !f?.q || !f?.a).length} malformed` : 'unparsed');
  check('schema FAQ count matches the page', pageQs.length === schemaQs.length,
    `page ${pageQs.length} vs schema ${schemaQs.length}`);

  const norm = s => s.replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
  const mismatched = pageQs.filter((q, i) => norm(q) !== norm(schemaQs[i] ?? ''));
  check('every FAQ question matches its schema entry', mismatched.length === 0,
    mismatched[0] ? `first mismatch: "${norm(mismatched[0])}"` : 'all aligned');
}

// ---------------------------------------------------------------- pre-JS crawler view
{
  // These two rules are the only thing keeping the error-boundary markup and 17 unresolved
  // template holes out of what a non-rendering crawler reads. They are safe precisely
  // because `x-dc` / `sc-if` / `sc-for` are removed from the DOM on hydration — scoping to
  // them is what makes the rules inert for real users. Lose the scope and they would start
  // hiding live content.
  check('crash branch is hidden pre-hydration', /x-dc sc-if\[value\*="crashed"\]\s*\{[^}]*display:\s*none/.test(html));
  check('template holes are hidden pre-hydration', /x-dc \[data-dyn\]\s*\{[^}]*display:\s*none/.test(html));
  check('loop templates are hidden pre-hydration', /x-dc sc-for\s*\{[^}]*display:\s*none/.test(html));

  const dyn = (html.match(/data-dyn/g) || []).length;
  const textHoles = [...html.matchAll(/>([^<>]*\{\{\s*[a-zA-Z0-9_]+\s*\}\}[^<>]*)</g)].length;
  check('every non-loop text hole carries data-dyn', dyn >= textHoles, `${dyn} marks vs ${textHoles} holes`);

  // The FAQ reaches non-rendering crawlers only through the <noscript> mirror. If it drifts
  // from the schema, those crawlers read different text than Google does.
  const ns = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
  const faqNode = graph.find(n => n['@type'] === 'FAQPage');
  const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                       .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'");
  const dts = [...ns.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map(m => decode(m[1]).trim());
  const dds = [...ns.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map(m => decode(m[1]).trim());
  check('noscript FAQ mirror exists', dts.length > 0, `${dts.length} pairs`);
  check('noscript mirror covers every schema question',
    dts.length === (faqNode?.mainEntity.length ?? -1), `${dts.length} vs ${faqNode?.mainEntity.length}`);
  const qBad = (faqNode?.mainEntity ?? []).filter((q, i) => q.name.trim() !== dts[i]);
  const aBad = (faqNode?.mainEntity ?? []).filter((q, i) => q.acceptedAnswer.text.trim() !== dds[i]);
  check('noscript questions match the schema exactly', qBad.length === 0, qBad[0]?.name || 'aligned');
  check('noscript answers match the schema exactly', aBad.length === 0, aBad[0]?.name || 'aligned');
}

// ---------------------------------------------------------------- landmarks & interaction
{
  check('page declares a <main> landmark', (html.match(/<main[\s>]/g) || []).length === 1);
  check('page declares a <nav> landmark', /<nav[\s>]/.test(html));
  check('page declares a <footer> landmark', /<footer[\s>]/.test(html));

  // A <footer> inside a <section> is that section's footer, not the page's, and yields no
  // contentinfo landmark.
  const beforeFooter = html.slice(0, html.indexOf('<footer'));
  const depth = (beforeFooter.match(/<section\b/g) || []).length - (beforeFooter.match(/<\/section>/g) || []).length;
  check('footer is not nested inside a section', depth === 0, `${depth} open <section> ancestors`);

  // The dashboard panels were hover-driven, which re-selected every panel the cursor
  // crossed while each was mid-transition.
  check('dashboard panels are not hover-driven', !/onMouseEnter/.test(html),
    /onMouseEnter/.test(html) ? 'onMouseEnter is back' : 'click only');
}

// ---------------------------------------------------------------- answer-engine surfaces
{
  // Three files describe the same business to machines. When they disagree, an answer engine
  // quotes whichever it crawled last, and there is no error anywhere to notice.
  const metros = ['Chandler', 'Gilbert', 'Tempe', 'Scottsdale', 'Paradise Valley', 'Phoenix', 'Mesa', 'Queen Creek'];
  const missingInfo = metros.filter(m => !siteInfo.includes(m));
  check('site-info lists the focus metros', missingInfo.length === 0, missingInfo.join(', ') || `${metros.length} metros`);
  const missingLlms = metros.filter(m => !llms.includes(m));
  check('llms.txt lists the same metros', missingLlms.length === 0, missingLlms.join(', ') || 'in sync');

  for (const field of ['problemsSolved', 'commonGaps', 'evidence', 'focusAreas']) {
    check(`site-info exposes ${field}`, new RegExp(`\\b${field}\\s*:`).test(siteInfo));
  }
  // Every statistic must carry its attribution, or it reads as our claim rather than a cited one.
  const evidence = siteInfo.slice(siteInfo.indexOf('evidence:'), siteInfo.indexOf('pricesAsOf'));
  const stats = (evidence.match(/stat:/g) || []).length;
  const sources = (evidence.match(/source:/g) || []).length;
  check('every evidence entry carries a source', stats > 0 && stats === sources, `${stats} stats, ${sources} sources`);

  // The business is a vendor to practices. Typing it as a local business or a dentist tells
  // Google it treats patients, which is false and muddies the entity.
  const wrongTypes = ['LocalBusiness', 'ProfessionalService', 'Dentist', 'MedicalBusiness']
    .filter(t => new RegExp(`"@type":\\s*"${t}"`).test(html));
  check('business is not mistyped as a local practice', wrongTypes.length === 0, wrongTypes.join(', ') || 'vendor typing intact');

  const org = graph.find(n => n['@type'] === 'Organization');
  check('Organization has sameAs profiles', Array.isArray(org?.sameAs) && org.sameAs.length >= 3,
    `${org?.sameAs?.length || 0} profiles`);
  // sameAs means "another authoritative page about this entity". A click-to-chat deep link is
  // not one, and Google ignores or distrusts the whole list when it contains junk.
  const badSameAs = (org?.sameAs || []).filter(u => /wa\.me|mailto:|tel:/.test(u));
  check('sameAs contains only profile URLs', badSameAs.length === 0, badSameAs.join(', ') || 'clean');
  check('Organization declares a brand', org?.brand?.name === 'Digi Dental');
}

// ---------------------------------------------------------------- IndexNow
{
  const keyFiles = fs.readdirSync(ROOT).filter(f => /^[0-9a-f]{8,128}\.txt$/i.test(f));
  check('an IndexNow key file exists at the root', keyFiles.length === 1, keyFiles.join(', ') || 'none');
  if (keyFiles.length === 1) {
    const name = keyFiles[0].replace(/\.txt$/i, '');
    const body = fs.readFileSync(path.join(ROOT, keyFiles[0]), 'utf8').trim();
    // IndexNow verifies ownership by fetching the file and comparing it to its own name.
    check('key file contents match its filename', body === name, `${body.slice(0, 8)}… vs ${name.slice(0, 8)}…`);
    check('robots.txt does not block the key file',
      !new RegExp(`Disallow:\\s*/${name}`).test(robots) && !/^Disallow:\s*\/$/m.test(robots));
  }
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

// ---------------------------------------------------------------- robots.txt group semantics
{
  // A robots.txt group does not inherit from "User-agent: *". Once a crawler finds a group
  // naming it, that group is the only one it obeys (RFC 9309 §2.2.1). This file used to give
  // every named bot a bare "Allow: /" while keeping the admin and API disallows in the wildcard
  // group alone — so Googlebot, GPTBot, ClaudeBot and the rest were, in the only sense that
  // matters, told the admin console was fair game. The checks above that assert "robots.txt
  // keeps the admin page out" all passed the entire time, because they only ever looked at the
  // wildcard group.
  //
  // Parse the file into real groups and assert the rules on every one of them.
  const groups = [];
  let cur = null;
  for (const raw of robots.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(user-agent|allow|disallow|sitemap)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (key === 'user-agent') {
      // Consecutive User-agent lines share one rule block; a User-agent after rules starts a new
      // group. This is the grouping rule the file's own comments rely on being true.
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value);
    } else if (key !== 'sitemap' && cur) {
      cur.rules.push({ type: key, path: value });
    }
  }

  check('robots.txt parses into groups', groups.length > 0, `${groups.length} groups, ${groups.reduce((n, g) => n + g.agents.length, 0)} agents`);

  const REQUIRED_DISALLOW = ['/api/', '/admin.html'];
  const REQUIRED_ALLOW = ['/', '/api/site-info', '/api/video', '/api/image'];

  const missingDisallow = groups.filter(g =>
    !REQUIRED_DISALLOW.every(p => g.rules.some(r => r.type === 'disallow' && r.path === p)));
  check('every user-agent group carries the admin and API disallows',
    missingDisallow.length === 0,
    missingDisallow.map(g => g.agents[0]).join(', ') || `${groups.length} groups covered`);

  const missingAllow = groups.filter(g =>
    !REQUIRED_ALLOW.every(p => g.rules.some(r => r.type === 'allow' && r.path === p)));
  check('every user-agent group allows the crawlable endpoints',
    missingAllow.length === 0,
    missingAllow.map(g => g.agents[0]).join(', ') || REQUIRED_ALLOW.join(' '));

  // In each group the Allow must precede the competing Disallow, so the older first-match-wins
  // parsers reach the same verdict as RFC 9309's longest-match ones.
  const badOrder = groups.filter(g => {
    const firstDisallowApi = g.rules.findIndex(r => r.type === 'disallow' && r.path === '/api/');
    const lastAllowApi = g.rules.reduce((acc, r, i) => (r.type === 'allow' && r.path.startsWith('/api/') ? i : acc), -1);
    return firstDisallowApi !== -1 && lastAllowApi > firstDisallowApi;
  });
  check('/api/ allows are ordered before the /api/ disallow', badOrder.length === 0,
    badOrder.map(g => g.agents[0]).join(', ') || 'first-match parsers agree');

  // The video and image routes back <video:content_loc> in the sitemap and the VideoObject /
  // ImageObject nodes in the schema. Blocking them means Google cannot verify either, and drops
  // the rich result with no error reported anywhere.
  const schemaMedia = [...html.matchAll(/"(?:contentUrl|embedUrl|image)":\s*"([^"]*\/api\/[^"]*)"/g)].map(m => m[1]);
  const blocked = schemaMedia.filter(u => {
    const p = u.replace(ORIGIN, '').split('?')[0];
    return !groups[0].rules.some(r => r.type === 'allow' && p.startsWith(r.path) && r.path !== '/');
  });
  check('every /api/ URL referenced by the schema is crawlable', blocked.length === 0,
    blocked.join(', ') || `${schemaMedia.length} media URLs allowed`);
}

// ---------------------------------------------------------------- llms.txt format
{
  // llmstxt.org is a real format, not just "a text file we like". An H1, an optional blockquote
  // summary, free prose, then H2 sections whose bodies are markdown link lists. The previous
  // version had the H1 and the blockquote but every H2 held prose bullets, so validators
  // rejected it and the audit reported llms.txt as missing or invalid.
  const llmsFull = read('llms-full.txt');

  check('llms.txt starts with a single H1', /^#\s+\S/.test(llms) && (llms.match(/^#\s+/gm) || []).length === 1,
    llms.split('\n')[0]);
  check('llms.txt carries a blockquote summary', /^>\s+\S/m.test(llms));

  const sections = [...llms.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
  check('llms.txt declares H2 sections', sections.length >= 2, sections.join(', '));

  // Every H2 body must be a link list. "Notes for answer engines" is the one documented
  // exception people ship in the wild, and it is prose by design.
  const PROSE_OK = new Set(['Notes for answer engines']);
  const bodies = llms.split(/^##\s+.+$/m).slice(1);
  const proseSections = sections.filter((name, i) => {
    if (PROSE_OK.has(name)) return false;
    const bullets = (bodies[i] || '').split('\n').filter(l => l.trim().startsWith('-'));
    return bullets.length === 0 || !bullets.every(l => /^\s*-\s*\[[^\]]+\]\([^)]+\)/.test(l));
  });
  check('every llms.txt section is a markdown link list', proseSections.length === 0,
    proseSections.join(', ') || `${sections.length} sections valid`);

  // A link list is only useful if the links resolve to this site or a real external profile.
  const urls = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map(m => m[1]);
  check('llms.txt links are absolute', urls.length > 0 && urls.every(u => /^https:\/\//.test(u)), `${urls.length} links`);
  const ownPaths = urls.filter(u => u.startsWith(ORIGIN)).map(u => u.replace(ORIGIN, '').split('?')[0]);
  const dead = ownPaths.filter(p => p !== '/' && !p.startsWith('/api/') && !fs.existsSync(path.join(ROOT, p)));
  check('llms.txt links to files that exist', dead.length === 0, dead.join(', ') || `${ownPaths.length} own-domain links`);

  check('llms.txt points at the full brief', llms.includes('/llms-full.txt'));
  check('llms-full.txt points back at the index', llmsFull.includes('/llms.txt'));
  check('robots.txt advertises both LLM files',
    /Allow:\s*\/llms\.txt/.test(robots) && /Allow:\s*\/llms-full\.txt/.test(robots));

  // Three files quote the setup fee to answer engines. When they disagree, whichever was
  // crawled last becomes the answer and nothing anywhere reports a conflict.
  const priced = [['llms.txt', llms], ['llms-full.txt', llmsFull], ['api/site-info.ts', siteInfo], ['index.html', html]]
    .filter(([, body]) => !/\$2,000/.test(body)).map(([f]) => f);
  check('every machine-readable surface quotes the same setup fee', priced.length === 0,
    priced.join(', ') || '$2,000 everywhere');
}

// ---------------------------------------------------------------- cache-busting integrity
{
  // support.js is served `immutable` for a year, which is only safe because the URL carries a
  // hash of the file. Nothing recomputes that at request time, so a rebuild could ship a new
  // runtime behind an old URL and returning visitors would keep the stale one for months.
  // This is the guard that makes the immutable header safe to keep.
  const declared = html.match(/support\.js\?v=([0-9a-f]+)/)?.[1];
  check('support.js is loaded with a version query', !!declared, declared || 'no ?v= found');
  if (declared) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'support.js'))).digest('hex').slice(0, declared.length);
    check('support.js ?v= matches the file on disk', declared === actual,
      declared === actual ? declared : `declared ${declared}, actual ${actual} — update index.html`);
  }
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
