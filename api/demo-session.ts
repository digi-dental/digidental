// /api/demo-session — Vercel serverless function
// Gates the free demo call: one per visitor IP. Called BEFORE any voice call starts.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

// SECURITY: service-role key is server-side only — set SUPABASE_SERVICE_ROLE_KEY in the hosting dashboard.
const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ approved: false });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = createHash('sha256').update(ip + process.env.IP_HASH_SALT).digest('hex');

    const { data: prior } = await supabase.from('demo_sessions').select('id').eq('ip_hash', ipHash).limit(1);
    if (prior && prior.length > 0) {
      return res.status(200).json({ approved: false, reason: 'already_demoed' }); // polite rejection — client shows Toothy's repeat-visitor bubble
    }
    await supabase.from('demo_sessions').insert({ ip_hash: ipHash });
    return res.status(200).json({ approved: true });
    // TODO harden for production: per-IP rate limits, short-TTL signed approval token the client
    // must present to start the call, and a spend cap + maxDurationSeconds: 60 on the Voice Infrastructure assistant.
  } catch {
    // Graceful failure: approve nothing, reject politely — visitor never sees a raw error.
    return res.status(200).json({ approved: false, reason: 'unavailable' });
  }
}
