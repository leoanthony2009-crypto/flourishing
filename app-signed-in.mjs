// Drives the built app through all four steps as a signed-in principal.
// Only BloomAPI's network methods are replaced; the component, its state and the whole
// template are the real thing. Payload shapes match what the live API actually returned
// during end-to-end testing.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });

const SAN = '4b32af66-3fed-4602-a703-c5eb81a7111f';
const d0 = new Date(); d0.setHours(0,0,0,0); d0.setDate(d0.getDate() - ((d0.getDay()+6)%7));
const monday = d0.toISOString().slice(0,10);

// The data layer is assigned to window.BloomAPI by a bundled script. Intercept that
// assignment so the stubs are in place before the component's readiness poll sees it.
await page.addInitScript(({ SAN, monday }) => {
  let real;
  Object.defineProperty(window, 'BloomAPI', {
    configurable: true,
    get() { return real; },
    set(v) { real = v; patch(v); },
  });
  function patch(A) {
  window.__writes = window.__writes || [];
  A.getSession = async () => ({ user: { id: 'u-1' } });
  A.onAuthChange = () => {};
  // loadProfile returns {profile} | {absent} | {failed} so a lookup failure is not mistaken
  // for an allow-list rejection.
  A.loadProfile = async () => ({ profile: { user_id:'u-1', email:'head@sanfernando.tt', school_id:SAN, role:'principal' } });
  A.listSchools = async () => ([
    { id:SAN, name:'Bloom Academy, San Fernando', short_name:'San Fernando' },
    { id:'s2', name:'Bloom Academy, Arima', short_name:'Arima' },
    { id:'s3', name:'Bloom Academy, Port of Spain', short_name:'Port of Spain' },
    { id:'s4', name:'Bloom Academy, Chaguanas', short_name:'Chaguanas' },
    { id:'s5', name:'Bloom Academy, Scarborough', short_name:'Scarborough' },
  ]);
  A.listPerks = async () => ([
    { id:'rik', partner:'R.I.K. Services', offer:'Classroom books & stationery', detail:'10% off.',
      cost:20, terms:'T&C', valid_days:90, active:false },
    { id:'starbucks', partner:'Starbucks Trinidad & Tobago', offer:'Staffroom Friday', detail:'20% off.',
      cost:30, terms:'T&C', valid_days:90, active:false },
  ]);
  A.myPulse = async () => null;                       // nothing submitted yet this week
  A.myPulseHistory = async () => ([{ week_start: monday }]);
  // Exactly the shape the live RPC returned: one named theme, one suppressed.
  A.networkPulse = async () => ({
    week_start: monday, included: 3, schools_total: 5, min_cell: 2,
    current: [{ topic:'workload', count:2 }], previous: [],
    four_weeks: [{ topic:'workload', counts:[0,0,0,2] }], suppressed: 1,
  });
  A.listLedger = async () => ([{ week_start: monday, kind:'pulse', delta:10 }]);
  A.listRedemptions = async () => ([]);
  A.listShared = async () => ([]);
  A.listRequests = async () => ([]);
  A.upsertPulse = async (p) => { window.__writes.push(['pulse', p.topic, p.impact, p.note]); return {}; };
  A.insertRequest = async (r) => { window.__writes.push(['request', r.type, r.ref]); return {}; };
  A.addShared = async (x) => { window.__writes.push(['shared', x.title]); return {}; };
  }
}, { SAN, monday });

await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

const txt = () => page.evaluate(() => document.body.innerText);
const shot = (n) => page.screenshot({ path: `/tmp/app-${n}.png` });

// --- Step 1 -----------------------------------------------------------------
let t = await txt();
const step1 = {
  signedIn: !(await page.$("#signin-email")),
  header: t.includes('San Fernando'),
  heading: t.includes('What’s on your radar this week?'),
  hintBeforeChoosing: t.includes('Choose one area to continue'),
};
await page.click('button:has-text("Workload & wellbeing")');
await page.click('button:has-text("A lot")');
await page.fill('#pulse-note', 'Two staff out and cover is thin.');
await page.waitForTimeout(400);
await shot('step1');
await page.click('button:has-text("Submit pulse")');
await page.waitForTimeout(1200);

// --- Step 2: the network view ------------------------------------------------
t = await txt();
const step2 = {
  reached: t.includes('3 of 5 principal pulses included'),
  namesSharedTheme: t.includes('Workload & wellbeing'),
  showsSuppression: /1 further theme not shown to protect privacy/.test(t),
  neverNamesSuppressed: !t.includes('SEND & inclusion') && !t.includes('Safeguarding'),
};
await shot('step2');

await page.click('button:has-text("See my support")');
await page.waitForTimeout(1200);

// --- Step 3: the idea + AI + support routes ----------------------------------
t = await txt();
const step3 = {
  reached: t.includes('Try this today') || t.includes('Tailor this idea'),
  hasSupportRoutes: t.includes('I need central-team support'),
  chipReflectsAggregate: /2 of 5 schools chose this theme/.test(t),
};
await shot('step3');

await page.click('button:has-text("See my points & perks")');
await page.waitForTimeout(1200);

// --- Step 4: points and perks -------------------------------------------------
t = await txt();
const step4 = {
  reached: t.includes('Bloom points') || t.includes('points'),
  serverPoints: t.includes('10'),
  perksInPreview: t.includes('Term 2'),
  partnersListed: t.includes('R.I.K. Services') || t.includes('Starbucks'),
};
await shot('step4');

const writes = await page.evaluate(() => window.__writes);
await browser.close();

const report = { step1, step2, step3, step4, writes, errors };
console.log(JSON.stringify(report, null, 2));

const pass =
  step1.header && step1.heading &&
  step2.reached && step2.namesSharedTheme && step2.showsSuppression && step2.neverNamesSuppressed &&
  step3.reached && step3.hasSupportRoutes &&
  step4.reached && step4.perksInPreview &&
  writes.some(w => w[0] === 'pulse' && w[1] === 'workload' && w[2] === 'a_lot') &&
  errors.length === 0;
console.log(pass ? '\nAPP SIGNED-IN: PASS' : '\nAPP SIGNED-IN: FAIL');
process.exit(pass ? 0 : 1);
