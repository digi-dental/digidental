-- Digi Dental — restore missing table grants on leads and demo_sessions
--
-- `leads` and `demo_sessions` were created by a raw CREATE TABLE outside Supabase's normal
-- migration flow (confirmed in the Postgres logs: a bare `create table public.leads`, plus a
-- `supabase_migrations.schema_migrations` table that was bootstrapped but never recorded a
-- version). That flow is what normally applies Supabase's default privilege grants to
-- anon/authenticated/service_role, so both tables ended up with no table-level grants for any
-- of those roles. Only the `postgres` role could touch them.
--
-- What that broke in production, silently:
--   * /api/notify-lead's insert into `leads` failed with "permission denied for table leads" on
--     every submission. supabase-js v2 does not throw on a failed insert unless the caller reads
--     the returned error, and this one does not, so the function carried on and still sent the
--     Resend email. Leads reached the owner's inbox while the table stayed empty.
--   * The browser's direct-to-Supabase fallback path (index.html, used when the serverless route
--     is unavailable) failed for the same reason.
--   * /api/demo-session's SELECT on `demo_sessions` failed, returned nothing, so the gate read it
--     as "no prior demo" and always approved. The claim INSERT failed too. The one-free-demo-per
--     -visitor limit was therefore not enforced at all, leaving the voice demo uncapped.
--
-- This restores only the privileges these tables were always meant to have. It does not change
-- RLS, schema, or data. RLS stays the real gate:
--   * leads has RLS enabled with a single anon INSERT policy (form submissions with a name and
--     email). No anon SELECT policy exists, so lead data stays unreadable from the browser.
--   * demo_sessions has explicit deny policies for anon and authenticated on all four commands.
-- Grants are deliberately narrow: anon gets INSERT on leads only, because the browser fallback
-- needs it. anon gets nothing on demo_sessions. service_role gets the DML it needs and bypasses
-- RLS by design, which is how the serverless functions are meant to work.
grant insert on public.leads to anon;
grant select, insert, update, delete on public.leads to service_role;
grant select, insert, update, delete on public.demo_sessions to service_role;

-- The honeypot column from 002 was never applied either, because 002 was never run. Without it
-- /api/notify-lead's bot branch fails on "column is_bot does not exist", and /api/stats filters
-- on a column that isn't there. Additive and defaulted, so it cannot affect existing rows.
alter table public.leads add column if not exists is_bot boolean not null default false;
