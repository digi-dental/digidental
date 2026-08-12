-- ============================================================================
-- PASTE THIS WHOLE FILE into Supabase → SQL Editor → New query → Run.
-- It is migration 009 on its own. Safe to run more than once.
-- The last statement prints four rows; every `result` should read 1.
-- ============================================================================

-- 009 — demo-gate atomicity and lead-shape hardening
--
-- Two problems this closes:
--
--   1. The free-demo gate did `select ... where ip_hash = $1` and then `insert`. Two requests
--      arriving together both saw "no prior demo" and both inserted, so one visitor could
--      claim several free 60-second voice calls. A unique index makes the insert itself the
--      decision: whoever lands first wins, everyone after conflicts. No round trip in between
--      for a racer to slip through.
--
--   2. `leads` accepted anon inserts with `with check (true)`. RLS blocks reads, so this was
--      never a disclosure risk, but anyone holding the publishable key could push unbounded
--      junk straight at the REST API. Bounding shape and length costs nothing and makes the
--      table's contract explicit.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- demo gate
-- A unique index cannot be created while duplicates exist. Collapse any that the old
-- check-then-insert path already produced, keeping the earliest row per hash.
delete from public.demo_sessions a
using public.demo_sessions b
where a.ip_hash = b.ip_hash
  and (a.created_at, a.id) > (b.created_at, b.id);

create unique index if not exists demo_sessions_ip_hash_key
  on public.demo_sessions (ip_hash);

-- The plain index from 001 is now redundant: the unique index serves the same lookups.
drop index if exists public.demo_sessions_ip_hash_idx;

-- ---------------------------------------------------------------- lead shape
-- Trim anything already over the limits so the constraints below can be added without
-- failing on historical rows.
update public.leads set
  name                = left(name, 200),
  practice_name       = left(practice_name, 200),
  email               = left(email, 320),
  phone               = left(phone, 40),
  country             = left(country, 80),
  monthly_call_volume = left(monthly_call_volume, 40),
  locations           = left(locations, 20)
where length(name) > 200 or length(practice_name) > 200 or length(email) > 320
   or length(phone) > 40 or length(country) > 80
   or length(monthly_call_volume) > 40 or length(locations) > 20;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_field_lengths') then
    alter table public.leads add constraint leads_field_lengths check (
      coalesce(length(name), 0)                <= 200
      and coalesce(length(practice_name), 0)   <= 200
      and coalesce(length(email), 0)           <= 320
      and coalesce(length(phone), 0)           <= 40
      and coalesce(length(country), 0)         <= 80
      and coalesce(length(monthly_call_volume), 0) <= 40
      and coalesce(length(locations), 0)       <= 20
    );
  end if;
end $$;

-- Replace the blanket anon insert policy. Deliberately permissive about WHICH details are
-- present: a demo_call or exit_intent lead legitimately has no contact fields, and turning
-- away a real enquiry costs far more than storing a junk row. It only enforces that the row
-- is the right shape, and that a form submission carries some way to reply.
drop policy if exists "anon can insert leads" on public.leads;
create policy "anon can insert leads" on public.leads
  for insert to anon
  with check (
    source in ('form', 'demo_call', 'exit_intent')
    and coalesce(length(name), 0)                <= 200
    and coalesce(length(practice_name), 0)       <= 200
    and coalesce(length(email), 0)               <= 320
    and coalesce(length(phone), 0)               <= 40
    and coalesce(length(country), 0)             <= 80
    and coalesce(length(monthly_call_volume), 0) <= 40
    and coalesce(length(locations), 0)           <= 20
    -- validated only when present, so a missing address is never the reason a lead is lost
    and (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
    and (source <> 'form' or email is not null or phone is not null)
  );

-- ---------------------------------------------------------------- retention
-- Honeypot hits are kept briefly so the bot rate stays measurable, then dropped. Real leads
-- age out after two years. Call manually, or from pg_cron if it is enabled on the project:
--   select cron.schedule('dd-sweep', '0 4 * * 0', $$select public.rpc_sweep()$$);
create or replace function public.rpc_sweep()
returns table (bots_deleted bigint, leads_deleted bigint, events_deleted bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare b bigint; l bigint; e bigint;
begin
  delete from public.leads where is_bot and created_at < now() - interval '30 days';
  get diagnostics b = row_count;
  delete from public.leads where not is_bot and created_at < now() - interval '24 months';
  get diagnostics l = row_count;
  delete from public.site_events where created_at < now() - interval '24 months';
  get diagnostics e = row_count;
  return query select b, l, e;
end $$;

revoke all on function public.rpc_sweep() from public, anon, authenticated;
grant execute on function public.rpc_sweep() to service_role;

-- ---------------------------------------------------------------- verification
select 'demo_sessions unique index' as check,
       (select count(*) from pg_indexes
         where schemaname = 'public' and indexname = 'demo_sessions_ip_hash_key')::text as result
union all
select 'leads length constraint',
       (select count(*) from pg_constraint where conname = 'leads_field_lengths')::text
union all
select 'leads anon insert policy',
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'leads' and policyname = 'anon can insert leads')::text
union all
select 'rpc_sweep created',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'rpc_sweep')::text;
