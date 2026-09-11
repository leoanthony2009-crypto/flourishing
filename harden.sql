-- Applied after schema.sql + aggregate.sql, in response to the Supabase security linter.
-- Two of these close real holes; the rest are hardening.

-- Pin search_path on every SECURITY DEFINER helper (network_pulse already sets its own).
-- Without this, a caller-controlled search_path can redirect the unqualified table
-- references inside a definer function.
alter function public.my_school() set search_path = public, pg_temp;
alter function public.my_role() set search_path = public, pg_temp;
alter function public.award_pulse_points() set search_path = public, pg_temp;
alter function public.current_monday() set search_path = public, pg_temp;
alter function public.award_full_network(date) set search_path = public, pg_temp;

-- award_full_network is the Friday cron job, not an API. PostgREST exposes every function
-- in `public` over /rest/v1/rpc, and PostgreSQL grants EXECUTE to PUBLIC by default, so as
-- written any signed-in principal could award +10 points to all five schools at will.
-- Service role only.
revoke execute on function public.award_full_network(date) from public, anon, authenticated;

-- Trigger function, never called directly. Trigger firing does not check EXECUTE.
revoke execute on function public.award_pulse_points() from public, anon, authenticated;

-- RLS helpers and the aggregate are for signed-in users only; anon has no business calling
-- them. (network_pulse already raises on a null auth.uid(), but do not rely on that alone.)
revoke execute on function public.my_school() from public, anon;
revoke execute on function public.my_role() from public, anon;
revoke execute on function public.network_pulse(date) from public, anon;
grant execute on function public.my_school() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.network_pulse(date) to authenticated;
