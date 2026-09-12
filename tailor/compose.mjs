// Assembles the three sources the system prompt promises: the research base, what colleagues
// across Bloom do, and what this school needs. Plain JS rather than TypeScript so the edge
// function (Deno) and the test suite (Node) run the exact same code — the alternative was a
// test that re-implements the assembly and therefore proves nothing about the real one.

export const TOPICS = new Set(['workload','staffing','teaching','behaviour','attendance','safeguarding',
  'parents','send','culture','confidence','resources','change','data','other']);

// The pulse stores impact as an enum. Handing "a_lot" to the model drops a machine token into
// an otherwise natural-language brief; these are the words the app itself uses on screen.
const IMPACT = { little: 'a little', quite_a_bit: 'quite a bit', a_lot: 'a lot' };

export const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
export const list = (v, n, max = 200) =>
  Array.isArray(v) ? v.slice(0, n).map((x) => str(x, max)).filter(Boolean) : [];

export const clean = (v, max) =>
  String(v ?? '').trim().replace(/^[“"]|[”"]$/g, '').split(/\s+/).slice(0, max).join(' ');

const hasPct = (s) => /\d+(\.\d+)?\s?%/.test(s);

// The corpus is everything we actually sent, not just base.evidence. Narrowing it to the
// evidence line meant a figure quoted from the T&T context or the colleague material read as
// invented, and a sound answer was binned as "rejected".
export const ungrounded = (out, corpus) =>
  /https?:|www\.|\b\d{3}[- ]\d{4}\b/i.test(out) ||
  (/effect size|\bstud(y|ies)\b|research shows|according to/i.test(out)) ||
  (hasPct(out) && !hasPct(corpus));

export function compose({ topic, impact, note, base, more, signal }) {
  const checklist = list(more?.checklist, 6);
  const resourceLines = list(more?.resource?.lines, 4);
  const peer = str(more?.peer, 600);
  const savedAlready = list(signal?.ownLibrary, 4, 120);

  const research = [
    `Evidence: ${str(base?.evidence, 600)}`,
    `Source: ${str(base?.source, 300)}`,
    `Trinidad & Tobago context: ${str(base?.local, 400)}`,
  ].join('\n');

  // Colleague material is the curated, anonymised peer line plus the network count the
  // principal can already see on screen. Other schools' notes are never read here: they are
  // private by design, and what actually travels between schools is practice, not confession.
  const colleagues = [
    peer ? `What has worked elsewhere in Bloom: ${peer}` : '',
    signal?.networkCount
      ? `${signal.networkCount} of ${signal.schoolsTotal ?? 5} Bloom schools chose this theme this week${signal.trend ? ` (${str(signal.trend, 20)} on last week)` : ''}.`
      : '',
    checklist.length ? `A checklist Bloom schools use on this theme: ${checklist.join('; ')}` : '',
    more?.idea?.title ? `Another idea that has travelled: ${str(more.idea.title, 120)} — ${str(more.idea.body, 400)}` : '',
    resourceLines.length ? `The planner they fill in: ${resourceLines.join(' | ')}` : '',
  ].filter(Boolean).join('\n');

  const weeks = Number(signal?.weeksRunning) || 0;
  const thisSchool = [
    `Theme: ${str(base?.label, 80) || topic}`,
    `How much it is affecting them: ${IMPACT[str(impact, 40)] || 'not shared'}`,
    `Their note, verbatim: ${note ? `"${str(note, 1200)}"` : '(none given)'}`,
    weeks > 1
      ? `They have chosen this theme in ${Math.min(weeks, 4)} of the last 4 weeks, so it is not a one-off.`
      : 'This is the first recent week they have chosen this theme.',
    savedAlready.length ? `Already saved to their own library: ${savedAlready.join('; ')}. Do not just repeat these.` : '',
  ].filter(Boolean).join('\n');

  const userMsg = `1. RESEARCH
${research}

2. COLLEAGUES
${colleagues || '(nothing recorded for this theme yet)'}

3. THIS SCHOOL
${thisSchool}

THE DEFAULT IDEA TO ADAPT
Title: ${str(base?.title, 200)}
Body: ${str(base?.body, 600)}
Try this today: ${str(base?.tryIt, 400)}
Prompt: ${str(base?.prompt, 300)}`;

  // Everything the model was allowed to draw on, for the grounding check.
  const corpus = [research, colleagues, thisSchool, str(base?.body, 600), str(base?.tryIt, 400)].join('\n');
  return { userMsg, corpus };
}
