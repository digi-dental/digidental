// /api/admin-login — Vercel serverless function
// Password gate for /admin.html. The dashboard shows lead names and emails, so this is a
// real gate, not an obscure URL.
//
// How it works: the password is compared in constant time against ADMIN_PASSWORD, and on
// success the browser gets an HttpOnly, Secure, SameSite=Strict cookie holding an expiry
// plus an HMAC of that expiry. There is no session table to keep, and the cookie cannot be
// forged without the secret or read by any script on the page.
//
// Setup: set ADMIN_PASSWORD in Vercel → Settings → Environment Variables. Until it is set
// the dashboard refuses to load rather than falling open.
import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// Per-IP throttle so the password cannot be ground down by brute force.
const ATTEMPT_MAX = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, number[]>();

function tooManyAttempts(ip: string) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(t => now - t < ATTEMPT_WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 2000) attempts.clear();
  return recent.length > ATTEMPT_MAX;
}

function sameSecret(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export default async function handler(req: any, res: any) {
  try {
    const secret = process.env.ADMIN_PASSWORD;
    if (!secret) return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD is not set on the server.' });
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

    // Signing out needs no password.
    if (body && body.logout) {
      res.setHeader('Set-Cookie', 'dd_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
      return res.status(200).json({ ok: true });
    }

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooManyAttempts(ip)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });

    const password = String((body && body.password) || '');
    if (!password || !sameSecret(password, secret)) {
      return res.status(401).json({ ok: false, error: 'That password does not match.' });
    }

    const exp = String(Date.now() + SESSION_MS);
    const token = exp + '.' + createHmac('sha256', secret).update(exp).digest('hex');
    res.setHeader('Set-Cookie', `dd_admin=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not sign in.' });
  }
}
