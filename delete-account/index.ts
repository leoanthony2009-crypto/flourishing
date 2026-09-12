// Supabase Edge Function: POST /functions/v1/delete-account
//
// Required by both app stores (Apple 5.1.1(v), Google Play), and right regardless: a principal
// who wrote notes about their own staff should be able to take them back.
//
// Two steps, in this order. scrub_account() removes their words and their profile in one
// transaction; only then is the auth user deleted, through the Admin API so sessions and
// refresh tokens go with it. If the scrub fails the account survives, which is the safe way
// round — an auth user with no profile can still sign in and would be told they are not on the
// pilot list, with their notes still in the database.
//
// The subject is always taken from the caller's own JWT. There is no id parameter, so this
// cannot be pointed at anyone else.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method', { status: 405, headers: CORS });

  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!jwt) return json({ status: 'error', error: 'unauthenticated' }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ status: 'error', error: 'unauthenticated' }, 401);

  // A typed confirmation, so a mis-tap on a phone cannot delete an account. The client sends
  // it only after the person has typed the word.
  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is simply not confirmed */ }
  if (String(body.confirm ?? '').trim().toUpperCase() !== 'DELETE') {
    return json({ status: 'error', error: 'not confirmed' }, 400);
  }

  const { data: scrub, error: scrubErr } = await sb.rpc('scrub_account', { p_user: user.id });
  if (scrubErr || scrub?.status !== 'ok') {
    console.error('scrub_account failed', scrubErr?.message ?? JSON.stringify(scrub));
    return json({ status: 'error', error: 'could not delete' }, 500);
  }

  const { error: delErr } = await sb.auth.admin.deleteUser(user.id);
  if (delErr) {
    // Their data is already gone; only the login remains. Say so rather than report success,
    // and leave enough in the log for someone to finish it by hand.
    console.error('auth user delete failed after scrub', user.id, delErr.message);
    return json({ status: 'partial', error: 'data removed; sign-in not yet removed' }, 500);
  }

  return json({ status: 'ok', ...scrub });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
