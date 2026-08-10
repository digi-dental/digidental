// /api/image — Vercel serverless function
// Serves marketing images through one stable URL so the page never carries an expiring token.
// `<img src="/api/image?name=profile">` → 302 to wherever the file actually lives.
//
// Same reasoning as /api/video: these arrived as Supabase signed URLs whose tokens expire
// 2027-08-10. Embedding those directly in index.html means the founder portrait and the dashboard
// screenshots silently 400 on that date, with the HTML needing a code change to fix. Routing them
// through here makes it an environment-variable change instead.
//
//   Permanent fix: make the `Images` bucket public in Supabase, then set the env vars below to the
//   /object/public/... URLs. Public URLs never expire and this route stops mattering.
//
//   Interim fix: mint fresh signed URLs and set the same env vars in
//   Vercel → Settings → Environment Variables. No redeploy of the page required.
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

export default async function handler(req: any, res: any) {
  try {
    const name = String((req.query && req.query.name) || '').trim();
    const target = (ENV_KEY[name] && process.env[ENV_KEY[name]]) || FALLBACK[name];
    if (!target) return res.status(404).json({ error: 'Unknown image.' });

    // Cached hard at the edge: these change roughly never, and a redirect per view is wasteful.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=604800');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, target);
  } catch (e: any) {
    console.error('[image] failed:', e && e.message);
    return res.status(500).json({ error: 'Could not resolve the image.' });
  }
}
