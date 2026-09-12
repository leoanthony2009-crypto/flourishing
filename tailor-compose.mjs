// Drives the edge function's own compose()/ungrounded() — the same module Deno imports, so a
// pass here is a statement about the deployed code, not about a re-implementation.
import { compose, ungrounded, clean, TOPICS } from './tailor/compose.mjs';

const BASE = {
  label: 'Workload & wellbeing',
  title: 'Stop → Delegate → Protect',
  body: 'Separate what must happen from what has become habitual.',
  tryIt: 'Write three lines: one to stop, one to delegate, one protected block.',
  prompt: 'What takes significant time but adds the least value?',
  evidence: 'Leadership time spent on teaching and learning has the strongest link to student outcomes of any principal activity; administrative load crowds it out unless deliberately protected.',
  source: 'Robinson, Lloyd & Rowe (2008), Educational Administration Quarterly.',
  local: 'Ministry returns, term reports and the SEA/CSEC calendar cluster demand at predictable points.',
};
const MORE = {
  checklist: ['List every recurring demand this half-term', 'Mark each essential, habitual or inherited', 'Pause one habitual demand and tell staff why'],
  idea: { title: 'Run a quiet week', body: 'Cancel one standing meeting and replace it with a short written update.' },
  peer: 'Other Bloom schools have found value in naming one pause per half-term openly with staff, so the relief is shared rather than private.',
  resource: { title: 'Stop / Delegate / Protect planner', lines: ['Stop: one task we will pause is ___', 'Delegate: one task, one named person, one check-in date'] },
};
const NOTE = 'Two teachers are out on sick leave and cover keeps falling on the same three people in the Form 3 team.';
const SIGNAL = { networkCount: 3, schoolsTotal: 5, trend: 'rising', weeksRunning: 3, ownLibrary: ['Cover rota template'] };

const full = compose({ topic: 'workload', impact: 'a_lot', note: NOTE, base: BASE, more: MORE, signal: SIGNAL });
const m = full.userMsg;

const checks = {
  // All three sources the system prompt promises must actually be present.
  hasResearchSection:  /1\. RESEARCH/.test(m),
  hasColleaguesSection:/2\. COLLEAGUES/.test(m),
  hasThisSchoolSection:/3\. THIS SCHOOL/.test(m),

  // 1. RESEARCH — the evidence and its citation travel together.
  carriesEvidence: m.includes('strongest link to student outcomes'),
  carriesSource:   m.includes('Robinson, Lloyd & Rowe (2008)'),
  carriesLocal:    m.includes('SEA/CSEC calendar'),

  // 2. COLLEAGUES — the curated peer line, the network count, the shared checklist.
  carriesPeerPractice: m.includes('naming one pause per half-term'),
  carriesNetworkCount: m.includes('3 of 5 Bloom schools chose this theme this week'),
  carriesTrend:        m.includes('(rising on last week)'),
  carriesChecklist:    m.includes('Mark each essential, habitual or inherited'),
  carriesPlanner:      m.includes('Stop: one task we will pause is'),

  // 3. THIS SCHOOL — the note verbatim, the impact, that it is recurring, what they have.
  carriesNoteVerbatim: m.includes('the same three people in the Form 3 team'),
  // The enum must be rendered as words, not handed over as "a_lot".
  carriesImpact:       m.includes('How much it is affecting them: a lot'),
  noRawEnumLeak:       !m.includes('a_lot'),
  saysRecurring:       m.includes('3 of the last 4 weeks'),
  carriesOwnLibrary:   m.includes('Cover rota template'),
  warnsAgainstRepeat:  m.includes('Do not just repeat these'),
};

// A first-time, no-context request must still be well-formed rather than claiming a history.
const bare = compose({ topic: 'workload', impact: null, note: '', base: BASE, more: {}, signal: {} });
checks.bareSaysFirstWeek   = bare.userMsg.includes('first recent week');
checks.bareSaysNoNote      = bare.userMsg.includes('(none given)');
checks.bareColleaguesEmpty = bare.userMsg.includes('(nothing recorded for this theme yet)');
checks.bareHasNoFakeCount  = !/Bloom schools chose this theme/.test(bare.userMsg);

// The grounding guard: the corpus is everything sent, so a figure quoted from the colleague
// or context material must survive, while an invented one must not.
const withPct = compose({ topic: 'workload', impact: 'a_lot', note: NOTE, base: { ...BASE, evidence: 'Attendance rose by 12% where leaders protected time.' }, more: MORE, signal: SIGNAL });
checks.keepsQuotedFigure   = !ungrounded('Protecting time lifted attendance by 12% elsewhere.', withPct.corpus);
checks.rejectsInventedPct  = ungrounded('This raises outcomes by 40%.', full.corpus);
checks.rejectsInventedLink = ungrounded('See https://example.com for the policy.', full.corpus);
checks.rejectsPhoneNumber  = ungrounded('Call 868-1234 for support.', full.corpus);
checks.rejectsFakeStudy    = ungrounded('Research shows this works.', full.corpus);
checks.acceptsCleanAnswer  = !ungrounded('Ask the Form 3 team which duty to pause this fortnight.', full.corpus);

// Word limits are enforced server-side whatever the model returns.
checks.clampsLongTitle = clean('one two three four five six seven eight nine ten', 7).split(' ').length === 7;
checks.stripsQuotes    = clean('“Protect one block', 7) === 'Protect one block';
// An unknown impact value must read as "not shared", never as itself.
checks.unknownImpactSafe = compose({ topic:'workload', impact:'<script>', note:NOTE, base:BASE, more:MORE, signal:SIGNAL })
  .userMsg.includes('How much it is affecting them: not shared');

// Safeguarding is in the enum (it is blocked by topic, not by omission).
checks.safeguardingIsAKnownTopic = TOPICS.has('safeguarding');

// Untrusted input must not be able to grow the prompt without bound.
const flood = compose({ topic: 'workload', impact: 'x'.repeat(500), note: 'y'.repeat(5000), base: BASE,
  more: { checklist: Array(50).fill('z'.repeat(500)), peer: 'p'.repeat(5000) },
  signal: { ownLibrary: Array(50).fill('w'.repeat(500)) } });
checks.boundsHostileInput = flood.userMsg.length < 12000;

console.log(JSON.stringify(checks, null, 2));
console.log('\n--- assembled prompt (what the model actually receives) ---\n');
console.log(m);

const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? '\nfailed: ' + failed.join(', ') : '\nall checks passed');
console.log(failed.length ? 'TAILOR COMPOSE: FAIL' : 'TAILOR COMPOSE: PASS');
process.exit(failed.length ? 1 : 0);
