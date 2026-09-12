-- Security migrations applied after the first end-to-end review. Not in the original handoff
-- package. Applied as bloom_close_aggregate_probe, bloom_write_side_hardening and
-- bloom_pin_request_ownership; kept here so the schema can be rebuilt from this repo alone.
-- Run after schema.sql, aggregate.sql and harden.sql.

-- =============================================================================
-- 1. Close the write-probe on the minimum-cell rule.
--
-- This was the serious one. The k=2 rule is the product's core promise: a theme fewer than
-- two schools chose is never named. But nothing constrained WHICH week a principal could
-- write, and network_pulse() counted the caller's own school in its totals. So a principal
-- could pick a theme, submit it, and watch a suppressed cell of 1 become a visible 2 — which
-- names the other school's private theme. Repeat across the fourteen topics and every other
-- school's answer falls out. Back-dating made it worse: the same probe ran against any past
-- week, and each back-dated pulse also minted 10 points redeemable for real partner codes.
--
-- Two independent changes, either of which alone would close it:
--   a. a pulse may only be written for the current week, so the probe cannot be replayed
--   b. the aggregate counts OTHER schools only, so the caller's own write never moves a
--      number the caller can see
-- The client adds its own pulse back for display, which it already knows.
--
-- Verified against the live API with real JWTs: back-dating returns 403 RLS violation, and
-- submitting the same theme another school chose still returns current: [], suppressed: 1.

drop policy if exists "insert own pulse" on pulses;
create policy "insert own pulse" on pulses for insert to authenticated
  with check (school_id = my_school() and submitted_by = auth.uid() and week_start = current_monday());

drop policy if exists "update own pulse" on pulses;
create policy "update own pulse" on pulses for update to authenticated
  using (school_id = my_school() and week_start = current_monday())
  -- submitted_by is pinned here too: without it an update could hand a colleague's row away.
  with check (school_id = my_school() and submitted_by = auth.uid() and week_start = current_monday());

create or replace function network_pulse(p_week_start date default current_monday())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k constant int := 2;
  me uuid := my_school();
  weeks date[] := array[p_week_start - 21, p_week_start - 14, p_week_start - 7, p_week_start];
  cur jsonb; prev jsonb; four jsonb; suppressed int; included int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- Participation count is not per-topic, and the caller already knows their own.
  select count(*) into included from pulses where week_start = p_week_start;

  select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'count', n) order by n desc, topic) filter (where n >= k), '[]'::jsonb),
         coalesce(sum(case when n < k then 1 else 0 end), 0)
    into cur, suppressed
  from (select topic, count(*) n from pulses
         where week_start = p_week_start and (me is null or school_id <> me)
         group by topic) t;

  select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'count', n)), '[]'::jsonb) into prev
  from (select topic, count(*) n from pulses
         where week_start = p_week_start - 7 and (me is null or school_id <> me)
         group by topic having count(*) >= k) t;

  select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'counts', counts)), '[]'::jsonb) into four
  from (
    select topic, array_agg(case when n >= k then n else 0 end order by w) counts
    from (
      select w, t.topic, coalesce(count(p.id), 0) n
      from unnest(weeks) w
      cross join (select unnest(enum_range(null::topic_id)) topic) t
      left join pulses p on p.week_start = w and p.topic = t.topic
                        and (me is null or p.school_id <> me)
      group by w, t.topic
    ) s
    group by topic
    having max(n) >= k
  ) q;

  return jsonb_build_object(
    'week_start', p_week_start,
    'included', included,
    'schools_total', (select count(*) from schools),
    'current', cur,
    'previous', prev,
    'four_weeks', four,
    'suppressed', suppressed,
    'min_cell', k,
    -- Tells the client the counts are other schools only, so it adds its own back rather
    -- than flooring at one. Without the flag the app under-reports every shared theme by 1.
    'excludes_self', true
  );
end $$;

revoke execute on function public.network_pulse(date) from public, anon;
grant  execute on function public.network_pulse(date) to authenticated;

-- =============================================================================
-- 2. Write-side hardening.
--
-- A principal could file a request already closed and already assigned to a colleague, so a
-- request could enter the central inbox pre-triaged and never be looked at. Filing is filing:
-- status and assignment belong to the central team.

drop policy if exists "insert own request" on support_requests;
create policy "insert own request" on support_requests for insert to authenticated
  with check (school_id = my_school() and created_by = auth.uid()
              and status = 'new' and assigned_to is null);

-- pilot_allowlist's primary key is on the raw email, so 'Head@bloom.tt' and 'head@bloom.tt'
-- were two rows. handle_new_user() matches case-insensitively, which made "remove someone
-- from the pilot" quietly incomplete whenever a second casing existed.
create unique index if not exists pilot_allowlist_email_lower_idx on pilot_allowlist (lower(email));

-- =============================================================================
-- 3. Pin the columns triage must not touch.
--
-- The central-update policy allows any central or admin user to update any request, which is
-- what triage needs. But UPDATE with no column pinning also lets a request be moved to
-- another school, re-attributed to a different principal, or given a reference that already
-- belongs to another request — and an RLS WITH CHECK cannot compare against the old row.
-- A BEFORE UPDATE trigger can, and also keeps updated_at honest whatever the client sends.

create or replace function support_request_immutable_cols() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Triage changes status and assignment. It never moves a request to another school,
  -- rewrites who filed it, or re-uses its reference.
  if new.school_id  is distinct from old.school_id
     or new.created_by is distinct from old.created_by
     or new.ref        is distinct from old.ref
     or new.week_start is distinct from old.week_start then
    raise exception 'school_id, created_by, ref and week_start are immutable on support_requests'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

revoke execute on function public.support_request_immutable_cols() from public, anon, authenticated;

drop trigger if exists support_requests_immutable on support_requests;
create trigger support_requests_immutable
  before update on support_requests
  for each row execute function support_request_immutable_cols();
