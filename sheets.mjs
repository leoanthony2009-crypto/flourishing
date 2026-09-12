// Opens every support sheet on step 3 and the PDF export, as a signed-in principal.
// These are the routes a principal reaches when they need help, so a render error here is
// the worst place to have one. Only BloomAPI's network calls are stubbed.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });

await page.addInitScript(() => {
  let real;
  Object.defineProperty(window, 'BloomAPI', {
    configurable: true,
    get() { return real; },
    set(v) {
      real = v;
      window.__writes = [];
      v.getSession = async () => ({ user: { id:'u-1' } });
      v.onAuthChange = () => {};
      v.loadProfile = async () => ({ profile: { user_id:'u-1', email:'p@x.tt', school_id:'sch-1', role:'principal' } });
      v.listSchools = async () => ([{ id:'sch-1', name:'Bloom Academy, San Fernando', short_name:'San Fernando' }]);
      v.listPerks = async () => ([]);
      v.myPulse = async () => ({ school_id:'sch-1', topic:'workload', impact:'a_lot', note:'Two staff out.' });
      v.myPulseHistory = async () => ([]);
      // Counts are other schools only; the client adds its own pulse back (excludes_self).
      v.networkPulse = async (wk) => ({ week_start:wk, included:3, schools_total:5, min_cell:2,
        excludes_self:true, current:[{topic:'workload',count:2}], previous:[],
        four_weeks:[{topic:'workload',counts:[0,0,0,2]}], suppressed:1 });
      v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
      v.listShared = async () => ([]); v.listRequests = async () => ([]);
      v.insertRequest = async (r) => { window.__writes.push(['request', r.type, r.topic]); return {}; };
      v.addShared = async (x) => { window.__writes.push(['shared', x.title]); return {}; };
    },
  });
});

await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('button:has-text("See my support")');
await page.waitForTimeout(900);

const SHEETS = [
  ['I need a resource',                          /Resource|planner|Stop/i],
  ['Give me a practical tool',                   /checklist/i],
  ['Show me another idea',                       /idea/i],
  ['How are other Bloom schools tackling this?', /Across Bloom|other schools/i],
  ['I’d like to talk this through',              /conversation|Copy message/i],
  ['I need central-team support',                /Advice|Urgent/i],
];

const sheetResults = [];
for (const [label, expect] of SHEETS) {
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(600);
  const t = await page.evaluate(() => document.body.innerText);
  const dialog = await page.$('[role="dialog"]');
  sheetResults.push({
    sheet: label.slice(0, 28),
    opens: !!dialog,
    hasExpectedContent: expect.test(t),
    // Every sheet must keep the crisis numbers reachable or repeat the safe route.
    safeToClose: !!(await page.$('button[aria-label="Close"]')),
  });
  await page.click('button[aria-label="Close"]');
  await page.waitForTimeout(400);
}

// The central-support sheet is the one that writes; exercise it end to end.
await page.click('button:has-text("I need central-team support")');
await page.waitForTimeout(600);
// Scope to the open sheet: the same labels appear elsewhere in the document.
const sheet = page.locator('[role="dialog"]');
await sheet.locator('button:has-text("Urgent")').first().click();
await page.fill('#central-context', 'Need to talk to someone today.');
await page.waitForTimeout(300);
const urgentNotice = await page.evaluate(() => document.body.innerText.includes('868-607-2326'));
await sheet.locator('button:has-text("Send request")').first().click();
await page.waitForTimeout(800);
const sent = await page.evaluate(() => ({
  confirmed: /Request sent|BP-/.test(document.body.innerText),
  writes: window.__writes,
}));
await page.click('button[aria-label="Close"]').catch(() => {});
await page.waitForTimeout(300);

// PDF export opens a new window; capture the document it writes.
await page.click('button:has-text("Back to network view")').catch(() => {});
await page.waitForTimeout(600);
const popupPromise = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
await page.evaluate(() => [...document.querySelectorAll('button')]
  .find(b => /Share|PDF|print/i.test(b.textContent) && /PDF|print|Share the/i.test(b.textContent))?.click());
const popup = await popupPromise;
let pdf = { opened: false };
if (popup) {
  await popup.waitForTimeout(600);
  const html = await popup.content();
  pdf = {
    opened: true,
    hasHeading: /What.s hot across Bloom/.test(html),
    namesSharedTheme: /Workload/.test(html),
    statesSuppression: /not shown to protect privacy/.test(html),
    hasCebmNumber: /868-607-2326/.test(html),
    saysAggregated: /Aggregated across/.test(html),
  };
  await popup.close();
}

await browser.close();
console.log('--- sheets ---');
console.table(sheetResults);
console.log('--- urgent request ---', JSON.stringify({ urgentNotice, ...sent }));
console.log('--- pdf export ---', JSON.stringify(pdf));
console.log('errors:', errors.length ? errors : 'none');

const pass = sheetResults.every(r => r.opens && r.hasExpectedContent && r.safeToClose)
  && urgentNotice && sent.confirmed
  && sent.writes.some(w => w[0] === 'request' && w[1] === 'urgent' && w[2] === 'workload')
  && errors.length === 0;
console.log(pass ? '\nSHEETS: PASS' : '\nSHEETS: FAIL');
process.exit(pass ? 0 : 1);
