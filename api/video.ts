// /api/video — Vercel serverless function
// Serves the marketing videos through one stable URL so the page never carries an
// expiring token. `<video src="/api/video?clip=vsl">` → 302 to wherever the file
// actually lives; the browser follows the redirect and does its own range requests.
//
// BUG-4 background: the two clips used to be embedded as Supabase signed URLs with a
// 365-day expiry (tokens below expire 2027-07-24). When they lapse, both players break.
// This route makes the fix an environment-variable change instead of a code change:
//
//   Preferred fix (permanent): make the `digi_dental-VSL` bucket public in Supabase, then
//   set VIDEO_VSL_URL / VIDEO_DEMO_URL to the public /object/public/... URLs. Public URLs
//   never expire and this route stops mattering.
//
//   Interim fix: mint fresh signed URLs and set the same two env vars in
//   Vercel → Settings → Environment Variables. No redeploy of the page required.
//
// The hardcoded values below are the current signed URLs, kept only as a fallback so the
// site keeps working until the env vars are set. They stop working on 2027-07-24.

const FALLBACK: Record<string, string> = {
  vsl: 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/digi_dental-VSL/digidental-vsl.mp4?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJkaWdpX2RlbnRhbC1WU0wvZGlnaWRlbnRhbC12c2wubXA0Iiwic2NvcGUiOiJkb3dubG9hZCIsImlhdCI6MTc4NDkxNDUyNCwiZXhwIjoxODE2NDUwNTI0fQ.TWFTOKvssrZSkX1AcpxPX_Rp0a1Xt3aIqrxW_EzT-1s',
  demo: 'https://hctpvnqanwhxlmpmfmme.supabase.co/storage/v1/object/sign/digi_dental-VSL/Digi%20Dental.mp4?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8xZjgzNDRkYS1mNzlkLTQ5MzAtOWNhZC1hOTk1NzYzYzhmN2YiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJkaWdpX2RlbnRhbC1WU0wvRGlnaSBEZW50YWwubXA0Iiwic2NvcGUiOiJkb3dubG9hZCIsImlhdCI6MTc4NDkxOTQzOCwiZXhwIjoxODE2NDU1NDM4fQ.um8KH5pV1tYwTwm-L_QizXkBjGp-iXW0kOtvAlTuAB4',
};

const ENV_VAR: Record<string, string> = { vsl: 'VIDEO_VSL_URL', demo: 'VIDEO_DEMO_URL' };

export default function handler(req: any, res: any) {
  const clip = String((req.query && req.query.clip) || 'vsl').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FALLBACK, clip)) {
    return res.status(404).json({ error: 'Unknown clip. Use ?clip=vsl or ?clip=demo.' });
  }
  const target = process.env[ENV_VAR[clip]] || FALLBACK[clip];
  // Short edge cache: long enough to be cheap, short enough that swapping the env var
  // takes effect the same day without a purge.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('Location', target);
  return res.status(302).end();
}
