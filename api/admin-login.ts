// /api/admin-login — Vercel serverless function
// Password gate for /admin.html. The dashboard shows lead names, emails and phone numbers, so
// this is a real gate, not an obscure URL.
//
// How it works: the password is compared in constant time against ADMIN_PASSWORD, and on
// success the browser gets an HttpOnly, Secure, SameSite=Strict cookie holding a version, an
// expiry, and an HMAC over both. There is no session table to keep, and the cookie cannot be
// forged without the secret or read by any script on the page.
//
// Three things changed after the security audit:
//   1. The HMAC secret is no longer the password itself. A signing key should be long and
//      random; a password you have to type is neither. Set ADMIN_SESSION_SECRET.
//   2. The cookie carries a version, so bumping ADMIN_SESSION_VERSION signs every existing
//      session out at once — the missing-laptop case.
//   3. Attempts are counted in Postgres rather than in a per-instance Map. The old limit reset
//      on every cold start and traffic spread across instances bypassed it entirely.
//
// Setup: set ADMIN_PASSWORD in Vercel → Settings → Environment Variables. Until it is set the
// dashboard refuses to load rather than falling open.
import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { clientIp } from '../lib/http';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://hctpvnqanwhxlmpmfmme.supabase.co',
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)!
);

// 24 hours by default. This dashboard lists customer names, emails and phone numbers, and a
// week-long cookie means a laptop left on a train stays signed in for six more days. Raise it
// with ADMIN_SESSION_HOURS if the daily login becomes the reason nobody checks the numbers.
const SESSION_MS = Math.max(1, parseInt(process.env.ADMIN_SESSION_HOURS || '24', 10) || 24) * 3600 * 1000;

const ATTEMPT_MAX = 8;
const ATTEMPT_WINDOW_MIN = 15;

// No fallback to ADMIN_PASSWORD. A signing key should be long and random; a password someone
// types is neither, and reusing it meant the cookie's integrity rested on password entropy and
// could only be rotated by changing the password itself.
const signingSecret = () => process.env.ADMIN_SESSION_SECRET || '';
const sessionVersion = () => process.env.ADMIN_SESSION_VERSION || '1';

function sameSecret(a: string, b: string) {
  // Hash both sides first so the comparison is constant time even when the lengths differ —
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  const ba = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ba, bb);
}

// Counted in Postgres so the limit survives cold starts and applies across every instance.
// If the table is unreachable we fail open on the *throttle* only: a database blip must not
// lock the owner out of their own dashboard, and the password check still stands behind it.
async function tooManyAttempts(ipHash: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - ATTEMPT_WINDOW_MIN * 60000).toISOString();
    const { count, error } = await supabase
      .from('auth_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash).eq('ok', false).gte('created_at', since);
    if (error) { console.error('[admin-login] throttle read failed:', error.message); return false; }
    return (count || 0) >= ATTEMPT_MAX;
  } catch (e: any) {
    console.error('[admin-login] throttle threw:', e && e.message);
    return false;
  }
}

async function record(ipHash: string, ok: boolean) {
  try {
    await supabase.from('auth_attempts').insert({ ip_hash: ipHash, ok });
    // Opportunistic cleanup so the table cannot grow without bound.
    if (Math.random() < 0.02) {
      await supabase.from('auth_attempts')
        .delete().lt('created_at', new Date(Date.now() - 7 * 86400000).toISOString());
    }
  } catch (e: any) {
    console.error('[admin-login] attempt write failed:', e && e.message);
  }
}

const cookie = (value: string, maxAgeSec: number) =>
  `dd_admin=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;

export default async function handler(req: any, res: any) {
  try {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD is not set on the server.' });
    // Refuse to mint a cookie we cannot sign properly. Previously this silently fell back to
    // signing with the password, so a deployment that never set a signing key still issued
    // sessions — with the weakest possible key and no way to rotate it independently.
    if (!signingSecret()) {
      console.error('[admin-login] ADMIN_SESSION_SECRET is not set; refusing to issue a session');
      return res.status(503).json({ ok: false, error: 'ADMIN_SESSION_SECRET is not set on the server. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"' });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

    // Signing out needs no password.
    if (body && body.logout) {
      res.setHeader('Set-Cookie', cookie('', 0));
      return res.status(200).json({ ok: true });
    }

    const ip = clientIp(req);
    const ipHash = createHash('sha256').update(ip + (process.env.IP_HASH_SALT || '')).digest('hex');

    if (await tooManyAttempts(ipHash)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
    }

    const given = String((body && body.password) || '');
    if (!given || !sameSecret(given, password)) {
      await record(ipHash, false);
      return res.status(401).json({ ok: false, error: 'That password does not match.' });
    }

    await record(ipHash, true);
    const ver = sessionVersion();
    const exp = String(Date.now() + SESSION_MS);
    const sig = createHmac('sha256', signingSecret()).update(ver + '.' + exp).digest('hex');
    res.setHeader('Set-Cookie', cookie(encodeURIComponent(`${ver}.${exp}.${sig}`), Math.floor(SESSION_MS / 1000)));
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    console.error('[admin-login] handler threw:', e && e.message);
    return res.status(500).json({ ok: false, error: 'Could not sign in.' });
  }
}
