/**
 * SEO / AEO regression tests.
 *
 * These are static-analysis checks over the files that actually ship. They exist because SEO
 * decays silently: nothing throws when a canonical URL drifts, when the FAQ on the page stops
 * matching the FAQ in the schema, or when a new <img> lands without an alt. Google penalises
 * exactly those mismatches, and you find out weeks later in a rankings chart.
 *
 * The site is two documents now — `/` and `/how-it-works/` — sharing one stylesheet
 * (dd.css) and one logic file (dd-logic.js). Most checks therefore run over BOTH pages, and
 * a handful of new ones exist purely to catch the failure modes a split introduces: a
 * canonical pointing at the wrong page, the two pages losing their links to each other, a
 * subdirectory page shipping a relative asset path that resolves under /how-it-works/.
 *
 * Run: node test/seo.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const home = read('index.html');
const deep = read('how-it-works/index.html');
const css = read('dd.css');
const logic = read('dd-logic.js');
const html404 = read('404.html');
const sitemap = read('sitemap.xml');
const robots = read('robots.txt');
const llms = read('llms.txt');
const siteInfo = read('api/site-info.ts');

const ORIGIN = 'https://www.digidental.us';
const DEEP_PATH = '/how-it-works/';
const CASE_URL = 'https://medium.com/@bennyco/the-real-cost-of-a-missed-call-at-your-dental-practice-and-why-voicemail-isnt-fixing-it-5ae0fdf3ac39';

// Every page-level check runs against both documents, so a regression cannot hide on
// whichever page the author was not looking at.
const PAGES = [
  { name: 'home', html: home, url: `${ORIGIN}/`, file: 'index.html' },
  { name: 'deep', html: deep, url: `${ORIGIN}${DEEP_PATH}`, file: 'how-it-works/index.html' },
];

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const graphOf = html => {
  const raw = html.match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/)?.[1];
  try { return JSON.parse(raw)['@graph'] ?? []; } catch { return null; }
};

// ---------------------------------------------------------------- canonical identity
{
  for (const p of PAGES) {
    const canonical = p.html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    const ogUrl = p.html.match(/<meta property="og:url" content="([^"]+)"/)?.[1];
    check(`${p.name}: canonical is its own URL on the custom domain`, canonical === p.url, canonical);
    check(`${p.name}: og:url agrees with canonical`, ogUrl === canonical, ogUrl);
    // Two pages means two chances to paste the wrong hreflang. Both must self-reference.
    const hreflangs = [...p.html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)"/g)].map(m => m[1]);
    check(`${p.name}: every hreflang points at this page`, hreflangs.length === 2 && hreflangs.every(h => h === p.url),
      hreflangs.join(', '));
  }

  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  check('sitemap lists exactly the two indexable pages',
    locs.length === 2 && locs[0] === `${ORIGIN}/` && locs[1] === `${ORIGIN}${DEEP_PATH}`, locs.join(', '));
  check('robots.txt Sitemap: agrees', robots.match(/^Sitemap:\s*(\S+)/m)?.[1] === `${ORIGIN}/sitemap.xml`);
  check('api/site-info SITE agrees', siteInfo.match(/const SITE = '([^']+)'/)?.[1] === ORIGIN);

  // The deployment host serves byte-identical content. If it reappears in a URL we are
  // telling crawlers the real site lives somewhere else.
  const stray = [['index.html', home], ['how-it-works/index.html', deep], ['404.html', html404],
                 ['sitemap.xml', sitemap], ['robots.txt', robots], ['llms.txt', llms],
                 ['api/site-info.ts', siteInfo], ['dd-logic.js', logic]]
    .filter(([, body]) => /digidental\.vercel\.app/.test(body)).map(([f]) => f);
  check('no digidental.vercel.app left in any shipped file', stray.length === 0, stray.join(', ') || 'clean');
}

// ---------------------------------------------------------------- structured data
const graphs = {};
{
  for (const p of PAGES) {
    const g = graphOf(p.html);
    check(`${p.name}: JSON-LD parses`, g !== null, g ? `${g.length} nodes` : 'parse error');
    graphs[p.name] = g ?? [];

    const ids = new Set(graphs[p.name].filter(n => n['@id']).map(n => n['@id']));
    const refs = [];
    (function walk(o) {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (Object.keys(o).length === 1 && o['@id']) refs.push(o['@id']);
        Object.values(o).forEach(walk);
      }
    })(graphs[p.name]);
    // Only same-origin ids have to resolve inside this page's graph. The case study's @id is
    // the Medium URL, which is deliberately an external reference.
    const dangling = refs.filter(r => r.startsWith(ORIGIN) && !ids.has(r));
    check(`${p.name}: every internal @id reference resolves`, dangling.length === 0,
      dangling.join(', ') || `${refs.length} refs`);
  }

  // Both pages describe the same business, so both carry the entity nodes. Only the deep page
  // carries the FAQ and the breadcrumb — marking up an FAQ the visitor cannot see is a
  // structured-data violation, which is exactly what would happen if FAQPage stayed on `/`.
  const shared = ['Organization', 'WebSite', 'WebPage', 'Service', 'Person', 'Article', 'VideoObject', 'ImageObject'];
  for (const p of PAGES) {
    const types = graphs[p.name].map(n => n['@type']);
    const missing = shared.filter(t => !types.includes(t));
    check(`${p.name}: graph carries the shared entity nodes`, missing.length === 0, missing.join(', ') || types.join(', '));
  }
  check('FAQPage is declared only on the page that renders the FAQ',
    !graphs.home.some(n => n['@type'] === 'FAQPage') && graphs.deep.some(n => n['@type'] === 'FAQPage'));
  check('deep page declares a BreadcrumbList', graphs.deep.some(n => n['@type'] === 'BreadcrumbList'));
  check('home page declares no BreadcrumbList', !graphs.home.some(n => n['@type'] === 'BreadcrumbList'));

  // The entity nodes must be identical across pages or Google sees two organisations.
  for (const id of ['#organization', '#website', '#service', '#founder', '#logo']) {
    const a = graphs.home.find(n => n['@id'] === `${ORIGIN}/${id}`);
    const b = graphs.deep.find(n => n['@id'] === `${ORIGIN}/${id}`);
    check(`${id} is byte-identical on both pages`, !!a && JSON.stringify(a) === JSON.stringify(b),
      !a ? 'missing on home' : (!b ? 'missing on deep' : 'in sync'));
  }

  // Google drops a VideoObject silently if any of these is absent.
  for (const p of PAGES) {
    const vids = graphs[p.name].filter(n => n['@type'] === 'VideoObject');
    const incomplete = vids.filter(v => !v.name || !v.description || !v.thumbnailUrl || !v.uploadDate);
    check(`${p.name}: every VideoObject has the fields Google requires`, incomplete.length === 0,
      incomplete.map(v => v['@id']).join(', ') || `${vids.length} complete`);
  }

  // Each clip is declared on the page it actually plays on, or the markup describes a video
  // that is not there.
  check('the overview clip is declared on the home page',
    graphs.home.some(n => n['@id'] === `${ORIGIN}/#video-overview`) && home.includes('data-clip="vsl"'));
  check('the recorded call is declared on the deep page',
    graphs.deep.some(n => n['@id'] === `${ORIGIN}/#video-demo`) && deep.includes('data-clip="demo_recording"'));

  // The business is a vendor to practices. Typing it as a local business or a dentist tells
  // Google it treats patients, which is false and muddies the entity.
  for (const p of PAGES) {
    const wrong = ['LocalBusiness', 'ProfessionalService', 'Dentist', 'MedicalBusiness']
      .filter(t => new RegExp(`"@type":\\s*"${t}"`).test(p.html));
    check(`${p.name}: business is not mistyped as a local practice`, wrong.length === 0,
      wrong.join(', ') || 'vendor typing intact');
  }

  const org = graphs.home.find(n => n['@type'] === 'Organization');
  check('Organization has sameAs profiles', Array.isArray(org?.sameAs) && org.sameAs.length >= 3,
    `${org?.sameAs?.length || 0} profiles`);
  // sameAs means "another authoritative page about this entity". A click-to-chat deep link is
  // not one, and Google ignores or distrusts the whole list when it contains junk.
  const badSameAs = (org?.sameAs || []).filter(u => /wa\.me|mailto:|tel:/.test(u));
  check('sameAs contains only profile URLs', badSameAs.length === 0, badSameAs.join(', ') || 'clean');
  check('Organization declares a brand', org?.brand?.name === 'Digi Dental');
}

// ---------------------------------------------------------------- the cited case study
{
  // The one Digi Dental document that lives off this domain. It is the site's only external
  // corroboration, so it has to be reachable from the pages, declared in the graph, and
  // described the same way in every machine-readable surface. It also has to keep saying it
  // is ours — calling our own analysis "press" or an "independent study" would be a lie the
  // page's whole credibility argument cannot afford.
  check('the case study URL lives in exactly one place in the source',
    (logic.match(new RegExp(CASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1,
    'dd-logic.js CASE_STUDY');
  check('neither page hard-codes the case study URL in its markup',
    !/<a[^>]+href="https:\/\/medium\.com/.test(home) && !/<a[^>]+href="https:\/\/medium\.com/.test(deep),
    'both link via {{ caseStudyUrl }}');

  for (const p of PAGES) {
    const article = graphs[p.name].find(n => n['@type'] === 'Article');
    check(`${p.name}: the Article node points at the Medium URL`, article?.['@id'] === CASE_URL && article?.url === CASE_URL);
    check(`${p.name}: the Article is authored by the founder entity`,
      article?.author?.['@id'] === `${ORIGIN}/#founder`, JSON.stringify(article?.author));
    const page = graphs[p.name].find(n => n['@type'] === 'WebPage');
    check(`${p.name}: the page cites the case study`, page?.citation?.['@id'] === CASE_URL);
    check(`${p.name}: markup links to the case study`, p.html.includes('{{ caseStudyUrl }}'));
  }

  check('the founder entity lists the Medium profile in sameAs',
    (graphs.home.find(n => n['@type'] === 'Person')?.sameAs || []).includes('https://medium.com/@bennyco'));
  check('llms.txt carries the case study', llms.includes(CASE_URL));
  check('api/site-info carries the case study', siteInfo.includes(CASE_URL));
  // Self-published, and every surface has to say so.
  check('llms.txt attributes the case study to us, not to the press',
    /not press coverage/i.test(llms) && /founder's byline/i.test(llms));
  check('api/site-info flags the case study as self-published',
    /selfPublished:\s*true/.test(siteInfo) && /not press coverage/i.test(siteInfo));
  check('the deep page says in its own copy that the case study is ours',
    /not press coverage or an independent industry study/i.test(deep));
}

// ---------------------------------------------------------------- FAQ drift
{
  // faqData lives in dd-logic.js and is rendered by a loop; the schema in the deep page's
  // <head> and the <noscript> mirror below it are separate hand-written copies. All three
  // must stay identical: marking up an answer the visitor cannot see is a structured-data
  // violation, and the mirror is the only way a non-rendering crawler reads the FAQ at all.
  const block = logic.match(/const faqData = \[([\s\S]*?)\n    \];/)?.[1] ?? '';
  const pageQs = [...block.matchAll(/\{\s*q:\s*(['"])([\s\S]*?)\1\s*,/g)].map(m => m[2]);
  const faqNode = graphs.deep.find(n => n['@type'] === 'FAQPage');
  const schemaQs = (faqNode?.mainEntity ?? []).map(q => q.name);

  check('faqData is found in dd-logic.js', pageQs.length > 0, `${pageQs.length} questions`);

  // Counting questions with a regex is not the same as the array being valid JavaScript.
  // Appending an entry after one that had no trailing comma produced a faqData that still
  // matched the regex while the whole logic class failed to evaluate and the page rendered
  // nothing. Parse it for real.
  let faqParsed = null, faqErr = '';
  try { faqParsed = eval('[' + block + ']'); } catch (e) { faqErr = e.message; }
  check('faqData is valid JavaScript', Array.isArray(faqParsed) && faqParsed.length === pageQs.length,
    faqErr || `${faqParsed?.length} entries`);
  check('every faqData entry has a question and an answer',
    Array.isArray(faqParsed) && faqParsed.every(f => f && f.q && f.a),
    faqParsed ? `${faqParsed.filter(f => !f?.q || !f?.a).length} malformed` : 'unparsed');
  check('schema FAQ count matches faqData', pageQs.length === schemaQs.length,
    `faqData ${pageQs.length} vs schema ${schemaQs.length}`);

  const norm = s => s.replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
  const mismatched = pageQs.filter((q, i) => norm(q) !== norm(schemaQs[i] ?? ''));
  check('every FAQ question matches its schema entry', mismatched.length === 0,
    mismatched[0] ? `first mismatch: "${norm(mismatched[0])}"` : 'all aligned');

  // llms.txt republishes the same answers to answer engines; a stale copy there is a
  // contradiction an engine will happily quote.
  const missingFromLlms = (faqParsed ?? []).filter(f => !llms.includes(f.q));
  check('llms.txt republishes every FAQ question', missingFromLlms.length === 0,
    missingFromLlms[0]?.q || `${faqParsed?.length} questions`);
}

// ---------------------------------------------------------------- pre-JS crawler view
{
  // These three rules are the only thing keeping the error-boundary markup and the unresolved
  // template holes out of what a non-rendering crawler reads. They are safe precisely because
  // `x-dc` / `sc-if` / `sc-for` are removed from the DOM on hydration — scoping to them is
  // what makes the rules inert for real users. Lose the scope and they would start hiding
  // live content. They live in dd.css, which is linked from the static head of both pages
  // and is therefore in force during the raw pass.
  check('crash branch is hidden pre-hydration', /x-dc sc-if\[value\*="crashed"\]\s*\{[^}]*display:\s*none/.test(css));
  check('template holes are hidden pre-hydration', /x-dc \[data-dyn\]\s*\{[^}]*display:\s*none/.test(css));
  check('loop templates are hidden pre-hydration', /x-dc sc-for\s*\{[^}]*display:\s*none/.test(css));

  for (const p of PAGES) {
    check(`${p.name}: links the shared stylesheet`, /<link rel="stylesheet" href="\/dd\.css">/.test(p.html));
    check(`${p.name}: loads the shared logic`, /<script src="\/dd-logic\.js"><\/script>/.test(p.html));
    check(`${p.name}: builds its component from the shared factory`,
      /const Component = DDLogic\.create\(DCLogic\);/.test(p.html));
    check(`${p.name}: declares which page it is`, /<html lang="en" data-page="(home|deep)">/.test(p.html));

    const dyn = (p.html.match(/data-dyn/g) || []).length;
    const textHoles = [...p.html.matchAll(/>([^<>]*\{\{\s*[a-zA-Z0-9_]+\s*\}\}[^<>]*)</g)].length;
    check(`${p.name}: every non-loop text hole carries data-dyn`, dyn >= textHoles, `${dyn} marks vs ${textHoles} holes`);
  }

  // The FAQ reaches non-rendering crawlers only through the <noscript> mirror on the deep
  // page. If it drifts from the schema, those crawlers read different text than Google does.
  const ns = deep.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
  const faqNode = graphs.deep.find(n => n['@type'] === 'FAQPage');
  const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                       .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'");
  const dts = [...ns.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map(m => decode(m[1]).trim());
  const dds = [...ns.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map(m => decode(m[1]).trim());
  check('noscript FAQ mirror exists on the deep page', dts.length > 0, `${dts.length} pairs`);
  check('the home page carries no orphaned FAQ mirror', !/<noscript>/.test(home));
  check('noscript mirror covers every schema question',
    dts.length === (faqNode?.mainEntity.length ?? -1), `${dts.length} vs ${faqNode?.mainEntity.length}`);
  const qBad = (faqNode?.mainEntity ?? []).filter((q, i) => q.name.trim() !== dts[i]);
  const aBad = (faqNode?.mainEntity ?? []).filter((q, i) => q.acceptedAnswer.text.trim() !== dds[i]);
  check('noscript questions match the schema exactly', qBad.length === 0, qBad[0]?.name || 'aligned');
  check('noscript answers match the schema exactly', aBad.length === 0, aBad[0]?.name || 'aligned');
}

// ---------------------------------------------------------------- internal linking
{
  // A two-page site only works if the pages actually reach each other. The home page's whole
  // job is to hand researchers to the deep page; the deep page has to hand its authority
  // back. Both directions are load-bearing for crawl and for conversion, and both are one
  // careless edit from disappearing.
  const homeToDeep = (home.match(/href="\/how-it-works\//g) || []).length;
  check('home links to the deep page', homeToDeep >= 4, `${homeToDeep} links`);
  check('home links to the deep page from its hero', /data-cta="hero_deep"/.test(home));
  const deepToHome = (deep.match(/href="\/"/g) || []).length;
  check('deep page links back to the home page', deepToHome >= 2, `${deepToHome} links`);

  // Anchors the nav and the home page point at must exist on the deep page, or every one of
  // those links lands at the top of a long document.
  for (const id of ['demo', 'dashboard', 'pricing', 'faq', 'case-study', 'founder']) {
    check(`deep page has the #${id} anchor`, new RegExp(`<section id="${id}"`).test(deep));
    check(`nav links to #${id}`, home.includes(`/how-it-works/#${id}`) || deep.includes(`href="#${id}"`));
  }

  // The nav is duplicated markup by necessity (no build step), so the two copies are compared
  // rather than trusted.
  const navOf = h => h.match(/<nav aria-label="Primary"[\s\S]*?<\/nav>/)?.[0];
  check('both pages ship the same primary nav', !!navOf(home) && navOf(home) === navOf(deep));
  const footOf = h => h.match(/<footer[\s\S]*?<\/footer>/)?.[0];
  check('both pages ship the same footer', !!footOf(home) && footOf(home) === footOf(deep));
}

// ---------------------------------------------------------------- landmarks & interaction
{
  for (const p of PAGES) {
    check(`${p.name}: page declares a <main> landmark`, (p.html.match(/<main[\s>]/g) || []).length === 1);
    check(`${p.name}: page declares a <nav> landmark`, /<nav[\s>]/.test(p.html));
    check(`${p.name}: page declares a <footer> landmark`, /<footer[\s>]/.test(p.html));

    // A <footer> inside a <section> is that section's footer, not the page's, and yields no
    // contentinfo landmark.
    const beforeFooter = p.html.slice(0, p.html.indexOf('<footer'));
    const depth = (beforeFooter.match(/<section\b/g) || []).length - (beforeFooter.match(/<\/section>/g) || []).length;
    check(`${p.name}: footer is not nested inside a section`, depth === 0, `${depth} open <section> ancestors`);
  }

  // The dashboard panels were hover-driven, which re-selected every panel the cursor
  // crossed while each was mid-transition.
  check('dashboard panels are not hover-driven', !/onMouseEnter/.test(deep),
    /onMouseEnter/.test(deep) ? 'onMouseEnter is back' : 'click only');
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

  for (const field of ['problemsSolved', 'commonGaps', 'evidence', 'focusAreas', 'pages', 'publications']) {
    check(`site-info exposes ${field}`, new RegExp(`\\b${field}\\s*:`).test(siteInfo));
  }
  // Every statistic must carry its attribution, or it reads as our claim rather than a cited one.
  const evidence = siteInfo.slice(siteInfo.indexOf('evidence:'), siteInfo.indexOf('pricesAsOf'));
  const stats = (evidence.match(/stat:/g) || []).length;
  const sources = (evidence.match(/source:/g) || []).length;
  check('every evidence entry carries a source', stats > 0 && stats === sources, `${stats} stats, ${sources} sources`);

  // Both page URLs have to be discoverable by an agent that only reads the machine surfaces.
  for (const surface of [['llms.txt', llms], ['api/site-info.ts', siteInfo]]) {
    check(`${surface[0]} names both pages`,
      surface[1].includes(`${ORIGIN}/how-it-works/`) || surface[1].includes('/how-it-works/'));
  }
  check('site-info points the demo at the page that hosts it', /how-it-works\/#demo/.test(siteInfo));
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
  for (const p of PAGES) {
    const levels = [...p.html.matchAll(/<h([1-6])[\s>]/g)].map(m => Number(m[1]));
    const h1s = levels.filter(l => l === 1).length;
    check(`${p.name}: exactly one <h1>`, h1s === 1, `${h1s} found`);

    let skipped = null;
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) { skipped = `h${levels[i - 1]} -> h${levels[i]}`; break; }
    }
    check(`${p.name}: no skipped heading levels`, skipped === null, skipped || levels.map(l => `h${l}`).join(' '));
  }

  // Two pages fighting over one query is the classic split-a-page mistake. The titles have to
  // aim at different intents.
  const titles = PAGES.map(p => p.html.match(/<title>([^<]+)<\/title>/)?.[1] ?? '');
  check('the two pages have different titles', titles[0] !== titles[1], titles.join(' | '));
  const descs = PAGES.map(p => p.html.match(/<meta name="description" content="([^"]+)"/)?.[1] ?? '');
  check('the two pages have different meta descriptions', descs[0] !== descs[1] && descs.every(d => d.length > 60),
    descs.map(d => d.length).join('/') + ' chars');
}

// ---------------------------------------------------------------- images
{
  for (const p of PAGES) {
    const imgs = [...p.html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
    check(`${p.name}: page has images to check`, imgs.length > 0, `${imgs.length} <img>`);

    const noAlt = imgs.filter(t => !/\salt=/.test(t));
    check(`${p.name}: every <img> declares alt`, noAlt.length === 0, noAlt[0]?.slice(0, 80) || `${imgs.length} ok`);

    // Intrinsic dimensions reserve space before the bytes arrive; without them the layout
    // jumps when each sprite loads, which is exactly what CLS measures. The dashboard captures
    // are the one case where the size genuinely is not knowable at author time — their frames
    // reserve space with an aspect-ratio instead, overwritten with the real ratio on load.
    const fixed = imgs.filter(t => !/\{\{/.test(t));
    const noDims = fixed.filter(t => !(/\swidth=/.test(t) && /\sheight=/.test(t)) && !/width:\d+px/.test(t));
    check(`${p.name}: every fixed-size <img> reserves layout space`, noDims.length === 0,
      noDims[0]?.slice(0, 80) || `${fixed.length} sized`);

    // One eager image (the nav mark, above the fold). Everything else defers.
    const eager = imgs.filter(t => !/loading="lazy"/.test(t) && !/\{\{/.test(t));
    check(`${p.name}: at most one eagerly-loaded image`, eager.length <= 1,
      `${eager.length} eager` + (eager.length ? `: ${eager[0].slice(0, 60)}` : ''));

    // The deep page lives in a subdirectory, so a relative src that used to resolve at the
    // root now resolves under /how-it-works/ and 404s. Both pages are held to absolute paths
    // so the same markup can be shared between them.
    const relative = [...p.html.matchAll(/<img[^>]*src="(?!https?:|\/|\{\{|data:)([^"]+)"/g)].map(m => m[1]);
    check(`${p.name}: no relative image paths`, relative.length === 0, relative.join(', ') || 'all absolute');

    const localSrcs = [...p.html.matchAll(/<img[^>]*src="(?!https?:|\/api\/|\{\{)([^"]+)"/g)].map(m => m[1]);
    const missing = localSrcs.filter(s => !fs.existsSync(path.join(ROOT, s.replace(/^\//, ''))));
    check(`${p.name}: every local image file exists`, missing.length === 0, missing.join(', ') || `${localSrcs.length} resolved`);
  }

  check('runtime-sized images reserve space via aspect-ratio',
    /\.dd-dash-scroll img\{[^}]*aspect-ratio:var\(--ar/.test(css.replace(/\n\s*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'dd-dash-scroll img has an --ar fallback');

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
  const tw = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt'];
  for (const p of PAGES) {
    const missing = need.filter(k => !new RegExp(`property="${k}"`).test(p.html));
    check(`${p.name}: Open Graph card is complete`, missing.length === 0, missing.join(', ') || `${need.length} tags`);
    const twMissing = tw.filter(k => !new RegExp(`name="${k}"`).test(p.html));
    check(`${p.name}: Twitter card is complete`, twMissing.length === 0, twMissing.join(', ') || `${tw.length} tags`);
  }

  // A declared size that does not match the file makes the card render wrong or get dropped.
  const buf = fs.readFileSync(path.join(ROOT, 'og-image.png'));
  const realW = buf.readUInt32BE(16), realH = buf.readUInt32BE(20);
  for (const p of PAGES) {
    const w = Number(p.html.match(/property="og:image:width" content="(\d+)"/)?.[1]);
    const h = Number(p.html.match(/property="og:image:height" content="(\d+)"/)?.[1]);
    check(`${p.name}: og:image dimensions match the real file`, w === realW && h === realH,
      `declared ${w}x${h}, actual ${realW}x${realH}`);
  }
}

// ---------------------------------------------------------------- crawl directives
{
  check('robots.txt keeps the admin page out', /^Disallow:\s*\/admin\.html/m.test(robots));
  check('robots.txt keeps the API out', /^Disallow:\s*\/api\//m.test(robots));
  check('robots.txt still exposes /api/site-info', /^Allow:\s*\/api\/site-info/m.test(robots));
  check('robots.txt does not block the deep page', !/^Disallow:\s*\/how-it-works/m.test(robots));
  check('404 page is noindex', /<meta name="robots" content="noindex/.test(html404));
  check('404 page points at pages that exist', /href="\/how-it-works\//.test(html404) && !/href="\/#faq"/.test(html404));
  for (const p of PAGES) {
    check(`${p.name}: page is indexable`, /<meta name="robots" content="index, follow/.test(p.html));
  }

  const bots = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot', 'Applebot-Extended'];
  const absent = bots.filter(b => !new RegExp(`User-agent:\\s*${b}`, 'i').test(robots));
  check('answer-engine crawlers are named explicitly', absent.length === 0, absent.join(', ') || `${bots.length} allowed`);
}

// ---------------------------------------------------------------- sitemap
{
  const opens = (sitemap.match(/<url>/g) || []).length;
  const closes = (sitemap.match(/<\/url>/g) || []).length;
  check('sitemap tags balance', opens === closes && opens === 2, `${opens} <url>`);
  check('sitemap declares the video namespace', /xmlns:video=/.test(sitemap));
  const vids = (sitemap.match(/<video:video>/g) || []).length;
  const schemaVids = graphs.home.filter(n => n['@type'] === 'VideoObject').length
                   + graphs.deep.filter(n => n['@type'] === 'VideoObject').length;
  check('sitemap lists the same videos as the schemas', vids === schemaVids, `sitemap ${vids}, schema ${schemaVids}`);
  // Anchors are not documents. Listing them is the fastest way to get a sitemap ignored.
  check('sitemap lists no anchors', !/<loc>[^<]*#/.test(sitemap));
  const lastmods = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
  check('every lastmod is a valid ISO date',
    lastmods.length === 2 && lastmods.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)), lastmods.join(', '));
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
