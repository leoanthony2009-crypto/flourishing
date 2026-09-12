-- Atomic perk redemption. Not in the original handoff package.
--
-- The redeem edge function used to read the balance, decide, then write. Two requests for
-- DIFFERENT perks that arrive together both read the same balance, both pass the check, and
-- both issue a code — so a school with 30 points could walk away with 30 + 30 points of real
-- partner codes and a negative ledger. (The same perk twice was already blocked by
-- redemptions_school_id_perk_id_key; different perks were not.) It also issued the code first
-- and then inserted the debit without checking the result, so a failed debit left a valid
-- partner code paid for with nothing.
--
-- redeem_perk() does the check and both writes inside one transaction, behind a per-school
-- advisory lock, so concurrent redemptions for a school queue up instead of racing. The debit
-- and the code now succeed or fail together.
--
-- Called only by the redeem edge function with the service key; EXECUTE is revoked from
-- anon and authenticated so a principal cannot call it directly with a cost they chose.

create or replace function redeem_perk(p_school uuid, p_perk text, p_code text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_perk   perks%rowtype;
  v_row    redemptions%rowtype;
  v_balance int;
  v_expires timestamptz;
begin
  if p_school is null or p_perk is null or p_code is null then
    return jsonb_build_object('status','error','error','bad request');
  end if;

  -- Serialise every redemption for this school. Two different perks redeemed at the same
  -- instant are exactly the case the balance check has to survive.
  perform pg_advisory_xact_lock(hashtextextended(p_school::text, 0));

  select * into v_perk from perks where id = p_perk and active;
  if not found then
    return jsonb_build_object('status','unavailable');
  end if;

  select * into v_row from redemptions where school_id = p_school and perk_id = p_perk;
  if found then
    return jsonb_build_object('status','already', 'code', v_row.code, 'expires_at', v_row.expires_at);
  end if;

  select coalesce(sum(delta), 0) into v_balance from points_ledger where school_id = p_school;
  if v_balance < v_perk.cost then
    return jsonb_build_object('status','insufficient', 'balance', v_balance, 'cost', v_perk.cost);
  end if;

  v_expires := now() + (v_perk.valid_days || ' days')::interval;
  insert into redemptions(school_id, perk_id, code, expires_at)
  values (p_school, p_perk, p_code, v_expires);
  insert into points_ledger(school_id, kind, delta, ref)
  values (p_school, 'redeem', -v_perk.cost, p_code);

  return jsonb_build_object('status','ok', 'code', p_code, 'expires_at', v_expires,
                            'balance', v_balance - v_perk.cost);
end $$;

revoke execute on function public.redeem_perk(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.redeem_perk(uuid, text, text) to service_role;
