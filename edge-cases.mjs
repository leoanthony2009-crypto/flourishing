// Three failure modes specific to how this app is actually used: a principal on a phone,
// mid-week, often interrupted. None of these are covered by the happy-path suites.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];

const stub = (opts = {}) => `(${((o) => {
  let real;
  Object.defineProperty(window, 'BloomAPI', { configurable:true, get(){return real;}, set(v){ real=v;
    window.__writes = []; window.__xss = 0;
    v.getSession = async () => ({ user:{id:'u-1'} }); v.onAuthChange = () => {};
    v.loadProfile = async () => ({ profile:{ user_id:'u-1', email:'h@x.tt', school_id:'s1', role:'principal' } });
    v.listSchools = async () => ([{id:'s1',name:'Bloom Academy, Port of Spain',short_name:'Port of Spain'}]);
    v.listPerks = async () => ([]); v.myPulse = async () => null; v.myPulseHistory = async () => ([]);
    v.networkPulse = async (w) => ({week_start:w,included:1,schools_total:5,excludes_self:true,
      current:[],previous:[],four_weeks:[],suppressed:0});
    v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
    v.listShared = async () => ([]); v.listRequests = async () => ([]);
    v.upsertPulse = async (p) => {
      window.__writes.push({ week: p.weekStart, topic: p.topic, note: p.note, at: Date.now() });
      if (o.failWrites) throw new Error('network');
      await new Promise(r => setTimeout(r, o.slowMs || 0));
      return {};
    };
    v.insertRequest = async (r) => { window.__requests = window.__requests || []; window.__requests.push(r.ref);
      await new Promise(x => setTimeout(x, o.slowMs || 0)); return {}; };
    v.addShared = async () => ({});
    v.tailor = async () => ({status:'error',reason:'not_configured'});
  }});
}).toString()})(${JSON.stringify(opts)})`;

async function open(opts) {
  const p = await browser.newPage({ viewport: { width: 402, height: 874 } });
  p.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await p.addInitScript(stub(opts));
  await p.goto('http://127.0.0.1:8765/index.html', { waitUntil:'networkidle', timeout:60000 });
  await p.waitForTimeout(2500);
  return p;
}

// ---- 1. Rapid double-submit ----------------------------------------------------
// A slow connection plus an impatient tap. The write must not be duplicated: a second pulse
// would mean a second +10 and a second row for the same week.
const p1 = await open({ slowMs: 900 });
await p1.click('button:has-text("Workload & wellbeing")');
await p1.click('button:has-text("A lot")');
await p1.waitForTimeout(300);
// Five synchronous clicks — no waiting for re-render between them.
await p1.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Submit pulse/.test(x.textContent));
  for (let i = 0; i < 5; i++) b.click();
});
await p1.waitForTimeout(2500);
const doubleSubmit = await p1.evaluate(() => ({
  writes: window.__writes.length,
  weeks: [...new Set(window.__writes.map(w => w.week))],
}));
await p1.close();

// ---- 2. Hostile open text ------------------------------------------------------
// Principals type on phones. Emoji at the length boundary, and anything pasted from elsewhere.
const NASTY = '😔'.repeat(60) + `'); DROP TABLE pulses;-- <img src=x onerror="window.__xss=1"> </script>`;
const p2 = await open({});
await p2.click('button:has-text("Workload & wellbeing")');
await p2.click('button:has-text("A lot")');
await p2.fill('#pulse-note', NASTY);
await p2.waitForTimeout(400);
await p2.click('button:has-text("Submit pulse")');
await p2.waitForTimeout(1500);
const hostile = await p2.evaluate(() => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const w = window.__writes[0] || {};
  return {
    wrote: !!w.note,
    noteLength: (w.note || '').length,
    // The textarea caps at 240 UTF-16 units; the cut must not split an emoji.
    hasLoneSurrogate: lone.test(w.note || ''),
    // JSON.stringify is what the network layer does; a lone surrogate breaks encoding here.
    survivesEncoding: (() => { try { return !lone.test(JSON.stringify(w.note || '')); } catch { return false; } })(),
    xssFired: window.__xss === 1,
    // The markup must not have been injected into the document.
    injectedImg: !!document.querySelector('img[src="x"]'),
    stillUsable: !!document.body.innerText,
  };
});
await p2.close();

// ---- 3. Session lost while writing ---------------------------------------------
// The link expires after an hour; a principal who drafted a note over lunch must not lose it.
const p3 = await open({ failWrites: true });
await p3.click('button:has-text("Workload & wellbeing")');
await p3.click('button:has-text("A lot")');
await p3.fill('#pulse-note', 'Two staff out; cover falling on the same three people.');
await p3.waitForTimeout(400);
await p3.click('button:has-text("Submit pulse")');
await p3.waitForTimeout(1200);
const lost = await p3.evaluate(() => {
  const key = Object.keys(localStorage).find(k => k.startsWith('bloom-pulse-draft:'));
  const draft = key ? JSON.parse(localStorage.getItem(key)) : null;
  const text = document.body.innerText;
  return {
    draftKept: !!(draft && /same three people/.test(draft.note || '')),
    draftHasTopic: !!(draft && draft.topic === 'workload'),
    // It must say it failed, not pretend it saved.
    tellsThem: /Couldn.t save your pulse/i.test(text),
    doesNotClaimSaved: !/Pulse saved|Update pulse/i.test(text),
    // And leave them on the form with their words still on screen.
    noteStillOnScreen: (document.querySelector('#pulse-note') || {}).value?.includes('same three people') === true,
  };
});
await p3.close();

// ---- 4. Rapid taps on an urgent central request --------------------------------
// The worst version of case 1: insertRequest is a plain insert and each attempt mints a fresh
// random ref, so duplicates are not absorbed the way the pulse upsert absorbs them. Five taps
// on Urgent meant five identical alarms reaching the central team from one school.
const p4 = await open({ slowMs: 700 });
await p4.click('button:has-text("Workload & wellbeing")');
await p4.click('button:has-text("A lot")');
await p4.waitForTimeout(250);
await p4.click('button:has-text("Submit pulse")');
await p4.waitForTimeout(1200);
await p4.click('button:has-text("See my support")');
await p4.waitForTimeout(900);
await p4.click('button:has-text("I need central-team support")');
await p4.waitForTimeout(600);
const sheet = p4.locator('[role="dialog"]');
await sheet.locator('button:has-text("Urgent")').first().click();
await p4.fill('#central-context', 'Need to talk to someone today.');
await p4.waitForTimeout(300);
await p4.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  const b = [...d.querySelectorAll('button')].find(x => /Send request/.test(x.textContent));
  for (let i = 0; i < 5; i++) b.click();
});
await p4.waitForTimeout(2500);
const urgent = await p4.evaluate(() => ({
  sent: (window.__requests || []).length,
  refs: [...new Set(window.__requests || [])].length,
}));
await p4.close();
await browser.close();

console.log('1. rapid double-submit   ', JSON.stringify(doubleSubmit));
console.log('2. hostile open text     ', JSON.stringify(hostile));
console.log('3. session lost writing  ', JSON.stringify(lost));
console.log('4. rapid urgent request  ', JSON.stringify(urgent));

const checks = {
  // One pulse per week, however many times the button is hit.
  singleWritePerWeek:   doubleSubmit.weeks.length === 1,
  notDuplicated:        doubleSubmit.writes === 1,
  emojiNotSplit:        hostile.wrote && !hostile.hasLoneSurrogate,
  encodesOnTheWire:     hostile.survivesEncoding,
  noScriptExecuted:     !hostile.xssFired && !hostile.injectedImg,
  appStillUsable:       hostile.stillUsable,
  draftSurvivesFailure: lost.draftKept && lost.draftHasTopic,
  failureIsHonest:      lost.tellsThem && lost.doesNotClaimSaved,
  wordsStillOnScreen:   lost.noteStillOnScreen,
  // One urgent alarm, not five.
  oneUrgentRequest:     urgent.sent === 1 && urgent.refs === 1,
  noPageErrors:         errors.length === 0,
};
console.log('\n' + JSON.stringify(checks, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? 'failed: ' + failed.join(', ') : 'all edge cases handled');
console.log(failed.length ? 'EDGE CASES: FAIL' : 'EDGE CASES: PASS');
process.exit(failed.length ? 1 : 0);
