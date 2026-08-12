// Shared helpers for the serverless functions in api/.
// Lives outside api/ so Vercel does not publish it as an endpoint.

/**
 * The real client IP.
 *
 * Every IP-keyed control on this site — the one-free-demo gate, the lead rate limit, the
 * admin login throttle — used to read `x-forwarded-for` and take element [0]. That element
 * is attacker-controlled: a proxy chain PREPENDS the client's own value and appends the real
 * address as it travels, so anyone can send `X-Forwarded-For: 1.2.3.4` and be seen as a new
 * visitor on every request. For the demo gate that meant unlimited 60-second voice calls
 * billed to us; for notify-lead, unlimited mail to the owner's inbox.
 *
 * Order of trust:
 *   1. `x-vercel-forwarded-for` — set by Vercel's edge, not forwardable by the client.
 *   2. the LAST element of `x-forwarded-for` — the hop nearest us, appended by our own proxy.
 *      A spoofed value sits at the front, so taking the tail steps over it.
 *   3. `x-real-ip`.
 */
export function clientIp(req: any): string {
  const h = req && req.headers ? req.headers : {};
  const pick = (v: any) => (Array.isArray(v) ? v[v.length - 1] : v);
  const xff = pick(h['x-forwarded-for']);
  const last = typeof xff === 'string' && xff.length ? xff.split(',').pop() : '';
  const raw = pick(h['x-vercel-forwarded-for']) || last || pick(h['x-real-ip']) || '';
  return String(raw).trim().slice(0, 64) || 'unknown';
}

/**
 * Escape a value for interpolation into HTML.
 *
 * The owner's lead-notification email interpolated visitor-supplied fields raw, so a lead
 * named `<a href="https://evil.example">Confirm your slot</a>` rendered as a working link
 * inside a message the founder trusts. Mail clients do not run scripts, but a trusted inbox
 * is exactly where a convincing link does damage.
 */
export function escHtml(v: unknown): string {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip control characters, which corrupt both email headers and dashboard rendering. */
export function clean(v: unknown, max = 200): string {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** A deliberately permissive shape check — the goal is to reject junk, not to police addresses. */
export function looksLikeEmail(v: unknown): boolean {
  const s = String(v == null ? '' : v).trim();
  return s.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

/**
 * Flatten an arbitrary object into something safe to store as jsonb: shallow, bounded key
 * count, bounded value length. Unbounded `props` let a bot inflate rows and indices for free.
 */
export function safeProps(input: unknown, maxKeys = 12, maxLen = 120): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= maxKeys) break;
    if (v == null) continue;
    const key = k.slice(0, 48);
    if (typeof v === 'number' || typeof v === 'boolean') { out[key] = v; n++; continue; }
    if (typeof v === 'string') { out[key] = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLen); n++; continue; }
    // objects/arrays are summarised rather than stored
    out[key] = JSON.stringify(v).slice(0, maxLen); n++;
  }
  return out;
}

/**
 * Referrers are stored for attribution, but a full URL can carry sensitive query parameters
 * (calendar invite ids, password-reset tokens, session ids in older apps). Origin + path is
 * all attribution needs.
 */
export function trimReferrer(v: unknown, max = 300): string {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.origin + u.pathname).slice(0, max);
  } catch {
    return s.split('?')[0].split('#')[0].slice(0, max);
  }
}
