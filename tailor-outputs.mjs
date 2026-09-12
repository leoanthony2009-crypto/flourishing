// Does the pipeline let a GOOD answer through, and stop a bad one?
//
// This is the half of "works with real concrete ideas" that does not need an API key. The
// model's wording is its own; what this repo controls is whether a concrete, correctly
// grounded answer survives validation — and a guard that bins good ideas is indistinguishable,
// to a principal, from a feature that does not work. Each candidate below is written the way
// the system prompt asks for: one action, today, naming the people in the note.
import { compose, ungrounded, clean } from './tailor/compose.mjs';

const LIMITS = { title: 8, body: 50, tryIt: 40, prompt: 22, grounding: 28 };

const CASES = [
  {
    name: 'workload — concrete, grounded in the note',
    topic: 'workload',
    note: 'Two teachers are out on sick leave and cover keeps falling on the same three people in the Form 3 team.',
    base: { label:'Workload & wellbeing', title:'Stop → Delegate → Protect', body:'Separate what must happen from habit.', tryIt:'Write three lines.', prompt:'What adds least value?',
      evidence:'Leadership time spent on teaching and learning has the strongest link to student outcomes of any principal activity; administrative load crowds it out unless deliberately protected.',
      source:'Robinson, Lloyd & Rowe (2008).', local:'Ministry returns and the SEA/CSEC calendar cluster demand at predictable points.' },
    more: { peer:'Other Bloom schools name one pause per half-term openly with staff.' },
    out: {
      title: 'Name the pause for Form 3',
      body: 'Cover is landing on the same three people while two colleagues are out. Protecting your own leadership time will not help them; removing a demand will.',
      tryIt: 'Before you leave today, tell the Form 3 team which one duty is paused until the two absent teachers return, and put it in writing so it is not theirs to re-argue.',
      prompt: 'Which demand on those three would nobody miss for a fortnight?',
      grounding: 'The evidence on protecting leadership time, and the Bloom practice of naming a pause openly.',
    },
    mustPass: true,
  },
  {
    name: 'teaching — quotes the supplied effect size',
    topic: 'teaching',
    note: 'Reading in Standard 3 is flat and the two newest teachers are unsure how to pitch it.',
    base: { label:'Teaching & learning', title:'Choose one observable improvement', body:'Turn broad goals into one behaviour.', tryIt:'This week we want to see more ___.', prompt:'What would we notice?',
      evidence:'Leading and participating in teacher learning has an effect size of about 0.84 on student outcomes — roughly twice that of any other leadership dimension studied.',
      source:'Robinson, Lloyd & Rowe (2008); Hattie (2009).', local:'Anchor the focus in the national curriculum standards and the next SEA checkpoint.' },
    more: { peer:'Other Bloom schools pick one visible behaviour and look for it in books rather than in lesson observations.' },
    out: {
      title: 'Sit in on one Standard 3 reading lesson',
      body: 'Joining teacher learning yourself carries an effect size of about 0.84 — more than any other thing you could lead this week, and your two newest teachers are asking for the steer.',
      tryIt: 'Sit with the two newest teachers for twenty minutes after school today and agree the one thing you all want to see in Standard 3 reading books by Friday.',
      prompt: 'What would I actually see in those books if this were taking hold?',
      grounding: 'The 0.84 effect size for leading teacher learning, and the Bloom habit of looking in books.',
    },
    mustPass: true,   // quoted from the evidence we supplied
  },
  {
    name: 'staffing — invents a percentage',
    topic: 'staffing',
    note: 'Two vacancies unfilled since September and the timetable is held together by goodwill.',
    base: { label:'Staffing & capacity', title:'Name the constraint', body:'Distinguish vacancy from deployment.', tryIt:'Complete the sentence.', prompt:'Where are we relying on goodwill?',
      evidence:'How staff are deployed inside a school explains more variation in outcomes than headcount alone.',
      source:'Leithwood, Harris & Hopkins (2020).', local:'Vacancies filled through the Teaching Service Commission take time.' },
    more: {},
    out: {
      title: 'Redeploy before you recruit',
      body: 'Schools that redeploy internally close 40% more of the gap than those that wait on recruitment.',
      tryIt: 'Map who is covering what by Friday.',
      prompt: 'What would we stop doing to free a period?',
      grounding: 'Deployment evidence.',
    },
    mustPass: false,  // 40% appears nowhere in what we sent
  },
  {
    name: 'attendance — sends them to a link',
    topic: 'attendance',
    note: 'Form 2 attendance dipped after Carnival and has not recovered.',
    base: { label:'Attendance', title:'Find the pattern', body:'Look at who, not how many.', tryIt:'List the ten lowest.', prompt:'Which families do we not yet know?',
      evidence:'Attendance responds to relationships with named families more than to blanket messaging.',
      source:'Bloom evidence base.', local:'Carnival and pre-SEA weeks show predictable dips.' },
    more: {},
    out: {
      title: 'Call five Form 2 families',
      body: 'The dip is concentrated, not general.',
      tryIt: 'See https://attendance-toolkit.example.com for the call script, then ring five families today.',
      prompt: 'Who would notice if we called?',
      grounding: 'Relationships evidence.',
    },
    mustPass: false,  // a link the app never supplied
  },
  {
    name: 'behaviour — appeals to research we never gave it',
    topic: 'behaviour',
    note: 'Low-level disruption in two Form 1 classes after lunch.',
    base: { label:'Student behaviour', title:'Start with the transition', body:'Most disruption begins between lessons.', tryIt:'Watch one transition.', prompt:'Where does it start?',
      evidence:'Consistency of adult response at transitions predicts classroom climate.',
      source:'Bloom evidence base.', local:'After-lunch periods are the common flashpoint locally.' },
    more: {},
    out: {
      title: 'Stand in the corridor after lunch',
      body: 'Studies show that adult presence at transitions reduces disruption.',
      tryIt: 'Stand at the Form 1 corridor for the first five minutes after lunch today.',
      prompt: 'What do I see in the first two minutes?',
      grounding: 'Transition evidence.',
    },
    mustPass: false,  // "Studies show" — an authority claim absent from the corpus
  },
];

const rows = [];
for (const c of CASES) {
  const { corpus } = compose({ topic: c.topic, impact: 'a_lot', note: c.note, base: c.base, more: c.more, signal: {} });
  const joined = [c.out.title, c.out.body, c.out.tryIt, c.out.prompt].join(' ');
  const rejected = ungrounded(joined, corpus);
  // What the principal would actually be shown, after the server's word limits.
  const shown = Object.fromEntries(Object.entries(c.out).map(([k, v]) => [k, clean(v, LIMITS[k])]));
  // A concrete answer must still name the specific thing after truncation, or the limits are
  // quietly sanding off the very detail that made it worth reading.
  const keyword = (c.note.match(/Form \d|Standard \d/) || [''])[0];
  const survivesTruncation = !keyword || (shown.title + ' ' + shown.body + ' ' + shown.tryIt).includes(keyword);
  rows.push({
    case: c.name.slice(0, 40),
    expected: c.mustPass ? 'accept' : 'reject',
    actual: rejected ? 'reject' : 'accept',
    ok: rejected !== c.mustPass,
    keptDetail: c.mustPass ? survivesTruncation : '—',
    tryItWords: shown.tryIt.split(' ').length,
  });
  if (c.mustPass) {
    console.log(`\n--- ${c.name} — what the principal sees ---`);
    console.log(`  ${shown.title}\n  ${shown.body}\n  Try this today: ${shown.tryIt}`);
  }
}

console.log('');
console.table(rows);
const pass = rows.every(r => r.ok && r.keptDetail !== false);
console.log(pass ? '\nTAILOR OUTPUTS: PASS' : '\nTAILOR OUTPUTS: FAIL');
process.exit(pass ? 0 : 1);
