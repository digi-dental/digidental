// /api/demo-session — Vercel serverless function
// Gates the free demo call: one per visitor IP. Called BEFORE any voice call starts.
//
// Two modes, both POST:
//   { }                     → check only. Answers "may this visitor call?" and writes nothing.
//   { claim: true, token }  → record the call. The client sends this from goLive(), i.e. once
//                             the call is actually connected.
// Splitting them matters: a visitor who denies the microphone, or whose connection drops
// before the assistant answers, has used nothing — and must not lose their one free demo.
import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { clientIp } from '../lib/http';

// SECURITY: service-role key is server-side only — set SUPABASE_SERVICE_ROLE_KEY in the hosting dashboard.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

// Ties a claim to a check that happened moments earlier from the same IP. Without it, /claim
// is a bare endpoint anyone can post to. 60s is generous: the client claims the instant the
// call connects.
const TOKEN_TTL_MS = 60_000;
const gateSecret = () => process.env.DEMO_GATE_SECRET || process.env.ADMIN_SESSION_SECRET || '';

function mintToken(ipHash: string): string {
  const secret = gateSecret();
  if (!secret) return '';
  const exp = Date.now() + TOKEN_TTL_MS;
  return exp + '.' + createHmac('sha256', secret).update(ipHash + '.' + exp).digest('hex');
}

function tokenValid(token: unknown, ipHash: string): boolean {
  const secret = gateSecret();
  // No secret configured: the demo still works, but this check is inert. Warn rather than
  // degrade silently — and rather than break a live site whose env vars are not set yet.
  if (!secret) { console.warn('[demo-session] DEMO_GATE_SECRET unset — claim tokens not enforced'); return true; }
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(ipHash + '.' + exp).digest('hex'), 'utf8');
  const got = Buffer.from(parts[1], 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ approved: false });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const claim = !!(body && body.claim);

    const ip = clientIp(req);
    const ipHash = createHash('sha256').update(ip + process.env.IP_HASH_SALT).digest('hex');

    if (claim) {
      if (!tokenValid(body && body.token, ipHash)) {
        console.warn('[demo-session] claim rejected: missing or expired token');
        return res.status(403).json({ approved: false, reason: 'bad_token' });
      }
      // The insert IS the decision. This used to be select-then-insert: two requests arriving
      // together both read "no prior demo" and both wrote, so one visitor could take several
      // free calls. `ignoreDuplicates` against the unique index from migration 009 hands the
      // arbitration to the database — a returned row proves this request is the one that won.
      const { data, error } = await supabase
        .from('demo_sessions')
        .upsert({ ip_hash: ipHash }, { onConflict: 'ip_hash', ignoreDuplicates: true })
        .select('id');
      if (error) {
        console.error('[demo-session] claim failed:', error.message);
        // The call is already connected by now. Refusing here would cut off a live conversation
        // to protect an accounting row, so it proceeds and the failure is loud in the logs.
        return res.status(200).json({ approved: true, reason: 'claim_unrecorded' });
      }
      const won = Array.isArray(data) && data.length > 0;
      return res.status(200).json({ approved: won, reason: won ? 'claimed' : 'already_demoed' });
    }

    const { data: prior, error: lookupError } = await supabase
      .from('demo_sessions').select('id').eq('ip_hash', ipHash).limit(1);

    // This used to approve on lookup failure, so any Supabase blip removed the one-demo cap
    // entirely and voice spend became unbounded for the length of the outage. It now fails
    // closed: one hot lead retries, instead of uncapped call minutes.
    if (lookupError) {
      console.error('[demo-session] gate lookup failed, denying:', lookupError.message);
      return res.status(200).json({ approved: false, reason: 'unavailable' });
    }
    if (prior && prior.length > 0) {
      return res.status(200).json({ approved: false, reason: 'already_demoed' }); // client shows Toothy's repeat-visitor bubble
    }
    return res.status(200).json({ approved: true, token: mintToken(ipHash) });
  } catch (e: any) {
    console.error('[demo-session] unhandled:', e && e.message);
    return res.status(200).json({ approved: false, reason: 'unavailable' });
  }
}
