-- Digi Dental — analytics core
--
-- Replaces the never-applied 002 and 003. Those two were written as separate steps and neither
-- ever ran, so there is no production table to migrate: this creates the finished shape in one
-- go, with the columns 002 and 003 would have added plus the two the audit found missing.
-- 002 and 003 are kept in the repo as history and must not be run; this file supersedes them.
--
-- Written only by /api/event and /api/notify-lead using the service role. RLS is on with no
-- policies at all, so the browser can never read or write this table directly.

create table if not exists public.site_events (
  -- bigint identity rather than uuid: this table is append-only and time-ordered, and a
  -- monotonic key keeps the index tight as it grows.
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),

  event         text not null,
  -- BEHAVIOR | INTENT | CONVERSION | TECHNICAL. Written by the API from its own lookup so the
  -- dashboard can filter a whole class of events without matching on names.
  category      text not null default 'BEHAVIOR',
  props         jsonb not null default '{}'::jsonb,

  -- Identity, in three separate pieces (see the audit):
  --   visitor_id  persistent, anonymous, from localStorage. Counts people.
  --   session_id  one visit, with a 30-minute idle rollover. Groups the steps of a visit.
  --   ip_hash     salted SHA-256, for abuse control only. Never used as identity.
  visitor_id    text,
  session_id    text,
  ip_hash       text,

  path          text,
  referrer      text,
  referrer_host text,

  -- Campaign attribution, parsed at the edge so the dashboard never has to unpick a query string.
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,

  -- Geography from Vercel's edge headers: no IP lookup, no third-party tracker, raw IP never stored.
  country       text,
  region        text,
  city          text,
  device        text
);

-- Every dashboard query filters on a time window first, then narrows by one of these.
create index if not exists site_events_created_idx  on public.site_events (created_at desc);
create index if not exists site_events_event_idx    on public.site_events (event, created_at desc);
create index if not exists site_events_visitor_idx  on public.site_events (visitor_id, created_at desc);
create index if not exists site_events_session_idx  on public.site_events (session_id, created_at);
create index if not exists site_events_category_idx on public.site_events (category, created_at desc);
create index if not exists site_events_country_idx  on public.site_events (country, created_at desc);

alter table public.site_events enable row level security;
-- Deliberately no policies: service role only. Nothing to grant to anon or authenticated.
grant select, insert on public.site_events to service_role;

-- ---------------------------------------------------------------------------
-- Tie a lead back to the visit that produced it.
--
-- Until now `leads` had no link to `site_events` at all, so there was no way to ask which
-- traffic source, which CTA, or which journey produced a booking. These are plain nullable
-- text columns rather than foreign keys: a lead must still be recorded even if the analytics
-- write failed or the visitor blocked storage. Losing attribution is acceptable; losing a
-- lead is not.
-- ---------------------------------------------------------------------------
alter table public.leads add column if not exists visitor_id   text;
alter table public.leads add column if not exists session_id   text;
alter table public.leads add column if not exists utm_source   text;
alter table public.leads add column if not exists utm_medium   text;
alter table public.leads add column if not exists utm_campaign text;
alter table public.leads add column if not exists referrer_host text;

create index if not exists leads_visitor_idx on public.leads (visitor_id);
create index if not exists leads_created_idx on public.leads (created_at desc);

-- ---------------------------------------------------------------------------
-- Login throttling that survives a cold start.
--
-- The old per-IP limits lived in an in-memory Map inside the lambda, so they reset whenever a
-- new instance warmed up and traffic spread across instances bypassed them entirely. Keeping
-- attempts in Postgres makes the limit real.
-- ---------------------------------------------------------------------------
create table if not exists public.auth_attempts (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  ip_hash    text not null,
  ok         boolean not null default false
);
create index if not exists auth_attempts_idx on public.auth_attempts (ip_hash, created_at desc);
alter table public.auth_attempts enable row level security;
grant select, insert, delete on public.auth_attempts to service_role;

-- Make the new objects visible to the REST API immediately rather than on the next cache cycle.
notify pgrst, 'reload schema';
