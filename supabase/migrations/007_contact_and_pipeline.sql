-- Digi Dental — contact channels, total click coverage, and the pipeline board
--
-- Answers three questions the previous functions could not:
--   * how many people actually reach for WhatsApp, email or the phone, and what share of
--     visitors that is
--   * how many clicks happened in total, on which controls
--   * where every visitor currently sits in the funnel, as a board rather than a bar chart
--
-- Same rules as 006: SECURITY DEFINER with a pinned search_path, execute revoked from
-- anon/authenticated and granted to service_role only.

-- ---------------------------------------------------------------------------
-- Contact channel reach and conversion.
--
-- `visitors` is the honest denominator (people who landed), so the percentages answer
-- "what share of everyone who arrived went on to message me", which is the question asked.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_contact(days int default 30)
returns table(channel text, clicks bigint, visitors bigint, pct_of_visitors numeric,
              after_form bigint, without_form bigint)
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
landed as (select count(distinct vid) as n from ev where event = 'page_view'),
subs as (select vid, min(created_at) as sub_at from ev where event = 'form_submit' group by 1),
c as (
  select props->>'channel' as ch, vid, created_at
  from ev where event = 'contact_click' and props->>'channel' is not null
),
-- Calendly is a contact channel too, just one that lives in its own event.
allc as (
  select ch, vid, created_at from c
  union all
  select 'calendly', vid, created_at from ev where event = 'calendly_click'
)
select a.ch,
       count(*),
       count(distinct a.vid),
       round(100.0 * count(distinct a.vid) / nullif((select n from landed), 0), 1),
       count(distinct a.vid) filter (where sb.vid is not null and a.created_at >= sb.sub_at),
       count(distinct a.vid) filter (where sb.vid is null)
from allc a
left join subs sb on sb.vid = a.vid
group by a.ch
order by count(distinct a.vid) desc
$fn$;

-- ---------------------------------------------------------------------------
-- Every control that was clicked, most-clicked first.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_clicks(days int default 30, lim int default 40)
returns table(label text, section text, kind text, clicks bigint, visitors bigint)
language sql
stable
security definer
set search_path = public
as $fn$
with s as (select _dd_since(days) as since),
ev as (
  select coalesce(e.visitor_id, e.session_id) as vid, e.props
  from site_events e, s
  where e.created_at >= s.since and e.event = 'element_click'
    and coalesce(e.visitor_id, e.session_id) is not null
)
select coalesce(props->>'label', 'unlabelled'),
       coalesce(props->>'section', 'unknown'),
       coalesce(props->>'kind', 'button'),
       count(*), count(distinct vid)
from ev
group by 1, 2, 3
order by count(*) desc
limit greatest(1, least(200, coalesce(lim, 40)))
$fn$;

-- ---------------------------------------------------------------------------
-- Pipeline board: one row per visitor, placed in the furthest stage they reached.
--
-- Stages are ordered and mutually exclusive, so the columns sum to the visitor count and a
-- person appears exactly once — which is what makes it readable as a board rather than a set
-- of overlapping counts.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_pipeline(days int default 30, lim int default 300)
returns table(stage text, stage_order int, visitor_id text, last_seen timestamptz,
              country text, device text, source text, sessions bigint,
              is_lead boolean, lead_name text, lead_email text)
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
         max(created_at) as last_seen,
         count(distinct session_id) as sessions,
         max(country) as country,
         max(device) as device,
         coalesce(max(utm_source), max(referrer_host), 'direct') as source,
         bool_or(event = 'contact_click' or event = 'calendly_click') as contacted,
         bool_or(event = 'form_submit')  as submitted,
         bool_or(event = 'form_open')    as opened,
         bool_or(event = 'demo_start' or event = 'video_play') as engaged
  from ev group by vid
),
ld as (
  select distinct on (l.visitor_id) l.visitor_id as vid, l.name, l.email
  from leads l, s
  where l.created_at >= s.since and not l.is_bot and l.visitor_id is not null
  order by l.visitor_id, l.created_at desc
)
select
  case when a.contacted then 'Reached out'
       when a.submitted then 'Submitted the form'
       when a.opened    then 'Opened the form'
       when a.engaged   then 'Engaged'
       else 'Browsing' end,
  case when a.contacted then 5
       when a.submitted then 4
       when a.opened    then 3
       when a.engaged   then 2
       else 1 end,
  a.vid, a.last_seen, a.country, a.device, a.source, a.sessions,
  (ld.vid is not null), ld.name, ld.email
from agg a
left join ld on ld.vid = a.vid
order by 2 desc, a.last_seen desc
limit greatest(1, least(1000, coalesce(lim, 300)))
$fn$;

-- ---------------------------------------------------------------------------
-- Headline totals for the click question, as a single object.
-- ---------------------------------------------------------------------------
create or replace function public.rpc_click_totals(days int default 30)
returns jsonb
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
landed as (select count(distinct vid) as n from ev where event = 'page_view')
select jsonb_build_object(
  'total_clicks',      (select count(*) from ev where event = 'element_click'),
  'clicking_visitors', (select count(distinct vid) from ev where event = 'element_click'),
  'clicks_per_visitor',round(
      (select count(*) from ev where event = 'element_click')::numeric
      / nullif((select n from landed), 0), 2),
  'link_clicks',       (select count(*) from ev where event = 'element_click' and props->>'kind' = 'link'),
  'button_clicks',     (select count(*) from ev where event = 'element_click' and props->>'kind' = 'button'),
  'contact_clicks',    (select count(*) from ev where event = 'contact_click')
)
$fn$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'rpc_contact(int)', 'rpc_clicks(int,int)', 'rpc_pipeline(int,int)', 'rpc_click_totals(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;
