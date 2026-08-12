/**
 * Security regression tests.
 *
 * Static assertions over the shipped files. Each one pins a specific finding from the security
 * audit — the point is not that the code is correct today, it is that a future edit cannot
 * quietly undo it. Every check below names the failure it prevents.
 *
 * Run: node test/security.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const API = ['demo-session', 'notify-lead', 'event', 'admin-login', 'stats', 'image', 'video', 'site-info']
  .filter(n => fs.existsSync(path.join(ROOT, `api/${n}.ts`)))
  .map(n => [`api/${n}.ts`, read(`api/${n}.ts`)]);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ------------------------------------------------------------------ client IP
{
  // `x-forwarded-for` is built by PREPENDING the client's own value, so element [0] is
  // whatever the caller typed. Reading it made the free-demo gate, the lead rate limit and
  // the login throttle bypassable with one header — unlimited voice minutes billed to us.
  const offenders = API.filter(([, s]) => /x-forwarded-for['"]\s*\]\s*\|\|\s*['"]['"]\s*\)\s*\.split\(['"],['"]\)\[0\]/.test(s)
                                        || /\.split\(','\)\[0\]/.test(s));
  check('no endpoint reads x-forwarded-for[0]', offenders.length === 0,
    offenders.map(([f]) => f).join(', ') || 'clean');

  const keyed = ['api/demo-session.ts', 'api/notify-lead.ts', 'api/event.ts', 'api/admin-login.ts'];
  const missing = keyed.filter(f => !read(f).includes('clientIp(req)'));
  check('every IP-keyed endpoint uses the shared helper', missing.length === 0, missing.join(', ') || keyed.length + ' endpoints');

  const helper = read('lib/http.ts');
  check('helper prefers the header the client cannot forge', /x-vercel-forwarded-for/.test(helper));
  check('helper takes the LAST forwarded hop', /\.split\(','\)\.pop\(\)/.test(helper));
}

// ------------------------------------------------------------------ demo gate
{
  const s = read('api/demo-session.ts');
  // Check-then-insert let two simultaneous requests both pass. The unique index makes the
  // write itself the decision.
  check('claim is atomic, not check-then-insert', /ignoreDuplicates:\s*true/.test(s) && /onConflict:\s*'ip_hash'/.test(s));
  check('a claim is proven by a returned row', /data\.length > 0/.test(s));
  // Approving on lookup failure meant any Supabase blip removed the spend cap entirely.
  check('gate fails closed on lookup error',
    /lookupError[\s\S]{0,240}approved:\s*false/.test(s),
    /approving by default/i.test(s) ? 'still approves on error!' : 'denies on error');
  check('claims require a signed short-lived token', /timingSafeEqual/.test(s) && /TOKEN_TTL_MS/.test(s));

  const mig = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).find(f => /^009_/.test(f));
  check('migration 009 exists', !!mig, mig || 'missing');
  const m = mig ? read(`supabase/migrations/${mig}`) : '';
  check('009 creates the unique index the claim relies on',
    /create unique index[\s\S]{0,120}demo_sessions[\s\S]{0,60}ip_hash/i.test(m));
  check('009 dedupes before creating it', /delete from public\.demo_sessions/i.test(m));

  const client = read('index.html');
  check('client sends the claim token', /claim: true, token:/.test(client));
  // An outage on our side must not consume the visitor's one free demo.
  check('client does not burn the demo on an unavailable gate',
    /gate\.reason !== 'already_demoed'/.test(client));
}

// ------------------------------------------------------------------ lead email
{
  const s = read('api/notify-lead.ts');
  // Raw interpolation let a lead name render as a working link inside the founder's inbox.
  check('lead fields are escaped into the email', /escHtml\(/.test(s));
  const fields = ['name', 'practice', 'email', 'phone', 'country', 'volume', 'locations'];
  const unescaped = fields.filter(f => !new RegExp(`${f}:\\s*escHtml\\(`).test(s));
  check('every visitor-supplied field is escaped', unescaped.length === 0, unescaped.join(', ') || fields.length + ' fields');
  check('email has a plain-text alternative', /text:\s*leadSummaryText/.test(s));
  check('malformed addresses are rejected on form submissions', /looksLikeEmail\(email\)/.test(s));
}

// ------------------------------------------------------------------ event volume
{
  const s = read('api/event.ts');
  // The size cap only ever saw string bodies; a pre-parsed object skipped it entirely.
  check('parsed bodies are size-capped too', /JSON\.stringify\(body\)\.length > MAX_BODY/.test(s));
  check('props are flattened and bounded', /props:\s*safeProps\(props\)/.test(s));
  // Full referrers can carry tokens and invite ids that are not ours to keep.
  check('referrer is stored without its query string', /trimReferrer\(ref/.test(s));
}

// ------------------------------------------------------------------ admin session
{
  const login = read('api/admin-login.ts');
  const stats = read('api/stats.ts');
  // Falling back to the password made the cookie's integrity rest on password entropy.
  check('login never signs with the password', !/ADMIN_SESSION_SECRET \|\| process\.env\.ADMIN_PASSWORD/.test(login));
  check('stats never verifies with the password', !/ADMIN_SESSION_SECRET \|\| process\.env\.ADMIN_PASSWORD/.test(stats));
  check('login refuses to issue an unsigned session', /ADMIN_SESSION_SECRET is not set/.test(login));
  check('sessions default to 24 hours, not a week', /ADMIN_SESSION_HOURS \|\| '24'/.test(login));
  check('cookie is HttpOnly, Secure and SameSite=Strict',
    /HttpOnly/.test(login) && /Secure/.test(login) && /SameSite=Strict/.test(login));
}

// ------------------------------------------------------------------ headers
{
  const v = JSON.parse(read('vercel.json'));
  const forSource = src => {
    const out = {};
    for (const r of v.headers) if (r.source === src) for (const h of r.headers) out[h.key] = h.value;
    return out;
  };
  const site = forSource('/(.*)');
  const admin = forSource('/admin.html');

  for (const k of ['Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Strict-Transport-Security',
                   'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    check(`site sends ${k}`, !!site[k]);
  }
  const csp = site['Content-Security-Policy'] || '';
  // React is injected from unpkg by support.js; the voice SDK comes from jsdelivr. A policy
  // missing either renders a blank page — this is exactly what an untested CSP costs.
  check('CSP allows the React CDN', /https:\/\/unpkg\.com/.test(csp), 'unpkg');
  check('CSP allows the voice SDK CDN', /https:\/\/cdn\.jsdelivr\.net/.test(csp), 'jsdelivr');
  // The dc-runtime compiles each logic class from a string. Verified: without this the body
  // is 259 characters and nothing mounts.
  check("CSP keeps 'unsafe-eval' the runtime needs", /'unsafe-eval'/.test(csp),
    /'unsafe-eval'/.test(csp) ? 'present' : 'REMOVING THIS BLANKS THE SITE');
  check('CSP blocks plugins', /object-src 'none'/.test(csp));
  check('CSP pins base-uri and form-action', /base-uri 'self'/.test(csp) && /form-action 'self'/.test(csp));
  check('CSP restricts framing', /frame-ancestors/.test(csp));

  const acsp = admin['Content-Security-Policy'] || '';
  check('dashboard has its own stricter CSP', !!acsp && acsp !== csp);
  // The dashboard does not use the runtime, so it has no reason to allow eval.
  check("dashboard CSP has no 'unsafe-eval'", !/'unsafe-eval'/.test(acsp));
  check('dashboard talks only to its own origin', /connect-src 'self'/.test(acsp));
  check('dashboard cannot be framed at all',
    /frame-ancestors 'none'/.test(acsp) && admin['X-Frame-Options'] === 'DENY');
  check('dashboard is never cached', /no-store/.test(admin['Cache-Control'] || ''));
}

// ------------------------------------------------------------------ secret hygiene
{
  // Nothing that looks like a JWT or a Supabase secret key belongs in a tracked file. The
  // storage tokens in image/video are download-only marketing media and are tracked
  // deliberately until the buckets go public — they are counted, not ignored, so the number
  // can only go down.
  const tracked = [];
  const walk = d => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (['node_modules', '.git', 'test'].includes(e.name)) continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|js|mjs|html|json|sql|txt|md)$/.test(e.name)) tracked.push(rel);
    }
  };
  walk('.');

  const secretish = tracked.filter(f => /sb_secret_|SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"]eyJ|service_role.*eyJ/.test(read(f)));
  check('no service-role key in any tracked file', secretish.length === 0, secretish.join(', ') || 'clean');

  const signed = tracked.filter(f => /storage\/v1\/object\/sign/.test(read(f)));
  check('signed storage URLs are confined to the media proxies',
    signed.every(f => /api\/(image|video)\.ts$/.test(f) || /\.md$/.test(f)),
    signed.join(', ') || 'none');
  check('no signed storage token reaches the page', !/storage\/v1\/object\/sign/.test(read('index.html')));
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
