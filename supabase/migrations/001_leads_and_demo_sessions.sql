-- Digi Dental — leads + demo session gating
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  practice_name text,
  email text,
  phone text,
  country text,
  monthly_call_volume text,
  locations text,
  source text not null check (source in ('form', 'demo_call', 'exit_intent'))
);

create table public.demo_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ip_hash text not null,        -- SHA-256 of visitor IP + server salt; raw IPs are never stored
  completed boolean not null default false
);
create index demo_sessions_ip_hash_idx on public.demo_sessions (ip_hash);

-- Row Level Security: anon may INSERT into leads only; all reads restricted.
alter table public.leads enable row level security;
alter table public.demo_sessions enable row level security;

create policy "anon can insert leads" on public.leads
  for insert to anon with check (true);
-- No select/update/delete policies for anon: reads are blocked by default.
-- demo_sessions has NO anon policies — only the service role (serverless functions) touches it.
