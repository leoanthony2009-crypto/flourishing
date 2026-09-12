// The week_start the app writes must be a Monday in every timezone.
// Before the fix, weekISO() ran a local-midnight Date through toISOString(), so anywhere east
// of UTC it produced the previous SUNDAY — a week_start current_monday() never reads, which
// silently detached the pulse from every aggregate.
import { chromium } from 'playwright';

const ZONES = [
  ['America/Port_of_Spain', -4],   // the pilot's own timezone
  ['UTC', 0],
  ['Europe/London', +1],
  ['Asia/Tokyo', +9],
  ['Pacific/Kiritimati', +14],     // the furthest east there is
  ['Pacific/Midway', -11],         // and the furthest west
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const results = [];

for (const [tz] of ZONES) {
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, timezoneId: tz });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.addInitScript(() => {
    let real;
    Object.defineProperty(window, 'BloomAPI', {
      configurable: true,
      get() { return real; },
      set(v) {
        real = v;
        window.__week = null;
        v.getSession = async () => ({ user: { id:'u-1' } });
        v.onAuthChange = () => {};
        v.loadProfile = async () => ({ profile: { user_id:'u-1', email:'p@x.tt', school_id:'sch-1', role:'principal' } });
        v.listSchools = async () => ([{ id:'sch-1', name:'Bloom Academy, San Fernando', short_name:'San Fernando' }]);
        v.listPerks = async () => ([]);
        v.myPulse = async () => null;
        v.myPulseHistory = async () => ([]);
        v.networkPulse = async (wk) => { window.__netWeek = wk; return { week_start: wk, included:0, schools_total:5, current:[], previous:[], four_weeks:[], suppressed:0 }; };
        v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
        v.listShared = async () => ([]); v.listRequests = async () => ([]);
        v.upsertPulse = async (p) => { window.__week = p.weekStart; return {}; };
      },
    });
  });

  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.click('button:has-text("Workload & wellbeing")');
  await page.click('button:has-text("A lot")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Submit pulse")');
  await page.waitForTimeout(900);

  const { week, netWeek, localToday } = await page.evaluate(() => ({
    week: window.__week, netWeek: window.__netWeek,
    localToday: new Date().toString().slice(0, 3),
  }));

  // Parse as a plain date, not a timestamp, so this check is itself timezone-free.
  const dow = week ? new Date(week + 'T12:00:00Z').getUTCDay() : null;
  results.push({ tz, localToday, weekWritten: week, isMonday: dow === 1, matchesAggregateQuery: week === netWeek, errs: errs.length });
  await ctx.close();
}

await browser.close();
console.table(results);
const pass = results.every(r => r.isMonday && r.matchesAggregateQuery && r.errs === 0);
console.log(pass ? '\nTIMEZONE: PASS — every zone writes a Monday' : '\nTIMEZONE: FAIL');
process.exit(pass ? 0 : 1);
