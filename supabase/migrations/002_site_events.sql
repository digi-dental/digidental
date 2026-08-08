-- ============================================================================
-- SUPERSEDED — DO NOT RUN.
-- This migration was never applied to production (schema_migrations was empty and the
-- site_events table did not exist). It is kept only as history. The finished schema,
-- including the columns this file and 003 would have added plus visitor_id and category,
-- is created by 005_analytics_core.sql. Running this now would conflict with 005.
-- ============================================================================

-- Digi Dental — first-party funnel analytics (BUG-12)
-- Written only by /api/event using the service role. No anon policies: the browser can never
-- read or write this table directly.
create table public.site_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event text not null,
  props jsonb not null default '{}'::jsonb,
  session_id text,              -- random per browser tab; lets steps of one visit be joined
  path text,
  referrer text,
  ip_hash text                  -- SHA-256 of visitor IP + server salt; raw IPs are never stored
);
create index site_events_event_idx on public.site_events (event, created_at desc);
create index site_events_session_idx on public.site_events (session_id);

alter table public.site_events enable row level security;
-- No policies at all: service role only.

-- Honeypot column on leads so a bot submission can be recorded (and ignored) rather than
-- silently dropped, if you ever want to see how much of that traffic there is.
alter table public.leads add column if not exists is_bot boolean not null default false;

-- ---------------------------------------------------------------------------
-- The four KPIs from day one. Run these in the Supabase SQL editor.
-- ---------------------------------------------------------------------------
-- Demo start → completion (target ≥60%):
--   select count(*) filter (where event = 'demo_complete')::numeric
--          / nullif(count(*) filter (where event = 'demo_start'), 0) as completion_rate
--   from site_events where created_at > now() - interval '30 days';
--
-- Demo complete → Calendly click (target ≥25%):
--   with d as (select distinct session_id from site_events where event = 'demo_complete'),
--        c as (select distinct session_id from site_events where event = 'calendly_click')
--   select count(*)::numeric / nullif((select count(*) from d), 0) from d join c using (session_id);
--
-- Form open → submit (target ≥40%), plus per-step drop-off:
--   select event, count(distinct session_id) from site_events
--   where event in ('form_open','form_step_1','form_step_2','form_step_3','form_step_4','form_step_5','form_submit')
--   group by event order by event;
--
-- Exit-intent conversion (desktop only):
--   with s as (select distinct session_id from site_events where event = 'exit_intent_shown'),
--        t as (select distinct session_id from site_events where event = 'exit_intent_demo')
--   select count(*)::numeric / nullif((select count(*) from s), 0) from s join t using (session_id);
