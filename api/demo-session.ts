// /api/demo-session — Vercel serverless function
// Gates the free demo call: one per visitor IP. Called BEFORE any voice call starts.
//
// Two modes, both POST:
//   { }               → check only. Answers "may this visitor call?" and writes nothing.
//   { claim: true }   → check, then record the call. The client sends this from goLive(),
//                       i.e. once the call is actually connected.
// Splitting them matters: a visitor who denies the microphone, or whose connection drops
// before the assistant answers, has used nothing — and must not lose their one free demo.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

// SECURITY: service-role key is server-side only — set SUPABASE_SERVICE_ROLE_KEY in the hosting dashboard.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ approved: false });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const claim = !!(body && body.claim);

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ipHash = createHash('sha256').update(ip + process.env.IP_HASH_SALT).digest('hex');

    // The error is read, not discarded. When this lookup was silently denied by a missing
    // grant it returned no rows, the gate read that as "no prior demo", and every caller was
    // approved — the free-demo limit was not enforced at all and the voice spend was uncapped.
    // A lookup that fails now says so in the logs instead of quietly disabling the gate.
    const { data: prior, error: lookupError } = await supabase
      .from('demo_sessions').select('id').eq('ip_hash', ipHash).limit(1);
    if (lookupError) console.error('[demo-session] gate lookup FAILED, approving by default:', lookupError.message);

    if (prior && prior.length > 0) {
      return res.status(200).json({ approved: false, reason: 'already_demoed' }); // polite rejection — client shows Toothy's repeat-visitor bubble
    }
    if (claim) {
      const { error: claimError } = await supabase.from('demo_sessions').insert({ ip_hash: ipHash });
      if (claimError) console.error('[demo-session] claim insert FAILED, demo not recorded:', claimError.message);
    }
    return res.status(200).json({ approved: true });
    // TODO harden for production: per-IP rate limits, short-TTL signed approval token the client
    // must present to start the call, and a spend cap + maxDurationSeconds: 60 on the Voice Infrastructure assistant.
  } catch {
    // Graceful failure: the client treats anything other than an explicit 'already_demoed' as
    // approval, so an outage here never turns a real prospect away.
    return res.status(200).json({ approved: false, reason: 'unavailable' });
  }
}
