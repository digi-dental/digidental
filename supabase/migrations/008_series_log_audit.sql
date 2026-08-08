-- Digi Dental — switchable metric series, the raw click log, and the monthly audit
--
-- Three things the dashboard could not do:
--   * plot one big line per metric and switch between them without refetching
--   * show individual clicks with when, who, what, where and from which region
--   * look back over months rather than a rolling window, and see where conversions came from
--
-- Same posture as 006/007: SECURITY DEFINER, pinned search_path, execute revoked from
-- anon/authenticated and granted to service_role only.

-- ---------------------------------------------------------------------------
-- Every headline metric per day, in one call.
--
-- Returning all metrics together rather than one per request means the hero chart can switch
-- instantly between them with no round trip, and every series is guaranteed to cover exactly
-- the same days — which is what makes them comparable.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_series(days int default 30)
returns table(day date, visitors bigint, sessions bigint, page_views bigint,
              clicks bigint, demo_starts bigint, form_submits bigint,
              contacts bigint, leads bigint)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
cal as (
  select generate_series((select since::date from s), current_date, interval '1 day')::date as day
),
ev as (
  select e.created_at::date as day,
         coalesce(e.visitor_id, e.session_id) as vid,
         e.session_id, e.event
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
ld as (
  select l.created_at::date as day from leads l, s
  where l.created_at >= s.since and not l.is_bot
)
select cal.day,
       count(distinct ev.vid) filter (where ev.event = 'page_view'),
       count(distinct ev.session_id) filter (where ev.event = 'page_view'),
       count(*) filter (where ev.event = 'page_view'),
       count(*) filter (where ev.event = 'element_click'),
       count(distinct ev.vid) filter (where ev.event = 'demo_start'),
       count(distinct ev.vid) filter (where ev.event = 'form_submit'),
       count(distinct ev.vid) filter (where ev.event in ('contact_click','calendly_click')),
       (select count(*) from ld where ld.day = cal.day)
from cal
left join ev on ev.day = cal.day
group by cal.day
order by cal.day
$fn$;

-- ---------------------------------------------------------------------------
-- The raw click log: one row per click, with when, who, what and where.
--
-- This is the record behind the click-through rates. Everything here is already stored on the
-- event; nothing new is collected. The visitor id stays anonymous and the IP is never exposed —
-- geography comes from the coarse edge headers, so region and city are approximate by design.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_click_log(days int default 30, lim int default 500)
returns table(occurred_at timestamptz, label text, section text, kind text,
              visitor_id text, is_lead boolean,
              country text, region text, city text, device text,
              source text, path text)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ld as (
  select distinct l.visitor_id as vid from leads l, s
  where l.created_at >= s.since and not l.is_bot and l.visitor_id is not null
)
select e.created_at,
       coalesce(e.props->>'label', e.props->>'location', e.event),
       coalesce(e.props->>'section', 'unknown'),
       coalesce(e.props->>'kind', case when e.event = 'contact_click' then e.props->>'channel' else 'button' end),
       coalesce(e.visitor_id, e.session_id),
       (ld.vid is not null),
       e.country, e.region, e.city, e.device,
       coalesce(e.utm_source, e.referrer_host, 'direct'),
       e.path
-- The window comes from a scalar subquery rather than a cross join: in `FROM a, b LEFT JOIN c`
-- the join binds to b alone, so `e` would not be in scope inside the ON clause.
from site_events e
left join ld on ld.vid = coalesce(e.visitor_id, e.session_id)
where e.created_at >= (select since from s)
  and e.event in ('element_click', 'cta_click', 'contact_click', 'calendly_click')
order by e.created_at desc
limit greatest(1, least(5000, coalesce(lim, 500)))
$fn$;

-- ---------------------------------------------------------------------------
-- Monthly audit. Calendar months rather than a rolling window, so a month can be compared
-- with the one before it.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_monthly(months int default 12)
returns table(month date, visitors bigint, sessions bigint, clicks bigint,
              demo_starts bigint, form_submits bigint, contacts bigint,
              leads bigint, lead_rate numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with w as (
  select date_trunc('month', now())::date
       - make_interval(months => greatest(1, least(36, coalesce(months, 12))) - 1) as since
),
cal as (
  select generate_series((select since from w), date_trunc('month', now())::date, interval '1 month')::date as month
),
ev as (
  select date_trunc('month', e.created_at)::date as month,
         coalesce(e.visitor_id, e.session_id) as vid, e.session_id, e.event
  from site_events e, w
  where e.created_at >= w.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
ld as (
  select date_trunc('month', l.created_at)::date as month from leads l, w
  where l.created_at >= w.since and not l.is_bot
),
agg as (
  select cal.month,
         count(distinct ev.vid) filter (where ev.event = 'page_view') as visitors,
         count(distinct ev.session_id) filter (where ev.event = 'page_view') as sessions,
         count(*) filter (where ev.event = 'element_click') as clicks,
         count(distinct ev.vid) filter (where ev.event = 'demo_start') as demo_starts,
         count(distinct ev.vid) filter (where ev.event = 'form_submit') as form_submits,
         count(distinct ev.vid) filter (where ev.event in ('contact_click','calendly_click')) as contacts,
         (select count(*) from ld where ld.month = cal.month) as leads
  from cal left join ev on ev.month = cal.month
  group by cal.month
)
select month, visitors, sessions, clicks, demo_starts, form_submits, contacts, leads,
       round(100.0 * leads / nullif(visitors, 0), 1)
from agg
order by month
$fn$;

-- ---------------------------------------------------------------------------
-- Where those monthly conversions came from. `dim` picks the grouping.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_monthly_breakdown(months int default 12, dim text default 'source')
returns table(month date, label text, visitors bigint, form_submits bigint,
              contacts bigint, leads bigint, lead_rate numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with w as (
  select date_trunc('month', now())::date
       - make_interval(months => greatest(1, least(36, coalesce(months, 12))) - 1) as since
),
ev as (
  select date_trunc('month', e.created_at)::date as month,
         coalesce(e.visitor_id, e.session_id) as vid,
         e.event,
         case lower(coalesce(dim, 'source'))
           when 'country' then coalesce(e.country, 'unknown')
           when 'device'  then coalesce(e.device, 'unknown')
           when 'campaign' then coalesce(e.utm_campaign, 'none')
           else coalesce(e.utm_source, e.referrer_host, 'direct')
         end as label
  from site_events e, w
  where e.created_at >= w.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
ld as (
  select date_trunc('month', l.created_at)::date as month,
         l.visitor_id as vid,
         case lower(coalesce(dim, 'source'))
           when 'country' then coalesce(l.country, 'unknown')
           when 'device'  then 'unknown'
           when 'campaign' then coalesce(l.utm_campaign, 'none')
           else coalesce(l.utm_source, l.referrer_host, 'direct')
         end as label
  from leads l, w
  where l.created_at >= w.since and not l.is_bot
)
select e.month, e.label,
       count(distinct e.vid) filter (where e.event = 'page_view'),
       count(distinct e.vid) filter (where e.event = 'form_submit'),
       count(distinct e.vid) filter (where e.event in ('contact_click','calendly_click')),
       (select count(*) from ld where ld.month = e.month and ld.label = e.label),
       round(100.0 * (select count(*) from ld where ld.month = e.month and ld.label = e.label)
             / nullif(count(distinct e.vid) filter (where e.event = 'page_view'), 0), 1)
from ev e
group by e.month, e.label
having count(distinct e.vid) filter (where e.event = 'page_view') > 0
order by e.month desc, 3 desc
$fn$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'rpc_series(int)', 'rpc_click_log(int,int)', 'rpc_monthly(int)', 'rpc_monthly_breakdown(int,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

notify pgrst, 'reload schema';
