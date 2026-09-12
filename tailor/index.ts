// Supabase Edge Function: POST /functions/v1/tailor
// Proxies "Tailor this idea" to Anthropic with the same closed-world rules and validation as
// the client prototype, and assembles the three sources the system prompt promises: the
// research base, what colleagues across Bloom do, and what this school actually needs.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AI_SYSTEM } from './prompt.ts';
// Plain JS so the test suite runs this exact code under Node rather than a copy of it.
import { TOPICS, clean, compose, ungrounded } from './compose.mjs';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DAILY_LIMIT = 6;
const LIMITS = { title: 8, body: 50, tryIt: 40, prompt: 22, grounding: 28 };

// Opus first, Sonnet as the fallback. Both support structured outputs and adaptive thinking,
// so one request shape covers both.
const MODELS = ['claude-opus-5', 'claude-sonnet-5'];
// Guaranteed-shape output. The old code regex-matched a JSON object out of free text, which
// failed whenever the model wrapped it in prose — a well-formed idea thrown away as "rejected".
// Declining shares this schema rather than having its own: tailored:false plus a reason, with
// the other five fields empty, so there is only ever one shape to parse.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tailored:  { type: 'boolean' },
    reason:    { type: 'string' },
    title:     { type: 'string' },
    body:      { type: 'string' },
    tryIt:     { type: 'string' },
    prompt:    { type: 'string' },
    grounding: { type: 'string' },
  },
  required: ['tailored', 'reason', 'title', 'body', 'tryIt', 'prompt', 'grounding'],
};

const currentMonday = () => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };



class ModelError extends Error {
  constructor(public status: number, public detail: string) { super(`anthropic ${status}`); }
}

async function callModel(model: string, user: string, structured: boolean) {
  const body: Record<string, unknown> = {
    model,
    // Room for adaptive thinking as well as the answer. The old 500 would have truncated
    // mid-object on any model that thinks before it writes.
    max_tokens: 4000,
    system: AI_SYSTEM,
    messages: [{ role: 'user', content: user }],
    // Low effort suits a short, tightly specified rewrite, and keeps a principal from waiting.
    output_config: structured
      ? { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } }
      : { effort: 'low' },
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ModelError(r.status, (await r.text().catch(() => '')).slice(0, 300));
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new ModelError(200, 'refusal');
  if (j.stop_reason === 'max_tokens') throw new ModelError(200, 'max_tokens');
  const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('');
  // Structured mode returns the object verbatim. Plain mode may wrap it in a sentence, so fall
  // back to pulling the outermost object out — the behaviour this code had throughout.
  if (structured) return text;
  const m = text.match(/\{[\s\S]*\}/);
  return m ? m[0] : text;
}

// Ask for a guaranteed shape first, and drop to plain mode only if the API rejects the request
// outright. Structured outputs could not be exercised here — there is no key in this
// environment to call the real API with — so a 400 must degrade to something that works rather
// than take the whole feature down the moment a key is finally set.
async function ask(model: string, user: string) {
  try {
    return await callModel(model, user, true);
  } catch (e) {
    if (e instanceof ModelError && e.status === 400) {
      console.error('structured output refused, retrying plain', model, e.detail);
      return await callModel(model, user, false);
    }
    throw e;
  }
}

// Why it failed, in a form the client can say something honest about. Without this an unset
// API key is indistinguishable from a busy model, and the app blames the connection either way.
function classify(e: unknown): 'not_configured' | 'busy' | 'error' {
  if (!ANTHROPIC_API_KEY) return 'not_configured';
  if (e instanceof ModelError) {
    if (e.status === 401 || e.status === 403) return 'not_configured';
    if (e.status === 429 || e.status >= 500) return 'busy';
  }
  return 'error';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method', { status: 405, headers: CORS });
  const jwt = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!jwt) return json({ status: 'error', error: 'unauthenticated' }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ status: 'error', error: 'unauthenticated' }, 401);
  // maybeSingle, not single: single() errors when the row is absent, which made a genuine
  // lookup failure and a user with no profile indistinguishable. A real run returned
  // "no school" for an account that has one — the client renders that as "tailoring is for
  // school accounts", which is an accusation, not a blip.
  const { data: prof, error: profErr } = await sb.from('profiles').select('school_id').eq('user_id', user.id).maybeSingle();
  if (profErr) { console.error('profile lookup failed', profErr.message); return json({ status: 'error', reason: 'busy' }, 503); }
  if (!prof?.school_id) return json({ status: 'error', error: 'no school' }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ status: 'error', error: 'bad request' }, 400); }
  const { impact, note = '', base, more, signal } = body;

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

  // The three sources the system prompt promises, assembled by the module the tests drive.
  const { userMsg, corpus } = compose({ topic, impact, note, base, more, signal });

  // Resolve the reserved row to its real outcome instead of writing a second one. It updates
  // that exact id: "the school's newest row" would settle a sibling request's reservation
  // whenever a principal has two tailor calls in flight.
  const settle = async (outcome: string, model?: string) => {
    if (!rowId) return;
    const { error } = await sb.from('ai_tailor_log')
      .update({ outcome, model, latency_ms: Date.now() - started }).eq('id', rowId);
    if (error) console.error('ai_tailor_log settle failed', error.message);
  };

  let last = 'error';
  let lastErr: unknown = null;
  for (const model of MODELS) {
    try {
      const d = JSON.parse(await ask(model, userMsg));
      if (d?.tailored === false) {
        await settle('declined', model);
        // 40, not 30: the prompt asks for 25, and the clamp is a backstop rather than the thing
        // that shapes the sentence. At 30 a slightly long reason was cut mid-clause.
        return json({ status: 'declined', reason: clean(d.reason, 40).replace(/[.!]+$/, '') });
      }
      if (!(d?.title && d?.body && d?.tryIt && d?.prompt && d?.grounding)) { last = 'rejected'; continue; }
      const joined = [d.title, d.body, d.tryIt, d.prompt].join(' ');
      if (ungrounded(joined, corpus)) { last = 'rejected'; continue; }
      const data = { title: clean(d.title, LIMITS.title), body: clean(d.body, LIMITS.body), tryIt: clean(d.tryIt, LIMITS.tryIt), prompt: clean(d.prompt, LIMITS.prompt), grounding: clean(d.grounding, LIMITS.grounding) };
      await settle('done', model);
      return json({ status: 'done', data });
    } catch (e) {
      lastErr = e;
      last = 'error';
      console.error('tailor model call failed', model,
        e instanceof ModelError ? `${e.status} ${e.detail}` : String(e));
    }
  }
  await settle(last as any);
  if (last === 'rejected') return json({ status: 'rejected' });
  return json({ status: 'error', reason: classify(lastErr) });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
