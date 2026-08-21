-- 010 — two-page analytics
--
-- The site was one document when 006 was written, and every aggregate in it assumes that.
-- Since the funnel was split across `/` and `/how-it-works/` that assumption produces three
-- kinds of wrong number, none of which look wrong on the dashboard:
--
--   1. Section names are not unique across the two documents. `case_study` and `final` exist
--      on both. rpc_sections groups on the name alone, so those two rows are the sum of two
--      different sections on two different pages — reach, dwell and exits all added together.
--
--   2. reach_pct divides by every visitor who viewed any page. A section on the deep page can
--      only ever be seen by the subset who got to the deep page, so every deep-page section
--      reads as underperforming by exactly the share of traffic that never left the home page.
--      The same applies to rpc_scroll, which additionally mixes two documents of very
--      different heights into a single depth curve: 90% of the home page and 90% of the deep
--      page are not the same journey.
--
--   3. rpc_funnel steps straight from "landed" to "saw the demo section", and the demo section
--      now lives only on the deep page. The single largest drop in the funnel — people who
--      never make the jump between pages — is invisible, folded into the demo step.
--
-- And there was no per-page view at all: nothing answered "how many people land on each page,
-- and how many cross from one to the other", which is the first question a two-page funnel
-- raises.
--
-- `path` has been recorded on every event since 005, so this is entirely a reporting fix. No
-- table changes, no backfill, and every number below is recomputed from history already
-- stored.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Which document an event happened on, from its stored path.
--
-- Deliberately tolerant: paths arrive as location.pathname, so the deep page shows up as
-- '/how-it-works/' and '/how-it-works' alike, and the home page as '/' or (from an older
-- client, or a direct hit on the file) '/index.html'. Anything else — 404s, /admin.html —
-- is 'other' rather than silently counted as home.
-- ---------------------------------------------------------------------------
create or replace function public._dd_page(p text)
returns text
language sql
immutable
as $fn$
  select case
    when p is null or p = '' then 'home'
    when p = '/' or p = '/index.html' then 'home'
    when p = '/how-it-works' or p like '/how-it-works/%' then 'deep'
    else 'other'
  end
$fn$;

-- ---------------------------------------------------------------------------
-- Per-page traffic and what it turns into.
--
-- `entries` is the landing page: the page of the session's FIRST page_view, which is the only
-- honest way to say which document brought someone in. `crossed` is the two-page number
-- proper — visitors of this page who also viewed the other one.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_pages(days int default 30)
returns table(page text, views bigint, visitors bigint, sessions bigint,
              entries bigint, entry_pct numeric, crossed bigint, crossed_pct numeric,
              leads bigint)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
pv as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.session_id, e.id, e.created_at,
         _dd_page(e.path) as pg
  from site_events e, s
  where e.created_at >= s.since
    and e.event = 'page_view'
    and coalesce(e.visitor_id, e.session_id) is not null
),
-- id breaks ties the same way rpc_sections does: several beacons from one visit can share a
-- timestamp, and insert order is what "first" actually means here.
first_pv as (
  select distinct on (session_id) session_id, pg
  from pv where session_id is not null
  order by session_id, created_at, id
),
sess_total as (select count(*) as n from first_pv),
-- A visitor who saw more than one distinct page crossed, whichever direction they went.
multi as (
  select vid from pv group by vid having count(distinct pg) > 1
),
ld as (
  select distinct l.visitor_id as vid from leads l, s
  where l.created_at >= s.since and not l.is_bot and l.visitor_id is not null
),
-- Both joins are at most 1:1 on vid (ld is distinct, multi is grouped), so count(*) is
-- still the real page_view count and nothing is double-counted.
agg as (
  select pv.pg,
         count(*) as views,
         count(distinct pv.vid) as visitors,
         count(distinct pv.session_id) as sessions,
         count(distinct m.vid) as crossed,
         count(distinct ld.vid) as leads
  from pv
  left join ld on ld.vid = pv.vid
  left join multi m on m.vid = pv.vid
  group by pv.pg
),
ent as (select pg, count(*) as n from first_pv group by pg)
select a.pg,
       a.views, a.visitors, a.sessions,
       coalesce(e.n, 0),
       round(100.0 * coalesce(e.n, 0) / nullif((select n from sess_total), 0), 1),
       a.crossed,
       round(100.0 * a.crossed / nullif(a.visitors, 0), 1),
       a.leads
from agg a left join ent e on e.pg = a.pg
order by a.visitors desc
$fn$;

-- ---------------------------------------------------------------------------
-- Sections, now keyed by (page, section) rather than by section name alone, with reach
-- measured against the visitors of the page the section is actually on.
--
-- Exits stay global on purpose: the exit is wherever the visit stopped, and a visit can span
-- both documents, so the denominator is every session that saw any section anywhere.
--
-- The return type changes, so this is a drop-and-create rather than a replace.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_sections(int);
create or replace function public.rpc_sections(days int default 30)
returns table(page text, section text, reach bigint, reach_pct numeric,
              median_seconds numeric, exits bigint, exit_pct numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.session_id, e.event, e.props,
         e.created_at, e.id, _dd_page(e.path) as pg
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
-- One denominator per page instead of one for the whole site.
landed as (
  select pg, count(distinct vid) as n from ev where event = 'page_view' group by pg
),
reach as (
  select pg, props->>'section' as sec, count(distinct vid) as n
  from ev where event = 'section_view' and props->>'section' is not null group by 1, 2
),
dwell as (
  -- percentile_cont returns double precision, and round(double, int) does not exist. Cast here
  -- so every caller downstream gets a numeric it can round.
  select ev.pg, t.key as sec,
         (percentile_cont(0.5) within group (order by t.value::numeric))::numeric as med
  from ev, lateral jsonb_each_text(ev.props) as t(key, value)
  where ev.event = 'section_time' and t.value ~ '^[0-9]+(\.[0-9]+)?$' and t.value::numeric > 0
  group by 1, 2
),
last_seen as (
  -- id breaks ties: several beacons from one visit can share a timestamp, and without a
  -- deterministic tiebreak the "last section" would be picked arbitrarily. id is insert order,
  -- which is exactly the ordering we mean by "last".
  select distinct on (session_id) session_id, pg, props->>'section' as sec
  from ev
  where event = 'section_view' and session_id is not null and props->>'section' is not null
  order by session_id, created_at desc, id desc
),
exits as (select pg, sec, count(*) as n from last_seen group by 1, 2),
sess_total as (select count(*) as n from last_seen),
secs as (
  select pg, sec from reach
  union select pg, sec from dwell
  union select pg, sec from exits
)
select x.pg, x.sec,
       coalesce(r.n, 0),
       round(100.0 * coalesce(r.n, 0) / nullif(l.n, 0), 1),
       round(coalesce(d.med, 0), 1),
       coalesce(e.n, 0),
       round(100.0 * coalesce(e.n, 0) / nullif((select n from sess_total), 0), 1)
from secs x
left join reach r on r.pg = x.pg and r.sec = x.sec
left join dwell d on d.pg = x.pg and d.sec = x.sec
left join exits e on e.pg = x.pg and e.sec = x.sec
left join landed l on l.pg = x.pg
order by x.pg, coalesce(r.n, 0) desc
$fn$;

-- ---------------------------------------------------------------------------
-- Scroll depth per document. Two pages of very different heights were being averaged into
-- one curve, which described neither.
--
-- Return type changes; drop and create.
-- ---------------------------------------------------------------------------
drop function if exists public.rpc_scroll(int);
create or replace function public.rpc_scroll(days int default 30)
returns table(page text, depth int, visitors bigint, pct numeric)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props,
         _dd_page(e.path) as pg
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
landed as (select pg, count(distinct vid) as n from ev where event = 'page_view' group by pg),
d(depth) as (values (25),(50),(75),(90)),
hit as (
  select pg, (props->>'depth')::int as depth, count(distinct vid) as n
  from ev
  where event = 'scroll_depth' and (props->>'depth') ~ '^[0-9]+$'
  group by 1, 2
)
select l.pg, d.depth,
       coalesce(h.n, 0),
       round(100.0 * coalesce(h.n, 0) / nullif(l.n, 0), 1)
from landed l
cross join d
left join hit h on h.pg = l.pg and h.depth = d.depth
order by l.pg, d.depth
$fn$;

-- ---------------------------------------------------------------------------
-- The funnel, with the page jump made explicit.
--
-- Everything from step 3 down lives on `/how-it-works/`, so without step 2 the biggest drop
-- on the site was being attributed to the demo section rather than to the link that gets
-- people there. Same return type as before, so a plain replace.
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
  select coalesce(e.visitor_id, e.session_id) as vid, e.event, e.props,
         _dd_page(e.path) as pg
  from site_events e, s
  where e.created_at >= s.since
    and coalesce(e.visitor_id, e.session_id) is not null
),
steps(step, label, matcher) as (
  values (1,'Landed on the site','page_view'),
         (2,'Reached How it works','page_view:deep'),
         (3,'Saw the demo section','section_view:demo'),
         (4,'Started a demo call','demo_start'),
         (5,'Finished the demo call','demo_complete'),
         (6,'Opened the booking form','form_open'),
         (7,'Submitted the form','form_submit'),
         (8,'Clicked through to Calendly','calendly_click')
),
counted as (
  select st.step, st.label, count(distinct ev.vid) as visitors
  from steps st
  left join ev on (
    case st.matcher
      when 'section_view:demo' then ev.event = 'section_view' and ev.props->>'section' = 'demo'
      when 'page_view:deep'    then ev.event = 'page_view' and ev.pg = 'deep'
      else ev.event = st.matcher
    end
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
-- Same boundary as 006: these read lead PII and bypass RLS by design, so execute belongs to
-- service_role and nobody else. Dropping a function drops its grants with it, so the two
-- recreated above have to be re-granted here whether or not they existed before.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    '_dd_page(text)', 'rpc_pages(int)', 'rpc_sections(int)', 'rpc_scroll(int)', 'rpc_funnel(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- Make the new signatures visible to the REST API immediately rather than on the next cache
-- cycle. Without this, /api/stats keeps calling the dropped shapes until PostgREST reloads.
notify pgrst, 'reload schema';
