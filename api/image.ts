// /api/image — Vercel serverless function
// Serves marketing images through one stable URL so the page never carries an expiring token.
// `<img src="/api/image?name=profile">` → the image bytes, cached hard at the Vercel edge.
//
// Same reasoning as /api/video: these arrived as Supabase signed URLs whose tokens expire
// 2027-08-10. Embedding those directly in index.html means the founder portrait and the dashboard
// screenshots silently 400 on that date, with the HTML needing a code change to fix. Routing them
// through here makes it an environment-variable change instead.
//
//   Permanent fix: make the `Images` bucket public in Supabase, then set the env vars below to the
//   /object/public/... URLs. Public URLs never expire and the token juggling stops mattering.
//
//   Interim fix: mint fresh signed URLs and set the same env vars in
//   Vercel → Settings → Environment Variables. No redeploy of the page required.
//
// EGRESS: this route used to 302 straight to Supabase, which put every visitor's browser on the
// bucket directly — one billed Supabase egress per image per view, with nothing in between. It
// now fetches the object server-side and serves the bytes itself, so Vercel's CDN answers the
// visitors and Supabase is read roughly once per edge region per deployment. The redirect stays
// as the fallback for the cases the proxy cannot serve (see serveByRedirect below).
//
// TRANSFORMS: never point these env vars at a /storage/v1/render/image/... URL. That is Supabase's
// on-the-fly transformer, and every distinct variant is billed as an image transformation on top
// of the egress. withoutTransform() below rewrites any that arrive back to the plain object path,
// so a transform URL pasted into an env var cannot re-start the meter.
//
// The hardcoded values are the current signed URLs, kept only as a fallback so the site keeps
// working until the env vars are set.

const FALLBACK: Record<string, string> = {
  profile: 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/Images/profile.jpg?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJJbWFnZXMvcHJvZmlsZS5qcGciLCJzY29wZSI6ImRvd25sb2FkIiwiaWF0IjoxNzg2MzQ2NDA3LCJleHAiOjE4MTc4ODI0MDd9.VppRkYfzHwyQwdy2WGpP_yElBE8iv5xssergA7ESdfw',
  'dash-assistant': 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/Images/screencapture-dashboard-vapi-ai-assistants-e3c3d544-3023-4725-bc7a-cbe78b35d36c-2026-08-10-11_58_08.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJJbWFnZXMvc2NyZWVuY2FwdHVyZS1kYXNoYm9hcmQtdmFwaS1haS1hc3Npc3RhbnRzLWUzYzNkNTQ0LTMwMjMtNDcyNS1iYzdhLWNiZTc4YjM1ZDM2Yy0yMDI2LTA4LTEwLTExXzU4XzA4LnBuZyIsInNjb3BlIjoiZG93bmxvYWQiLCJpYXQiOjE3ODYzNDY4NjcsImV4cCI6MTgxNzg4Mjg2N30.gijts4ro9tLPDV4rXeLV9sdt9j5AS-dYRm4STGxW-nA',
  'dash-call': 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/Images/screencapture-dashboard-vapi-ai-calls-019fc183-5849-7aac-819f-7a69a9fc4063-2026-08-10-12_03_39.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJJbWFnZXMvc2NyZWVuY2FwdHVyZS1kYXNoYm9hcmQtdmFwaS1haS1jYWxscy0wMTlmYzE4My01ODQ5LTdhYWMtODE5Zi03YTY5YTlmYzQwNjMtMjAyNi0wOC0xMC0xMl8wM18zOS5wbmciLCJzY29wZSI6ImRvd25sb2FkIiwiaWF0IjoxNzg2MzQ2OTE3LCJleHAiOjE4MTc4ODI5MTd9.Nm6Hp9Z7khuZp4pwojK_R336wdZgPmusQMX2464J_0E',
  'dash-logs': 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/Images/screencapture-dashboard-vapi-ai-logs-2026-08-10-11_53_26.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJJbWFnZXMvc2NyZWVuY2FwdHVyZS1kYXNoYm9hcmQtdmFwaS1haS1sb2dzLTIwMjYtMDgtMTAtMTFfNTNfMjYucG5nIiwic2NvcGUiOiJkb3dubG9hZCIsImlhdCI6MTc4NjM0NjkzNCwiZXhwIjoxODE3ODgyOTM0fQ.1NRcrrYINbkEHqcfIQWsELQGAF_IpcJs8TE7ywRx1AQ',
  'dash-metrics': 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/Images/screencapture-dashboard-vapi-ai-metrics-2026-08-10-11_57_20.png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJJbWFnZXMvc2NyZWVuY2FwdHVyZS1kYXNoYm9hcmQtdmFwaS1haS1tZXRyaWNzLTIwMjYtMDgtMTAtMTFfNTdfMjAucG5nIiwic2NvcGUiOiJkb3dubG9hZCIsImlhdCI6MTc4NjM0Njk3NSwiZXhwIjoxODE3ODgyOTc1fQ.Bpdyo__gaW3U8E_sGKYQOCi_RMO1zB0gAjPcCUfyYVo',
};

// Env override per image, so a lapsed token is fixed without touching code.
const ENV_KEY: Record<string, string> = {
  profile: 'IMAGE_PROFILE_URL',
  'dash-assistant': 'IMAGE_DASH_ASSISTANT_URL',
  'dash-call': 'IMAGE_DASH_CALL_URL',
  'dash-logs': 'IMAGE_DASH_LOGS_URL',
  'dash-metrics': 'IMAGE_DASH_METRICS_URL',
};

// A year at the edge, a day in the browser. The URL is stable and the file behind it changes
// roughly never, so the visitor should be paying for these bytes once, not once an hour. A
// Vercel deployment gets a fresh cache key, so swapping an env var still takes effect on deploy.
const CACHE = 'public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800';

// Supabase's on-the-fly transformer. `/storage/v1/render/image/...` resizes on request, and each
// distinct set of parameters is a separate billed transformation — the thing this route exists to
// never do. Any transform URL is rewritten to the plain object path and its transform parameters
// dropped, so the original file is served instead. `token` survives: signed URLs still need it.
const TRANSFORM_PARAMS = ['width', 'height', 'resize', 'quality', 'format'];

export function withoutTransform(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw; }
  // /storage/v1/render/image/public/… → /storage/v1/object/public/… (also sign/, authenticated/)
  url.pathname = url.pathname.replace(
    /\/storage\/v1\/render\/image\/(public|sign|authenticated)\//,
    '/storage/v1/object/$1/'
  );
  for (const p of TRANSFORM_PARAMS) url.searchParams.delete(p);
  return url.toString();
}

// What the route used to do unconditionally, kept for the cases the proxy cannot serve: the
// upstream is unreachable, answers with something that is not an image, or is too large to
// buffer. The visitor still gets the picture; only the caching is worse — deliberately a short
// cache, because a year-long one would freeze a momentary Supabase blip into the CDN and put
// every visitor back on the bucket until the next deploy.
const FALLBACK_CACHE = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

function serveByRedirect(res: any, target: string) {
  res.setHeader('Cache-Control', FALLBACK_CACHE);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Location', target);
  return res.status(302).end();
}

// Vercel buffers a serverless response before sending it, and rejects one over ~4.5MB. Anything
// heavier is redirected rather than dropped. These captures are well under it; the guard is here
// so replacing one with a 10MB PNG degrades to the old behaviour instead of 500ing.
const MAX_BYTES = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;

export default async function handler(req: any, res: any) {
  try {
    const name = String((req.query && req.query.name) || '').trim();
    const configured = (ENV_KEY[name] && process.env[ENV_KEY[name]]) || FALLBACK[name];
    if (!configured) return res.status(404).json({ error: 'Unknown image.' });

    const target = withoutTransform(configured);

    res.setHeader('Cache-Control', CACHE);
    res.setHeader('Referrer-Policy', 'no-referrer');

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: any;
    try {
      upstream = await fetch(target, {
        signal: ctl.signal,
        // The visitor's own validators, so a browser holding the file gets a 304 and no bytes move.
        headers: req.headers && req.headers['if-none-match']
          ? { 'if-none-match': String(req.headers['if-none-match']) }
          : {},
      });
    } finally { clearTimeout(timer); }

    if (upstream.status === 304) return res.status(304).end();
    if (!upstream.ok) {
      console.error('[image] upstream', upstream.status, 'for', name);
      return serveByRedirect(res, target);
    }

    const type = upstream.headers.get('content-type') || '';
    // This route serves pictures. Refusing anything else keeps a mistyped env var from putting
    // arbitrary content on our own origin, where the site's CSP would trust it.
    if (!type.startsWith('image/')) {
      console.error('[image] upstream is not an image:', type, 'for', name);
      return serveByRedirect(res, target);
    }

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return serveByRedirect(res, target);

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.byteLength > MAX_BYTES) return serveByRedirect(res, target);

    const etag = upstream.headers.get('etag');
    if (etag) res.setHeader('ETag', etag);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(body.byteLength));
    if (req.method === 'HEAD') return res.status(200).end();
    return res.status(200).end(body);
  } catch (e: any) {
    console.error('[image] failed:', e && e.message);
    return res.status(500).json({ error: 'Could not resolve the image.' });
  }
}
