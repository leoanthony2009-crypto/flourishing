// Supabase Edge Function: POST /functions/v1/tailor
// Proxies "Tailor this idea" to Anthropic with the same closed-world rules and validation as the client prototype.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AI_SYSTEM } from './prompt.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DAILY_LIMIT = 6;
const LIMITS = { title: 8, body: 50, tryIt: 40, prompt: 22, grounding: 28 };

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };

const clean = (v: unknown, max: number) => String(v ?? '').trim().replace(/^[“"]|[”"]$/g, '').split(/\s+/).slice(0, max).join(' ');
const hasPct = (s: string) => /\d+(\.\d+)?\s?%/.test(s);
const ungrounded = (out: string, evidence: string) =>
  /https?:|www\.|\b\d{3}[- ]\d{4}\b/i.test(out) ||
  (/effect size|\bstud(y|ies)\b|research shows|according to/i.test(out)) ||
  (hasPct(out) && !hasPct(evidence));

async function callModel(model: string, user: string) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 500, system: AI_SYSTEM, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}`);
  const j = await r.json();
  return (j.content ?? []).map((c: any) => c.text ?? '').join('');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method', { status: 405, headers: CORS });
  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!jwt) return json({ status: 'error', error: 'unauthenticated' }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ status: 'error', error: 'unauthenticated' }, 401);
  const { data: prof } = await sb.from('profiles').select('school_id').eq('user_id', user.id).single();
  if (!prof?.school_id) return json({ status: 'error', error: 'no school' }, 403);

  const body = await req.json();
  const { topic, impact, note = '', base, more, week_start } = body;
  if (!topic || !base?.title || !base?.evidence) return json({ status: 'error', error: 'bad request' }, 400);

  const started = Date.now();
  const log = (outcome: string, model?: string) =>
    sb.from('ai_tailor_log').insert({ school_id: prof.school_id, week_start, topic, model, outcome, latency_ms: Date.now() - started });

  if (topic === 'safeguarding') { await log('declined'); return json({ status: 'declined', reason: 'follow your school’s child-protection protocol and contact the Children’s Authority' }); }

  const since = new Date(); since.setHours(0, 0, 0, 0);
  const { count } = await sb.from('ai_tailor_log').select('*', { count: 'exact', head: true }).eq('school_id', prof.school_id).gte('created_at', since.toISOString());
  if ((count ?? 0) >= DAILY_LIMIT) return json({ status: 'error', error: 'daily limit reached' }, 429);

  const userMsg = `PRINCIPAL’S WEEKLY PULSE
Theme: ${base.label ?? topic}
How much it is affecting them: ${impact ?? 'not shared'}
Principal’s note (verbatim): ${note ? `"${note}"` : '(none given)'}

GROUNDING MATERIAL — the only evidence you may draw on:
Evidence: ${base.evidence}
Source: ${base.source}
Trinidad & Tobago context: ${base.local}
Related checklist: ${(more?.checklist ?? []).join('; ')}
Related idea: ${more?.idea?.title ?? ''} — ${more?.idea?.body ?? ''}

DEFAULT IDEA TO ADAPT
Title: ${base.title}
Body: ${base.body}
Try this today: ${base.tryIt}
Prompt: ${base.prompt}`;

  const models = ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
  let last = 'error';
  for (const model of models) {
    try {
      const text = await callModel(model, userMsg);
      const m = text.match(/\{[\s\S]*\}/);
      const d = JSON.parse(m ? m[0] : text);
      if (d?.tailored === false) { await log('declined', model); return json({ status: 'declined', reason: clean(d.reason, 30).replace(/[.!]+$/, '') }); }
      if (!(d?.title && d?.body && d?.tryIt && d?.prompt && d?.grounding)) { last = 'rejected'; continue; }
      const joined = [d.title, d.body, d.tryIt, d.prompt].join(' ');
      if (ungrounded(joined, base.evidence)) { last = 'rejected'; continue; }
      const data = { title: clean(d.title, LIMITS.title), body: clean(d.body, LIMITS.body), tryIt: clean(d.tryIt, LIMITS.tryIt), prompt: clean(d.prompt, LIMITS.prompt), grounding: clean(d.grounding, LIMITS.grounding) };
      await log('done', model);
      return json({ status: 'done', data });
    } catch (_e) { last = 'error'; }
  }
  await log(last as any);
  return json({ status: last === 'rejected' ? 'rejected' : 'error' });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
