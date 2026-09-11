-- Bloom Principal Pulse — Supabase schema
create extension if not exists pgcrypto;

create type topic_id as enum ('workload','staffing','teaching','behaviour','attendance','safeguarding','parents','send','culture','confidence','resources','change','data','other');
create type impact_id as enum ('little','quite_a_bit','a_lot');
create type support_type as enum ('advice','conversation','practical_help','urgent');
create type request_status as enum ('new','in_progress','closed');
create type user_role as enum ('principal','central','admin');
create type points_kind as enum ('pulse','note','full_network','redeem','adjust');
create type ai_outcome as enum ('done','declined','rejected','error');

create table schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short_name text not null,
  region text
);

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  school_id uuid references schools(id),
  role user_role not null default 'principal',
  display_name text,
  created_at timestamptz not null default now()
);

create table pulses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id),
  week_start date not null,
  topic topic_id not null,
  impact impact_id not null,
  note text check (char_length(note) <= 240),
  submitted_by uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  unique (school_id, week_start)
);

create table support_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  school_id uuid not null references schools(id),
  week_start date not null,
  type support_type not null,
  topic topic_id not null,
  impact impact_id,
  context text check (char_length(context) <= 300),
  help text check (char_length(help) <= 300),
  status request_status not null default 'new',
  assigned_to uuid references auth.users(id),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table shared_resources (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id),
  topic topic_id not null,
  title text not null,
  try_it text,
  text text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table points_ledger (
  id bigserial primary key,
  school_id uuid not null references schools(id),
  week_start date,
  kind points_kind not null,
  delta int not null,
  ref text,
  created_at timestamptz not null default now()
);

create table perks (
  id text primary key,               -- 'starbucks' | 'rik' | 'tecu'
  partner text not null,
  offer text not null,
  detail text not null,
  cost int not null check (cost > 0),
  terms text not null,
  valid_days int not null default 90,
  active boolean not null default false
);

create table redemptions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id),
  perk_id text not null references perks(id),
  code text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  unique (school_id, perk_id)        -- one redemption per school per perk (per term: reset by archiving)
);

create table ai_tailor_log (
  id bigserial primary key,
  school_id uuid not null references schools(id),
  week_start date not null,
  topic topic_id not null,
  model text,
  outcome ai_outcome not null,
  latency_ms int,
  created_at timestamptz not null default now()
);

-- Helpers
create or replace function my_school() returns uuid language sql stable security definer as $$
  select school_id from profiles where user_id = auth.uid()
$$;
create or replace function my_role() returns user_role language sql stable security definer as $$
  select role from profiles where user_id = auth.uid()
$$;

-- Points trigger: +10 per pulse, +5 if a note was written
create or replace function award_pulse_points() returns trigger language plpgsql security definer as $$
begin
  insert into points_ledger(school_id, week_start, kind, delta, ref) values (new.school_id, new.week_start, 'pulse', 10, new.id::text);
  if new.note is not null and length(trim(new.note)) > 0 then
    insert into points_ledger(school_id, week_start, kind, delta, ref) values (new.school_id, new.week_start, 'note', 5, new.id::text);
  end if;
  return new;
end $$;
create trigger pulses_points after insert on pulses for each row execute function award_pulse_points();

-- RLS
alter table schools enable row level security;
alter table profiles enable row level security;
alter table pulses enable row level security;
alter table support_requests enable row level security;
alter table shared_resources enable row level security;
alter table points_ledger enable row level security;
alter table perks enable row level security;
alter table redemptions enable row level security;
alter table ai_tailor_log enable row level security;

create policy "schools readable" on schools for select to authenticated using (true);
create policy "own profile" on profiles for select to authenticated using (user_id = auth.uid() or my_role() in ('central','admin'));

create policy "own school pulses" on pulses for select to authenticated using (school_id = my_school());
create policy "insert own pulse" on pulses for insert to authenticated with check (school_id = my_school() and submitted_by = auth.uid());
create policy "update own pulse" on pulses for update to authenticated using (school_id = my_school());
-- NOTE: central/admin have NO select policy on pulses. Aggregates come only from network_pulse().

create policy "own school requests" on support_requests for select to authenticated using (school_id = my_school() or my_role() in ('central','admin'));
create policy "insert own request" on support_requests for insert to authenticated with check (school_id = my_school() and created_by = auth.uid());
create policy "central updates requests" on support_requests for update to authenticated using (my_role() in ('central','admin'));

create policy "own shared" on shared_resources for all to authenticated using (school_id = my_school()) with check (school_id = my_school() and created_by = auth.uid());

create policy "own ledger" on points_ledger for select to authenticated using (school_id = my_school() or my_role() = 'admin');
create policy "perks readable" on perks for select to authenticated using (true);
create policy "own redemptions" on redemptions for select to authenticated using (school_id = my_school() or my_role() = 'admin');
create policy "admin ai log" on ai_tailor_log for select to authenticated using (my_role() = 'admin');
-- Inserts to points_ledger (redeem), redemptions and ai_tailor_log happen only via service-role edge functions.
