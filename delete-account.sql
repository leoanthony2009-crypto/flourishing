-- Account deletion. Required by both app stores (Apple 5.1.1(v), Google Play), and the right
-- thing regardless: a principal who wrote notes about their own staff should be able to take
-- them back.
--
-- The hard question is what "delete my account" means when the data is school-level. A pulse
-- row is the school's contribution to a shared network view that four other schools read and
-- that the four-week trend depends on. Deleting those rows would silently rewrite history for
-- people who never asked for anything to change.
--
-- So the split is drawn at authorship, not at rows:
--
--   DELETED   the account itself, the profile, and everything the person WROTE in their own
--             words — pulse notes, the context and "what would help" on support requests,
--             anything they saved to their school's library.
--   KEPT      the fact that the school picked a theme that week, anonymised: submitted_by and
--             created_by are nulled so no row points at a person any more. Points stay with
--             the school, because the perks they buy belong to the school, not to whoever
--             happened to click.
--
-- The app says exactly this before asking for confirmation. Nothing here is a soft delete:
-- there is no archive table and no recovery.

create or replace function scrub_account(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_school uuid;
  v_notes int := 0;
  v_requests int := 0;
  v_shared int := 0;
begin
  if p_user is null then
    return jsonb_build_object('status','error','error','no user');
  end if;

  select school_id into v_school from profiles where user_id = p_user;

  -- Their words, gone. The row survives so the aggregate other schools rely on does not move.
  with x as (
    update pulses set note = null, submitted_by = null
     where submitted_by = p_user and note is not null
     returning 1)
  select count(*) into v_notes from x;
  update pulses set submitted_by = null where submitted_by = p_user;

  -- Support requests are entirely their account of a situation, including free text the
  -- central team has read. Delete the rows outright rather than leave orphaned context.
  with x as (delete from support_requests where created_by = p_user returning 1)
  select count(*) into v_requests from x;

  with x as (delete from shared_resources where created_by = p_user returning 1)
  select count(*) into v_shared from x;

  -- ai_tailor_log holds no note and no output, only school, theme, model and latency. It is
  -- the audit trail for the AI proxy and carries nothing that identifies the person, so it
  -- stays as school-level metering.

  delete from profiles where user_id = p_user;

  return jsonb_build_object('status','ok', 'school_id', v_school,
                            'notes_cleared', v_notes,
                            'requests_deleted', v_requests,
                            'shared_deleted', v_shared);
end $$;

-- Only the delete-account edge function may call this, with the service key. A principal must
-- not be able to pass someone else's id.
revoke execute on function public.scrub_account(uuid) from public, anon, authenticated;
grant  execute on function public.scrub_account(uuid) to service_role;
