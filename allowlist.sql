-- Pilot allow-list. Not in the original handoff package.
--
-- README.md asks for sign-in to succeed "only if the email exists in profiles", enforced
-- with a `before insert on auth.users` hook. That is circular as specified: profiles.user_id
-- is a foreign key to auth.users, so the profile cannot exist before the user does.
--
-- The allow-list therefore lives in its own table, and one `after insert` hook does both
-- jobs: it rejects any address that is not listed, and creates the profile (with the right
-- school and role) for any address that is. Adding a principal is then a single insert
-- here plus an invite from the dashboard.

create table pilot_allowlist (
  email text primary key,
  school_id uuid references schools(id),
  role user_role not null default 'principal',
  display_name text,
  invited_at timestamptz not null default now()
);

alter table pilot_allowlist enable row level security;
create policy "admin manages allowlist" on pilot_allowlist for all to authenticated
  using (my_role() = 'admin') with check (my_role() = 'admin');

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.pilot_allowlist;
begin
  select * into a from public.pilot_allowlist where lower(email) = lower(new.email);
  if not found then
    raise exception 'This address is not on the Bloom pilot list' using errcode = '42501';
  end if;
  insert into public.profiles (user_id, email, school_id, role, display_name)
    values (new.id, new.email, a.school_id, a.role, a.display_name)
    on conflict (user_id) do nothing;
  return new;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Seeded slots. Replace the placeholder addresses with the real ones before inviting;
-- the email is matched case-insensitively.
insert into pilot_allowlist (email, school_id, role, display_name) values
  ('principal.portofspain@bloom.tt', (select id from schools where short_name = 'Port of Spain'), 'principal', 'Principal, Port of Spain'),
  ('principal.sanfernando@bloom.tt', (select id from schools where short_name = 'San Fernando'),  'principal', 'Principal, San Fernando'),
  ('principal.arima@bloom.tt',       (select id from schools where short_name = 'Arima'),         'principal', 'Principal, Arima'),
  ('principal.chaguanas@bloom.tt',   (select id from schools where short_name = 'Chaguanas'),     'principal', 'Principal, Chaguanas'),
  ('principal.scarborough@bloom.tt', (select id from schools where short_name = 'Scarborough'),   'principal', 'Principal, Scarborough'),
  ('central@cebm.tt', null, 'central', 'CEBM central team');

-- To add or correct someone later:
--   insert into pilot_allowlist (email, school_id, role)
--   values ('her.name@school.tt', (select id from schools where short_name = 'Arima'), 'principal')
--   on conflict (email) do update set school_id = excluded.school_id, role = excluded.role;
