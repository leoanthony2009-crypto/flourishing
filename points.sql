-- Points trigger correction. Not in the original handoff package.
--
-- schema.sql defines award_pulse_points as `after insert on pulses`. The client's only write
-- path is an upsert on (school_id, week_start), so "submit without a note, then add one and
-- press Update pulse" takes the UPDATE branch and never awarded the +5 the app promises in
-- its own footnote ("10 per weekly pulse · +5 for a note"). Points and the UI then disagreed
-- for that week, permanently, with no way to correct it from the app.
--
-- The trigger now fires on UPDATE as well, and is idempotent: the +5 is awarded at most once
-- per pulse, the first time the note becomes non-empty. Editing the note again does not award
-- it a second time, and the +10 is still only ever awarded on insert.
--
-- Verified: insert without a note, then two successive note updates, produced exactly one
-- `pulse` row (+10) and one `note` row (+5).

create or replace function award_pulse_points() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into points_ledger(school_id, week_start, kind, delta, ref)
    values (new.school_id, new.week_start, 'pulse', 10, new.id::text);
  end if;

  if new.note is not null and length(trim(new.note)) > 0
     and not exists (select 1 from points_ledger
                     where kind = 'note' and ref = new.id::text) then
    insert into points_ledger(school_id, week_start, kind, delta, ref)
    values (new.school_id, new.week_start, 'note', 5, new.id::text);
  end if;

  return new;
end $$;

revoke execute on function public.award_pulse_points() from public, anon, authenticated;

drop trigger if exists pulses_points on pulses;
create trigger pulses_points
  after insert or update on pulses
  for each row execute function award_pulse_points();
