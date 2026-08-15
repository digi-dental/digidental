-- 010 — separate real leads from anonymous intent signals
--
-- The problem this fixes:
--
-- `leads` accepts three sources: 'form', 'demo_call' and 'exit_intent'. Only 'form' arrives
-- with contact details. A completed demo call or a dismissed exit-intent popup inserts a row
-- with name, email and phone all NULL — the visitor never typed anything. Those rows are real
-- signal and worth keeping, but they are not leads: there is nobody to contact. They were being
-- counted in `rpc_overview.leads` and listed in the dashboard's Leads table as blank rows, so
-- the headline lead count was inflated and the table was mostly empty rows.
--
-- A lead is now a row you could actually pick up the phone and call: name, email and phone all
-- present, non-blank, plausible email, not a bot. Everything else is an intent signal, still
-- stored, still reported, counted separately.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- qualification
-- A stored generated column rather than a view: it is indexable, it cannot drift from the row
-- it describes, and every existing query keeps working unchanged.
--
-- The email test is deliberately loose (something@something.something). Strict RFC validation
-- rejects addresses that deliver perfectly well, and a false negative here means a real buyer
-- silently disappears from the dashboard — a far worse failure than letting one typo through.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'leads' and column_name = 'is_qualified'
  ) then
    alter table public.leads add column is_qualified boolean
      generated always as (
        coalesce(is_bot, false) = false
        and btrim(coalesce(name, '')) <> ''
        and btrim(coalesce(phone, '')) <> ''
        and btrim(coalesce(email, '')) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[a-zA-Z]{2,}$'
      ) stored;
  end if;
end $$;

-- The dashboard's two hot paths are "qualified leads, newest first" and "count by day".
create index if not exists leads_qualified_created_idx
  on public.leads (is_qualified, created_at desc);

-- ---------------------------------------------------------------- rpc_leads
-- Returns everything, flagged, so one call can drive both the leads table and the signals
-- list. `only_qualified` lets the API ask for just the callable ones without a second function.
--
-- `has_phone` / `has_email` are returned separately from `is_qualified` so the dashboard can
-- say *why* a row did not qualify instead of just hiding it.
create or replace function public.rpc_leads(days int default 30, lim int default 100,
                                            only_qualified boolean default false)
returns table(created_at timestamptz, name text, practice_name text, email text, phone text,
              country text, monthly_call_volume text, locations text, source text,
              visitor_id text, utm_source text, utm_campaign text, referrer_host text,
              is_qualified boolean, has_name boolean, has_email boolean, has_phone boolean)
language sql
stable
security definer
set search_path = public
as $fn$
  select l.created_at, l.name, l.practice_name, l.email, l.phone, l.country,
         l.monthly_call_volume, l.locations, l.source,
         l.visitor_id, l.utm_source, l.utm_campaign, l.referrer_host,
         l.is_qualified,
         btrim(coalesce(l.name, ''))  <> '' as has_name,
         btrim(coalesce(l.email, '')) <> '' as has_email,
         btrim(coalesce(l.phone, '')) <> '' as has_phone
  from leads l, (select _dd_since(days) as since) s
  where l.created_at >= s.since
    and not l.is_bot
    and (not only_qualified or l.is_qualified)
  order by l.created_at desc
  limit greatest(1, least(500, coalesce(lim, 100)))
$fn$;

-- ---------------------------------------------------------------- rpc_lead_totals
-- The counts the headline needs, without pulling any PII across the wire.
create or replace function public.rpc_lead_totals(days int default 30)
returns table(qualified bigint, signals bigint, bots bigint,
              missing_phone bigint, missing_email bigint, missing_name bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select
    count(*) filter (where l.is_qualified)                                          as qualified,
    count(*) filter (where not l.is_qualified and not coalesce(l.is_bot, false))    as signals,
    count(*) filter (where coalesce(l.is_bot, false))                               as bots,
    count(*) filter (where not coalesce(l.is_bot, false)
                       and btrim(coalesce(l.phone, '')) = '')                       as missing_phone,
    count(*) filter (where not coalesce(l.is_bot, false)
                       and btrim(coalesce(l.email, '')) = '')                       as missing_email,
    count(*) filter (where not coalesce(l.is_bot, false)
                       and btrim(coalesce(l.name, '')) = '')                        as missing_name
  from leads l, (select _dd_since(days) as since) s
  where l.created_at >= s.since
$fn$;

-- ---------------------------------------------------------------- rpc_overview
-- Deliberately NOT rewritten here.
--
-- `rpc_overview` is a large function defined in 006, and restating it in this migration just to
-- change how one field is counted would mean two copies of it that drift the first time either
-- is edited. Wrapping it is no better: its return shape differs across deployments, so the
-- wrapper would be guesswork.
--
-- Instead `api/stats.ts` overrides `overview.leads` with the qualified count from
-- rpc_lead_totals and adds `lead_signals` alongside it. That keeps the definition of "a lead"
-- in exactly two places that are easy to keep in step — this file and api/stats.ts — and it
-- means the dashboard reports correctly even on a database where this migration has not been
-- applied yet, because the API can also derive the split from the lead rows themselves.

-- ---------------------------------------------------------------- permissions
-- These read lead PII and bypass RLS by design: execute is revoked from everyone and granted
-- back only to the service role the API uses.
do $$
declare fn text;
begin
  foreach fn in array array[
    'rpc_leads(int,int,boolean)',
    'rpc_lead_totals(int)'
  ] loop
    begin
      execute format('revoke all on function public.%s from public, anon, authenticated', fn);
      execute format('grant execute on function public.%s to service_role', fn);
    exception when undefined_function then
      raise notice '010: %s not present, skipping grant', fn;
    end;
  end loop;
end $$;

-- The three-argument rpc_leads replaces the two-argument one. Dropping the old signature stops
-- PostgREST resolving a stale overload that has no is_qualified column in its result.
drop function if exists public.rpc_leads(int, int);

notify pgrst, 'reload schema';
