-- Scheduled jobs. Not in the original handoff package; README.md specifies the schedule
-- and the retention windows but ships no SQL for them.
--
-- Trinidad & Tobago is UTC-4 all year (no daylight saving), so AST + 4 = UTC.

create extension if not exists pg_cron with schema cron;

-- Retention, per the data-handling policy in README.md:
--   pulses 24 months, support_requests 36 months, ai_tailor_log 12 months.
-- Drafts are device-local and never reach the database, so nothing to purge there.
create or replace function purge_expired() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_pulses int; n_reqs int; n_ai int;
begin
  with d as (delete from pulses where week_start < (current_date - interval '24 months') returning 1)
    select count(*) into n_pulses from d;
  with d as (delete from support_requests where created_at < (now() - interval '36 months') returning 1)
    select count(*) into n_reqs from d;
  with d as (delete from ai_tailor_log where created_at < (now() - interval '12 months') returning 1)
    select count(*) into n_ai from d;
  return jsonb_build_object('pulses', n_pulses, 'support_requests', n_reqs, 'ai_tailor_log', n_ai);
end $$;

revoke execute on function public.purge_expired() from public, anon, authenticated;

-- Friday 17:00 AST: +10 to every school when all five took part that week.
select cron.schedule('bloom-full-network-bonus', '0 21 * * 5', $$select public.award_full_network()$$);

-- 1st of the month, 03:00 UTC.
select cron.schedule('bloom-retention-purge', '0 3 1 * *', $$select public.purge_expired()$$);

-- Still to do, because it needs an email/SMS provider that is not configured yet:
--   * Monday 06:00 AST invite to the five principals.
--   * Immediate email + SMS to the CEBM duty line when a support_request of type
--     'urgent' is inserted (README section 6).
-- Both want pg_net or a database webhook pointed at Resend/Twilio.
