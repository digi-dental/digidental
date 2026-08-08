-- Digi Dental — dashboard aggregation in the database
--
-- /api/stats used to pull up to 50,000 raw rows into the serverless function and aggregate them
-- in JavaScript on every dashboard load. These functions do the same work next to the data and
-- return only the finished numbers, so the endpoint becomes a thin caller.
--
-- All of them are SECURITY DEFINER so they can read a table that has RLS on and no policies.
-- That makes the grant list the entire security boundary, so every function below revokes
-- execute from public/anon/authenticated and grants it to service_role alone. search_path is
-- pinned on each one; a SECURITY DEFINER function with a mutable search_path is a privilege
-- escalation waiting to happen.
--
-- A "visitor" is coalesce(visitor_id, session_id) everywhere: visitor_id is the real identity,
-- and session_id is the fallback for anyone whose browser refuses localStorage, so those visits
-- still count as one person rather than vanishing.

-- ---------------------------------------------------------------------------
-- Window helper. Clamped to 1..365 days so a hand-edited query string cannot ask for a scan
-- of all history.
-- ---------------------------------------------------------------------------
create or replace function public._dd_since(days int)
returns timestamptz
language sql
stable
as $fn$
  select now() - make_interval(days => greatest(1, least(365, coalesce(days, 30))))
$fn$;

-- ---------------------------------------------------------------------------
-- The KPI block behind the top of the dashboard.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_overview(days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.session_id, e.event, e.props, e.created_at
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
sess as (select vid, count(distinct session_id) as n from ev group by vid),
ends as (
  select nullif(props->>'seconds','')::numeric as secs,
         nullif(props->>'max_depth','')::numeric as depth
  from ev where event = 'session_end'
),
ld as (select l.* from leads l, s where l.created_at >= s.since)
select jsonb_build_object(
  'range_days',          greatest(1, least(365, coalesce(days, 30))),
  'generated_at',        now(),
  'visitors',            (select count(*) from sess),
  'returning_visitors',  (select count(*) from sess where n > 1),
  'sessions',            (select count(distinct session_id) from ev where session_id is not null),
  'page_views',          (select count(*) from ev where event = 'page_view'),
  'demo_starts',         (select count(distinct vid) from ev where event = 'demo_start'),
  'demo_completes',      (select count(distinct vid) from ev where event = 'demo_complete'),
  'form_opens',          (select count(distinct vid) from ev where event = 'form_open'),
  'form_submits',        (select count(distinct vid) from ev where event = 'form_submit'),
  'calendly_clicks',     (select count(distinct vid) from ev where event = 'calendly_click'),
  'leads',               (select count(*) from ld where not is_bot),
  'bot_leads',           (select count(*) from ld where is_bot),
  'median_seconds',      coalesce((select percentile_cont(0.5) within group (order by secs) from ends where secs > 0), 0),
  'median_scroll',       coalesce((select percentile_cont(0.5) within group (order by depth) from ends where depth > 0), 0),
  'not_found',           (select count(*) from ev where event = 'page_not_found'),
  'errors',              (select count(*) from ev where event in ('demo_error','form_error','demo_blocked'))
)
$fn$;

-- ---------------------------------------------------------------------------
-- Funnel, counted in unique visitors rather than events. Step 2 reads the real section_view
-- event rather than the old section_time proxy, which only arrived if a visit ended cleanly.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_funnel(days int default 30)
returns table(step int, label text, visitors bigint, pct_of_landed numeric, drop_pct numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
steps(step, label, matcher) as (
  values (1,'Landed on the page','page_view'),
         (2,'Saw the demo section','section_view:demo'),
         (3,'Started a demo call','demo_start'),
         (4,'Finished the demo call','demo_complete'),
         (5,'Opened the booking form','form_open'),
         (6,'Submitted the form','form_submit'),
         (7,'Clicked through to Calendly','calendly_click')
),
counted as (
  select st.step, st.label, count(distinct ev.vid) as visitors
  from steps st
  left join ev on (
    case when st.matcher = 'section_view:demo'
         then ev.event = 'section_view' and ev.props->>'section' = 'demo'
         else ev.event = st.matcher end
  )
  group by st.step, st.label
)
select step, label, visitors,
       round(100.0 * visitors / nullif(first_value(visitors) over (order by step), 0), 1),
       round(100.0 * (lag(visitors) over (order by step) - visitors)
             / nullif(lag(visitors) over (order by step), 0), 1)
from counted
order by step
$fn$;

-- ---------------------------------------------------------------------------
-- Sessions and visitors per day, with empty days filled so the shape of the chart is honest.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_daily(days int default 30)
returns table(day date, visitors bigint, sessions bigint, leads bigint)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
cal as (
  select generate_series(
    (select since::date from s),
    current_date,
    interval '1 day'
  )::date as day
),
ev as (
  select e.created_at::date as day,
         coalesce(e.visitor_id, e.session_id) as vid,
         e.session_id
  from site_events e, s
  where e.created_at >= s.since and e.event = 'page_view'
),
ld as (
  select l.created_at::date as day from leads l, s
  where l.created_at >= s.since and not l.is_bot
)
select cal.day,
       count(distinct ev.vid),
       count(distinct ev.session_id),
       (select count(*) from ld where ld.day = cal.day)
from cal
left join ev on ev.day = cal.day
group by cal.day
order by cal.day
$fn$;

-- ---------------------------------------------------------------------------
-- CTA attribution matrix. Impressions give click-through a denominator, and the last column
-- follows each placement's clickers forward to see who actually submitted afterwards, which is
-- what tells you whether a button earns its position.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_cta_matrix(days int default 30)
returns table(placement text, impressions bigint, clicks bigint, ctr numeric,
              submitted bigint, submit_rate numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props, e.created_at
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
imp as (
  select props->>'location' as loc, count(distinct vid) as n
  from ev where event = 'cta_impression' and props->>'location' is not null group by 1
),
clicks_raw as (
  select props->>'location' as loc, vid, min(created_at) as first_click
  from ev where event = 'cta_click' and props->>'location' is not null group by 1, 2
),
clk as (select loc, count(*) as n from clicks_raw group by 1),
subs as (select vid, min(created_at) as sub_at from ev where event = 'form_submit' group by 1),
conv as (
  select c.loc, count(distinct c.vid) as n
  from clicks_raw c join subs sb on sb.vid = c.vid and sb.sub_at >= c.first_click
  group by 1
),
locs as (select loc from imp union select loc from clk)
select l.loc,
       coalesce(i.n, 0),
       coalesce(c.n, 0),
       round(100.0 * coalesce(c.n, 0) / nullif(i.n, 0), 1),
       coalesce(cv.n, 0),
       round(100.0 * coalesce(cv.n, 0) / nullif(c.n, 0), 1)
from locs l
left join imp i on i.loc = l.loc
left join clk c on c.loc = l.loc
left join conv cv on cv.loc = l.loc
order by coalesce(c.n, 0) desc, coalesce(i.n, 0) desc
$fn$;

-- ---------------------------------------------------------------------------
-- Section analytics: how many got there, how long they stayed, and where they left from.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_sections(days int default 30)
returns table(section text, reach bigint, reach_pct numeric,
              median_seconds numeric, exits bigint, exit_pct numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.session_id, e.event, e.props,
         e.created_at, e.id
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
landed as (select count(distinct vid) as n from ev where event = 'page_view'),
reach as (
  select props->>'section' as sec, count(distinct vid) as n
  from ev where event = 'section_view' and props->>'section' is not null group by 1
),
dwell as (
  -- percentile_cont returns double precision, and round(double, int) does not exist. Cast here
  -- so every caller downstream gets a numeric it can round.
  select t.key as sec,
         (percentile_cont(0.5) within group (order by t.value::numeric))::numeric as med
  from ev, lateral jsonb_each_text(ev.props) as t(key, value)
  where ev.event = 'section_time' and t.value ~ '^[0-9]+(\.[0-9]+)?$' and t.value::numeric > 0
  group by 1
),
last_seen as (
  -- id breaks ties: several beacons from one visit can share a timestamp, and without a
  -- deterministic tiebreak the "last section" would be picked arbitrarily. id is insert order,
  -- which is exactly the ordering we mean by "last".
  select distinct on (session_id) session_id, props->>'section' as sec
  from ev
  where event = 'section_view' and session_id is not null and props->>'section' is not null
  order by session_id, created_at desc, id desc
),
exits as (select sec, count(*) as n from last_seen group by 1),
sess_total as (select count(*) as n from last_seen),
secs as (select sec from reach union select sec from dwell union select sec from exits)
select x.sec,
       coalesce(r.n, 0),
       round(100.0 * coalesce(r.n, 0) / nullif((select n from landed), 0), 1),
       round(coalesce(d.med, 0), 1),
       coalesce(e.n, 0),
       round(100.0 * coalesce(e.n, 0) / nullif((select n from sess_total), 0), 1)
from secs x
left join reach r on r.sec = x.sec
left join dwell d on d.sec = x.sec
left join exits e on e.sec = x.sec
order by coalesce(r.n, 0) desc
$fn$;

-- ---------------------------------------------------------------------------
-- Video: starts, quarter milestones, real seconds watched, and completion as a share of starts.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_video(days int default 30)
returns table(clip text, starts bigint, p25 bigint, p50 bigint, p75 bigint, p95 bigint,
              completion_pct numeric, median_seconds numeric, total_minutes numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
clips as (
  select distinct props->>'clip' as clip from ev
  where event in ('video_play','video_progress','video_watch') and props->>'clip' is not null
),
starts as (select props->>'clip' as clip, count(distinct vid) as n from ev where event = 'video_play' group by 1),
mark as (
  select props->>'clip' as clip, (props->>'percent')::int as pct, count(distinct vid) as n
  from ev where event = 'video_progress' and props->>'percent' ~ '^[0-9]+$' group by 1, 2
),
watch as (
  select props->>'clip' as clip,
         (percentile_cont(0.5) within group (order by (props->>'seconds')::numeric))::numeric as med,
         sum((props->>'seconds')::numeric) as total
  from ev where event = 'video_watch' and props->>'seconds' ~ '^[0-9]+(\.[0-9]+)?$' group by 1
)
select c.clip,
       coalesce(st.n, 0),
       coalesce((select n from mark where clip = c.clip and pct = 25), 0),
       coalesce((select n from mark where clip = c.clip and pct = 50), 0),
       coalesce((select n from mark where clip = c.clip and pct = 75), 0),
       coalesce((select n from mark where clip = c.clip and pct = 95), 0),
       round(100.0 * coalesce((select n from mark where clip = c.clip and pct = 95), 0)
             / nullif(st.n, 0), 1),
       round(coalesce(w.med, 0), 1),
       round(coalesce(w.total, 0) / 60.0, 1)
from clips c
left join starts st on st.clip = c.clip
left join watch w on w.clip = c.clip
order by coalesce(st.n, 0) desc
$fn$;

-- ---------------------------------------------------------------------------
-- Scroll reach: share of visitors getting to each milestone.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_scroll(days int default 30)
returns table(depth int, visitors bigint, pct numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
landed as (select count(distinct vid) as n from ev where event = 'page_view'),
d(depth) as (values (25),(50),(75),(90))
select d.depth,
       (select count(distinct vid) from ev
        where event = 'scroll_depth' and (props->>'depth') ~ '^[0-9]+$'
          and (props->>'depth')::int = d.depth),
       round(100.0 * (select count(distinct vid) from ev
                      where event = 'scroll_depth' and (props->>'depth') ~ '^[0-9]+$'
                        and (props->>'depth')::int = d.depth)
             / nullif((select n from landed), 0), 1)
from d order by d.depth
$fn$;

-- ---------------------------------------------------------------------------
-- Traffic source right through to leads. This is the question the old dashboard could not
-- answer at all: which campaign brings people who actually convert, not just people.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_sources(days int default 30)
returns table(source text, medium text, campaign text, referrer_host text,
              visitors bigint, demo_starts bigint, submits bigint, leads bigint, lead_pct numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event,
         e.utm_source, e.utm_medium, e.utm_campaign, e.referrer_host,
         e.created_at, e.id
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
-- One attribution per visitor: first-touch, i.e. the earliest page_view in the window. The
-- ORDER BY is what makes DISTINCT ON pick that row rather than an arbitrary one, so it is
-- load-bearing and must keep matching the DISTINCT ON expression.
attr as (
  select distinct on (vid) vid,
         coalesce(utm_source, 'none') as src,
         coalesce(utm_medium, 'none') as med,
         coalesce(utm_campaign, 'none') as camp,
         coalesce(referrer_host, 'direct') as host
  from ev where event = 'page_view'
  order by vid, created_at asc, id asc
),
acts as (
  select vid,
         bool_or(event = 'demo_start')  as demoed,
         bool_or(event = 'form_submit') as submitted
  from ev group by vid
),
ld as (
  select distinct l.visitor_id as vid from leads l, s
  where l.created_at >= s.since and not l.is_bot and l.visitor_id is not null
)
select a.src, a.med, a.camp, a.host,
       count(distinct a.vid),
       count(distinct a.vid) filter (where ac.demoed),
       count(distinct a.vid) filter (where ac.submitted),
       count(distinct ld.vid),
       round(100.0 * count(distinct ld.vid) / nullif(count(distinct a.vid), 0), 1)
from attr a
left join acts ac on ac.vid = a.vid
left join ld on ld.vid = a.vid
group by a.src, a.med, a.camp, a.host
order by count(distinct a.vid) desc
$fn$;

-- ---------------------------------------------------------------------------
-- Country / device / city / referrer in one function, so the dashboard does not need four.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_breakdown(days int default 30, dim text default 'country')
returns table(label text, visitors bigint, sessions bigint, leads bigint)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.session_id,
         case lower(coalesce(dim, 'country'))
           when 'device'   then e.device
           when 'city'     then e.city
           when 'referrer' then coalesce(e.referrer_host, 'direct')
           when 'region'   then e.region
           else e.country
         end as label
  from site_events e, s
  where e.created_at >= s.since and e.event = 'page_view'
    and coalesce(e.visitor_id, e.session_id) is not null
),
ld as (
  select distinct l.visitor_id as vid from leads l, s
  where l.created_at >= s.since and not l.is_bot and l.visitor_id is not null
)
select coalesce(ev.label, 'unknown'),
       count(distinct ev.vid),
       count(distinct ev.session_id),
       count(distinct ld.vid)
from ev left join ld on ld.vid = ev.vid
group by 1
order by 2 desc
$fn$;

-- ---------------------------------------------------------------------------
-- Things going wrong: blocked demos, failed calls, form errors, dead links.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_errors(days int default 30)
returns table(event text, detail text, hits bigint, visitors bigint)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props, e.path
  from site_events e, s
  where e.created_at >= s.since and e.category = 'TECHNICAL'
)
select ev.event,
       coalesce(ev.props->>'by', ev.props->>'stage', ev.props->>'field',
                ev.props->>'path', ev.path, 'n/a'),
       count(*),
       count(distinct ev.vid)
from ev
group by 1, 2
order by 3 desc
$fn$;

-- ---------------------------------------------------------------------------
-- Conversion path analysis: which events show up in journeys that converted, compared with
-- journeys that did not. The lift column is the interesting one; a large positive lift means
-- that step is characteristic of people who go on to convert.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_conversion_paths(days int default 30)
returns table(event text, category text, converters bigint, converter_pct numeric,
              non_converters bigint, non_converter_pct numeric, lift numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.category
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
flag as (
  select vid, bool_or(event in ('form_submit','demo_complete','calendly_click')) as converted
  from ev group by vid
),
tot as (
  select count(*) filter (where converted) as c,
         count(*) filter (where not converted) as n
  from flag
),
per as (
  select ev.event, min(ev.category) as category,
         count(distinct ev.vid) filter (where f.converted) as c,
         count(distinct ev.vid) filter (where not f.converted) as n
  from ev join flag f on f.vid = ev.vid
  group by ev.event
)
select per.event, per.category, per.c,
       round(100.0 * per.c / nullif((select c from tot), 0), 1),
       per.n,
       round(100.0 * per.n / nullif((select n from tot), 0), 1),
       round(100.0 * per.c / nullif((select c from tot), 0)
             - 100.0 * per.n / nullif((select n from tot), 0), 1)
from per
order by 7 desc nulls last
$fn$;

-- ---------------------------------------------------------------------------
-- Visitor list for the drill-down, most recently active first.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_visitors(days int default 30, lim int default 100)
returns table(visitor_id text, first_seen timestamptz, last_seen timestamptz,
              sessions bigint, events bigint, country text, device text,
              source text, converted boolean, is_lead boolean)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.*
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
agg as (
  select vid,
         min(created_at) as first_seen,
         max(created_at) as last_seen,
         count(distinct session_id) as sessions,
         count(*) as events,
         max(country) as country,
         max(device) as device,
         coalesce(max(utm_source), max(referrer_host), 'direct') as source,
         bool_or(event in ('form_submit','demo_complete','calendly_click')) as converted
  from ev group by vid
),
ld as (
  select distinct l.visitor_id as vid from leads l, s
  where l.created_at >= s.since and not l.is_bot and l.visitor_id is not null
)
select a.vid, a.first_seen, a.last_seen, a.sessions, a.events,
       a.country, a.device, a.source, a.converted, (ld.vid is not null)
from agg a left join ld on ld.vid = a.vid
order by a.last_seen desc
limit greatest(1, least(500, coalesce(lim, 100)))
$fn$;

-- ---------------------------------------------------------------------------
-- One visitor's full timeline, for the drill-down view.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_visitor_journey(vid text, lim int default 500)
returns table(created_at timestamptz, session_id text, event text, category text,
              props jsonb, path text, country text, device text)
language sql
stable
security definer
set search_path = public
as $fn$
  select e.created_at, e.session_id, e.event, e.category, e.props, e.path, e.country, e.device
  from site_events e
  where coalesce(e.visitor_id, e.session_id) = vid
  order by e.created_at, e.id
  limit greatest(1, least(2000, coalesce(lim, 500)))
$fn$;

-- ---------------------------------------------------------------------------
-- Recent leads, bots excluded, now carrying their attribution.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_leads(days int default 30, lim int default 100)
returns table(created_at timestamptz, name text, practice_name text, email text, phone text,
              country text, monthly_call_volume text, locations text, source text,
              visitor_id text, utm_source text, utm_campaign text, referrer_host text)
language sql
stable
security definer
set search_path = public
as $fn$
  select l.created_at, l.name, l.practice_name, l.email, l.phone, l.country,
         l.monthly_call_volume, l.locations, l.source,
         l.visitor_id, l.utm_source, l.utm_campaign, l.referrer_host
  from leads l, (select _dd_since(days) as since) s
  where l.created_at >= s.since and not l.is_bot
  order by l.created_at desc
  limit greatest(1, least(500, coalesce(lim, 100)))
$fn$;

-- ---------------------------------------------------------------------------
-- Lock the doors. These functions read lead PII and bypass RLS by design, so execute is
-- revoked from everyone and granted back only to the service role the API uses.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    '_dd_since(int)', 'rpc_overview(int)', 'rpc_funnel(int)', 'rpc_daily(int)',
    'rpc_cta_matrix(int)', 'rpc_sections(int)', 'rpc_video(int)', 'rpc_scroll(int)',
    'rpc_sources(int)', 'rpc_breakdown(int,text)', 'rpc_errors(int)',
    'rpc_conversion_paths(int)', 'rpc_visitors(int,int)', 'rpc_visitor_journey(text,int)',
    'rpc_leads(int,int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- Make the new objects visible to the REST API immediately rather than on the next cache cycle.
notify pgrst, 'reload schema';
