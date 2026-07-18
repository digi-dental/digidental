# Digi Dental — one-page conversion funnel

Single-page site selling a done-for-you AI receptionist for dental practices.
Design + full front-end lives in `Digi Dental.dc.html` (open in a browser).
Repo scaffolding for the production build (React + Vite + Tailwind + Vercel functions + Supabase):

- `api/demo-session.ts` — one-demo-per-IP gate (called before every demo call)
- `api/notify-lead.ts` — Supabase insert + owner email via Resend
- `supabase/migrations/001_leads_and_demo_sessions.sql` — tables + RLS
- `.env.example` — every required variable, placeholder values only

## Where real keys go
Real values are entered ONLY in your local `.env` (gitignored) and in the hosting
dashboard (Vercel → Project → Settings → Environment Variables). Never in code.

- `VITE_*` vars are public by design (anon key is protected by RLS; the Voice Infrastructure key is the PUBLIC web key).
- `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_HASH_SALT`, `NOTIFY_EMAIL_TO` are server-side only.

## Demo call hard limits
The client stops the call at 60s, but the real limit lives in the Voice Infrastructure dashboard:
set `maxDurationSeconds: 60` and a spend cap on the demo assistant.

## Before launch checklist
Search the code for `PLACEHOLDER`: testimonials, Calendly embed, WhatsApp link,
legal copy, verified Resend sender, compliance language. Statistics were sourced
June 2026 — refresh annually.
