// /api/image — Vercel serverless function
// Serves marketing images through one stable URL so the page never carries an expiring token.
// `<img src="/api/image?name=profile">` → 302 to wherever the file actually lives.
//
// This URL backs the Person.image and ImageObject nodes in the homepage JSON-LD, so robots.txt
// allows /api/image through the /api/ disallow — a blocked image URL is a structured-data node
// Google cannot verify.
//
// ---------------------------------------------------------------------------
// How a target is chosen, in order — same ladder as /api/video
// ---------------------------------------------------------------------------
//   1. The per-image env var, if set. Always wins.
//   2. The bucket's public URL, if the bucket is public. Probed once per warm lambda, so
//      flipping the bucket to public switches this route to never-expiring URLs by itself.
//   3. The signed URL below, as a fallback. These tokens expire 2027-08-10.
//
// ---------------------------------------------------------------------------
// Resizing: ?w= and ?fmt=
// ---------------------------------------------------------------------------
// profile.jpg is a 1775x1775 / 476 KiB original displayed at 651px at its very largest, and
// PageSpeed put ~412 KiB of that down as pure waste. Rather than committing resized copies to
// the repo, this route can hand off to Supabase's image transformation endpoint
// (/render/image/public/...), which resizes and re-encodes on the fly and caches the result at
// their CDN. That is what makes the srcset on the founder photo worth having.
//
// Transformations are only available on public buckets, and only for images. When the bucket is
// private, or the caller asks for a size on something that is not transformable, the request
// degrades to the plain original — a correct heavy image beats a broken light one.

const PROJECT = 'hctpvnqanwhxlmpmfmme';
const BUCKET = 'Images';

const OBJECT: Record<string, string> = {
  profile: 'profile.jpg',
  'dash-assistant': 'screencapture-dashboard-vapi-ai-assistants-e3c3d544-3023-4725-bc7a-cbe78b35d36c-2026-08-10-11_58_08.png',
  'dash-call': 'screencapture-dashboard-vapi-ai-calls-019fc183-5849-7aac-819f-7a69a9fc4063-2026-08-10-12_03_39.png',
  'dash-logs': 'screencapture-dashboard-vapi-ai-logs-2026-08-10-11_53_26.png',
  'dash-metrics': 'screencapture-dashboard-vapi-ai-metrics-2026-08-10-11_57_20.png',
};

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

// Only the widths the page actually asks for. An open width parameter is an invitation to
// have someone else's bandwidth bill run up one distinct render at a time.
const ALLOWED_WIDTHS = [200, 300, 400, 600, 900, 1200];

function storageBase(): string {
  return (process.env.SUPABASE_URL || `https://${PROJECT}.supabase.co`).replace(/\/+$/, '');
}

function publicUrl(name: string): string {
  return `${storageBase()}/storage/v1/object/public/${encodeURIComponent(BUCKET)}/${encodeURIComponent(OBJECT[name])}`;
}

function renderUrl(name: string, width: number, format: string): string {
  const q = new URLSearchParams({ width: String(width), resize: 'contain', quality: '78' });
  if (format === 'webp' || format === 'avif') q.set('format', format);
  return `${storageBase()}/storage/v1/render/image/public/${encodeURIComponent(BUCKET)}/${encodeURIComponent(OBJECT[name])}?${q}`;
}

const publicCheck: Record<string, Promise<boolean>> = {};

function resolvePublic(name: string): Promise<boolean> {
  if (!publicCheck[name]) {
    publicCheck[name] = (async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch(publicUrl(name), { method: 'HEAD', signal: ctl.signal });
        clearTimeout(t);
        return r.ok;
      } catch {
        return false;
      }
    })();
  }
  return publicCheck[name];
}

export default async function handler(req: any, res: any) {
  try {
    const q = req.query || {};
    const name = String(q.name || '').trim();
    if (!OBJECT[name]) return res.status(404).json({ error: 'Unknown image.' });

    const width = Number(q.w);
    const format = String(q.fmt || '').toLowerCase();
    const wantsResize = ALLOWED_WIDTHS.includes(width);

    const override = ENV_KEY[name] && process.env[ENV_KEY[name]];
    let target: string;

    if (override) {
      target = override;
    } else if (await resolvePublic(name)) {
      // Transformations require a public bucket, so they are only reachable down this branch.
      target = wantsResize ? renderUrl(name, width, format) : publicUrl(name);
    } else {
      target = FALLBACK[name];
    }

    // Cached hard at the edge: these change roughly never, and a redirect per view is wasteful.
    // ?w= and ?fmt= are part of the URL, and Vercel's cache key is the full URL including the
    // query string, so each srcset variant gets its own entry with no Vary header needed.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=604800');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, target);
  } catch (e: any) {
    console.error('[image] failed:', e && e.message);
    return res.status(500).json({ error: 'Could not resolve the image.' });
  }
}
