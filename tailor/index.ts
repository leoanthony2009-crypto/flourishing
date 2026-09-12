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
// The topic_id enum, mirrored. An unrecognised topic is rejected rather than forwarded.
const TOPICS = new Set(['workload','staffing','teaching','behaviour','attendance','safeguarding',
  'parents','send','culture','confidence','resources','change','data','other']);
const currentMonday = () => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

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

  let body: any = {};
  try { body = await req.json(); } catch { return json({ status: 'error', error: 'bad request' }, 400); }
  const { impact, note = '', base, more } = body;

  // Everything below depends on these being real values. Taking `topic` straight off the body
  // let `Safeguarding` and `safeguarding ` slip past the hard block on a strict ===, and an
  // invalid topic or a missing week_start made the ai_tailor_log insert fail silently, which
  // in turn made the daily limit (a COUNT over that table) permanently unreachable.
  const topic = String(body.topic ?? '').trim().toLowerCase();
  if (!TOPICS.has(topic)) return json({ status: 'error', error: 'bad request' }, 400);
  if (!base?.title || !base?.evidence) return json({ status: 'error', error: 'bad request' }, 400);
  const week_start = /^\d{4}-\d{2}-\d{2}$/.test(String(body.week_start ?? ''))
    ? String(body.week_start) : currentMonday();

  const started = Date.now();
  // Returns the row id so the reservation below can be resolved to its real outcome. A failed
  // audit write must not be silent: this table is also what meters the daily limit.
  const log = async (outcome: string, model?: string) => {
    const { data, error } = await sb.from('ai_tailor_log').insert({
      school_id: prof.school_id, week_start, topic, model, outcome, latency_ms: Date.now() - started })
      .select('id').single();
    if (error) console.error('ai_tailor_log insert failed', error.message);
    return data?.id ?? null;
  };

  if (topic === 'safeguarding') { await log('declined'); return json({ status: 'declined', reason: 'follow your school’s child-protection protocol and contact the Children’s Authority' }); }

  const since = new Date(); since.setHours(0, 0, 0, 0);
  const { count } = await sb.from('ai_tailor_log').select('*', { count: 'exact', head: true }).eq('school_id', prof.school_id).gte('created_at', since.toISOString());
  if ((count ?? 0) >= DAILY_LIMIT) return json({ status: 'error', error: 'daily limit reached' }, 429);

  // Reserve the slot before calling the model, so N concurrent requests cannot all observe
  // a count below the limit and proceed.
  const rowId = await log('error');

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

  // Resolve the reserved row to its real outcome instead of writing a second one. It updates
  // that exact id: "the school's newest row" would settle a sibling request's reservation
  // whenever a principal has two tailor calls in flight.
  const settle = async (outcome: string, model?: string) => {
    if (!rowId) return;
    const { error } = await sb.from('ai_tailor_log')
      .update({ outcome, model, latency_ms: Date.now() - started }).eq('id', rowId);
    if (error) console.error('ai_tailor_log settle failed', error.message);
  };

  const models = ['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];
  let last = 'error';
  for (const model of models) {
    try {
      const text = await callModel(model, userMsg);
      const m = text.match(/\{[\s\S]*\}/);
      const d = JSON.parse(m ? m[0] : text);
      if (d?.tailored === false) { await settle('declined', model); return json({ status: 'declined', reason: clean(d.reason, 30).replace(/[.!]+$/, '') }); }
      if (!(d?.title && d?.body && d?.tryIt && d?.prompt && d?.grounding)) { last = 'rejected'; continue; }
      const joined = [d.title, d.body, d.tryIt, d.prompt].join(' ');
      if (ungrounded(joined, base.evidence)) { last = 'rejected'; continue; }
      const data = { title: clean(d.title, LIMITS.title), body: clean(d.body, LIMITS.body), tryIt: clean(d.tryIt, LIMITS.tryIt), prompt: clean(d.prompt, LIMITS.prompt), grounding: clean(d.grounding, LIMITS.grounding) };
      await settle('done', model);
      return json({ status: 'done', data });
    } catch (_e) { last = 'error'; }
  }
  await settle(last as any);
  return json({ status: last === 'rejected' ? 'rejected' : 'error' });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
