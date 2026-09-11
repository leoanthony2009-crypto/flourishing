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

  const { perk_id } = await req.json();
  const { data: perk } = await sb.from('perks').select('*').eq('id', perk_id).eq('active', true).single();
  if (!perk) return json({ error: 'perk not available' }, 404);

  const { data: existing } = await sb.from('redemptions').select('code, expires_at').eq('school_id', prof.school_id).eq('perk_id', perk_id).maybeSingle();
  if (existing) return json({ code: existing.code, expires_at: existing.expires_at, already: true });

  const { data: ledger } = await sb.from('points_ledger').select('delta').eq('school_id', prof.school_id);
  const balance = (ledger ?? []).reduce((a, r) => a + r.delta, 0);
  if (balance < perk.cost) return json({ error: 'insufficient points', balance, cost: perk.cost }, 402);

  const expires_at = new Date(Date.now() + perk.valid_days * 86400_000).toISOString();
  const c = code(perk.id);
  const { error: e1 } = await sb.from('redemptions').insert({ school_id: prof.school_id, perk_id, code: c, expires_at });
  if (e1) return json({ error: e1.message }, 500);
  await sb.from('points_ledger').insert({ school_id: prof.school_id, kind: 'redeem', delta: -perk.cost, ref: c });
  return json({ code: c, expires_at, balance: balance - perk.cost });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
