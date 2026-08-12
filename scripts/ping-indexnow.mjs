#!/usr/bin/env node
/**
 * Push URLs to IndexNow, which Bing, Copilot, Yandex, Seznam and Naver all consume.
 *
 * Why this exists: Google retired its sitemap ping endpoint in 2023 and Bing retired theirs
 * shortly after, pointing publishers at IndexNow instead. So there is exactly one automated
 * indexing lever left, and this is it. Google has no equivalent — GSC's "Request Indexing"
 * is a manual button, listed in SEO-LAUNCH-CHECKLIST.md.
 *
 *   npm run seo:submit            push the live URL list
 *   npm run seo:submit -- --dry   build and validate the payload, send nothing
 *
 * The key lives in a file committed at the site root because IndexNow verifies ownership by
 * fetching https://<host>/<key>.txt and comparing. That file is not a secret: it proves the
 * person pinging controls the site, and it is useless to anyone else.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOST = process.env.INDEXNOW_HOST || 'www.digidental.us';

// Prefer the env var; otherwise discover the committed key file so the two can never disagree.
function resolveKey() {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY.trim();
  const f = fs.readdirSync(ROOT).find(n => /^[0-9a-f]{8,128}\.txt$/i.test(n));
  if (!f) return null;
  const contents = fs.readFileSync(path.join(ROOT, f), 'utf8').trim();
  const named = f.replace(/\.txt$/i, '');
  if (contents !== named) {
    console.error(`key file mismatch: ${f} contains "${contents}". IndexNow requires the file`);
    console.error('to be named <key>.txt AND to contain exactly that key.');
    process.exit(1);
  }
  return named;
}

const KEY = resolveKey();
if (!KEY) {
  console.error('No IndexNow key. Commit a <key>.txt at the repo root, or set INDEXNOW_KEY.');
  process.exit(1);
}

// Everything indexable. Kept in sync with sitemap.xml by test/seo.test.mjs.
const urlList = (() => {
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  return locs.length ? locs : [`https://${HOST}/`];
})();

const payload = {
  host: HOST,
  key: KEY,
  keyLocation: `https://${HOST}/${KEY}.txt`,
  urlList,
};

const offHost = urlList.filter(u => { try { return new URL(u).host !== HOST; } catch { return true; } });
if (offHost.length) {
  // IndexNow rejects the whole batch with 422 if any URL is outside the host.
  console.error('These URLs are not on ' + HOST + ', which would 422 the whole batch:');
  offHost.forEach(u => console.error('  ' + u));
  process.exit(1);
}

console.log(`host        ${payload.host}`);
console.log(`key         ${KEY.slice(0, 6)}… (${KEY.length} chars)`);
console.log(`keyLocation ${payload.keyLocation}`);
console.log(`urls        ${urlList.length}`);
urlList.forEach(u => console.log('            ' + u));

if (process.argv.includes('--dry')) {
  console.log('\n--dry: payload valid, nothing sent.');
  process.exit(0);
}

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
}).catch(e => { console.error('\nrequest failed:', e.message); process.exit(1); });

// IndexNow's status codes are the whole diagnostic — it returns no body worth reading.
const meaning = {
  200: 'OK — URLs received.',
  202: 'Accepted — received, key validation pending.',
  400: 'Bad request — malformed payload.',
  403: 'Forbidden — the key file could not be verified. Is https://' + HOST + '/' + KEY + '.txt reachable?',
  422: 'Unprocessable — a URL does not belong to the host, or the key does not match.',
  429: 'Too many requests — slow down.',
};
console.log(`\nHTTP ${res.status}  ${meaning[res.status] || ''}`);
if (res.status >= 400) {
  console.log('Nothing was queued. Fix the above and re-run.');
  process.exit(1);
}
console.log('\nGoogle has no equivalent endpoint. Do this by hand:');
console.log('  https://search.google.com/search-console  → URL Inspection → Request Indexing');
console.log('  https://www.bing.com/webmasters            → Sitemaps → resubmit');
