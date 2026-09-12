// Supabase Edge Function: POST /functions/v1/redeem { perk_id }
// Server-issued perk codes. Only callable when the perk is active and the school has enough points.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (partner: string) => `BLOOM-${partner.slice(0, 3).toUpperCase()}-${Array.from(crypto.getRandomValues(new Uint8Array(6))).map(b => ALNUM[b % ALNUM.length]).join('')}`;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method', { status: 405, headers: CORS });
  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!jwt) return json({ error: 'unauthenticated' }, 401);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ error: 'unauthenticated' }, 401);
  const { data: prof } = await sb.from('profiles').select('school_id').eq('user_id', user.id).single();
  if (!prof?.school_id) return json({ error: 'no school' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const perk_id = String(body.perk_id ?? '');
  if (!perk_id) return json({ error: 'bad request' }, 400);

  // The check and both writes happen inside redeem_perk(), behind a per-school lock. Doing
  // them here meant two requests for different perks could both read the same balance, both
  // pass, and both issue a real partner code; and a failed debit left a paid-for code behind.
  const { data, error } = await sb.rpc('redeem_perk', {
    p_school: prof.school_id, p_perk: perk_id, p_code: code(perk_id),
  });
  if (error) { console.error('redeem_perk failed', error.message); return json({ error: 'redeem failed' }, 500); }

  switch (data?.status) {
    case 'ok':           return json({ code: data.code, expires_at: data.expires_at, balance: data.balance });
    case 'already':      return json({ code: data.code, expires_at: data.expires_at, already: true });
    case 'unavailable':  return json({ error: 'perk not available' }, 404);
    case 'insufficient': return json({ error: 'insufficient points', balance: data.balance, cost: data.cost }, 402);
    default:             return json({ error: 'bad request' }, 400);
  }
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
