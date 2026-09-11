-- Network aggregation with minimum-cell suppression (k = 2).
create or replace function current_monday() returns date language sql stable as $$
  select (current_date - ((extract(isodow from current_date)::int - 1)))::date
$$;

create or replace function network_pulse(p_week_start date default current_monday())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  k constant int := 2;                         -- minimum cell size
  weeks date[] := array[p_week_start - 21, p_week_start - 14, p_week_start - 7, p_week_start];
  cur jsonb; prev jsonb; four jsonb; suppressed int; included int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select count(*) into included from pulses where week_start = p_week_start;

  -- current week, suppressed cells removed
  select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'count', n) order by n desc, topic) filter (where n >= k), '[]'::jsonb),
         coalesce(sum(case when n < k then 1 else 0 end), 0)
    into cur, suppressed
  from (select topic, count(*) n from pulses where week_start = p_week_start group by topic) t;

  select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'count', n)), '[]'::jsonb) into prev
  from (select topic, count(*) n from pulses where week_start = p_week_start - 7 group by topic having count(*) >= k) t;

  -- four-week series per topic; cells below k are reported as 0
  select coalesce(jsonb_agg(jsonb_build_object('topic', topic, 'counts', counts)), '[]'::jsonb) into four
  from (
    select topic,
           array_agg(case when n >= k then n else 0 end order by w) counts
    from (
      select w, t.topic, coalesce(count(p.id), 0) n
      from unnest(weeks) w
      cross join (select unnest(enum_range(null::topic_id)) topic) t
      left join pulses p on p.week_start = w and p.topic = t.topic
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
    'min_cell', k
  );
end $$;

grant execute on function network_pulse(date) to authenticated;

-- Weekly full-network bonus (run Friday 17:00 AST via pg_cron)
create or replace function award_full_network(p_week_start date default current_monday()) returns void language plpgsql security definer as $$
begin
  if (select count(*) from pulses where week_start = p_week_start) = (select count(*) from schools)
     and not exists (select 1 from points_ledger where week_start = p_week_start and kind = 'full_network') then
    insert into points_ledger(school_id, week_start, kind, delta, ref)
    select id, p_week_start, 'full_network', 10, 'all-in' from schools;
  end if;
end $$;
