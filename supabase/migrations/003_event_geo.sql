-- Digi Dental — geography and device on site events (for the admin dashboard)
-- Country, region and city come from Vercel's edge headers, so there is no IP lookup and no
-- third-party tracker involved. The raw IP is still never stored; only its salted hash is.
alter table public.site_events add column if not exists country text;   -- ISO-3166 alpha-2
alter table public.site_events add column if not exists region text;
alter table public.site_events add column if not exists city text;
alter table public.site_events add column if not exists device text;    -- mobile | tablet | desktop

create index if not exists site_events_country_idx on public.site_events (country, created_at desc);
create index if not exists site_events_created_idx on public.site_events (created_at desc);

-- ---------------------------------------------------------------------------
-- Dashboard queries. /api/stats runs the same shapes server-side.
-- ---------------------------------------------------------------------------
-- Visitors and sessions per day:
--   select date_trunc('day', created_at) d,
--          count(distinct session_id) sessions,
--          count(distinct ip_hash) visitors
--   from site_events where event = 'page_view' group by 1 order by 1 desc;
--
-- Click-through rate per button placement:
--   select props->>'location' placement, count(*) clicks,
--          count(distinct session_id) sessions
--   from site_events where event = 'cta_click' group by 1 order by clicks desc;
--
-- Where attention goes (median seconds per section):
--   select key section, percentile_cont(0.5) within group (order by (value)::numeric) median_seconds
--   from site_events, jsonb_each_text(props)
--   where event = 'section_time' group by 1 order by median_seconds desc;
--
-- Video watch time:
--   select props->>'clip' clip, count(*) plays,
--          round(avg((props->>'seconds')::numeric)) avg_seconds
--   from site_events where event = 'video_watch' group by 1;
--
-- Countries:
--   select country, count(distinct session_id) sessions
--   from site_events where event = 'page_view' and country is not null
--   group by 1 order by sessions desc;
