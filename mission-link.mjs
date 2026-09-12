// The "Our mission" link on the sign-in screen. An external link opened with target=_blank
// hands the new page a window.opener reference unless rel says otherwise, so the attributes
// matter as much as the href.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });
// The link must never be fetched by the test itself.
await page.route('**://bloomtt.netlify.app/**', r => r.abort());

await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#signin-email', { timeout: 15000 });

const link = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find(x => /our mission/i.test(x.textContent));
  if (!a) return null;
  const r = a.getBoundingClientRect();
  const cs = getComputedStyle(a);
  return {
    text: a.textContent.trim(),
    href: a.getAttribute('href'),
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
    // A 44px minimum tap target, like every other control in this app.
    height: Math.round(r.height),
    width: Math.round(r.width),
    onSignInScreen: !!document.querySelector('#signin-email'),
    // It must not push the primary action off screen on a phone.
    visibleWithoutScrolling: r.top >= 0 && r.bottom <= window.innerHeight,
    colour: cs.color,
  };
});
console.log(JSON.stringify(link, null, 2));

// The sign-in call to action must still be reachable and the page must not scroll sideways.
const layout = await page.evaluate(() => ({
  ctaPresent: [...document.querySelectorAll('button')].some(b => /Send me a sign-in link/.test(b.textContent)),
  noSideScroll: document.documentElement.scrollWidth <= window.innerWidth,
}));
console.log(JSON.stringify(layout));
await page.screenshot({ path: '/tmp/mission-link.png' });
await page.close();

// --- and again once signed in --------------------------------------------------
// A principal passes the sign-in screen once and never returns to it, so the link there is
// invisible to them from their second visit on. The Account sheet is where it stays reachable.
const app = await browser.newPage({ viewport: { width: 402, height: 874 } });
app.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
app.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });
await app.route('**://bloomtt.netlify.app/**', r => r.abort());
await app.addInitScript(() => {
  let real;
  Object.defineProperty(window, 'BloomAPI', {
    configurable: true,
    get() { return real; },
    set(v) {
      real = v;
      v.getSession = async () => ({ user: { id: 'u-1' } });
      v.onAuthChange = () => {};
      v.loadProfile = async () => ({ profile: { user_id:'u-1', email:'head@pos.tt', school_id:'sch-1', role:'principal' } });
      v.listSchools = async () => ([{ id:'sch-1', name:'Bloom Academy, Port of Spain', short_name:'Port of Spain' }]);
      v.listPerks = async () => ([]); v.myPulse = async () => null; v.myPulseHistory = async () => ([]);
      v.networkPulse = async (wk) => ({ week_start:wk, included:0, schools_total:5, excludes_self:true,
        current:[], previous:[], four_weeks:[], suppressed:0 });
      v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
      v.listShared = async () => ([]); v.listRequests = async () => ([]);
    },
  });
});
await app.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await app.waitForTimeout(2500);

const signedIn = { reachedApp: !(await app.$('#signin-email')) };
// Open the Account sheet from the header control.
await app.evaluate(() => [...document.querySelectorAll('button')]
  .find(b => /account|settings/i.test(b.getAttribute('aria-label') || ''))?.click());
await app.waitForTimeout(700);
Object.assign(signedIn, await app.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find(x => /our mission/i.test(x.textContent));
  const sheet = document.querySelector('[role="dialog"]');
  const r = a && a.getBoundingClientRect();
  return {
    sheetOpen: !!sheet,
    inSheet: !!(a && sheet && sheet.contains(a)),
    href: a && a.getAttribute('href'),
    rel: a && a.getAttribute('rel'),
    target: a && a.getAttribute('target'),
    height: r ? Math.round(r.height) : 0,
    saysNewTab: /Opens in a new tab/i.test(document.body.innerText),
    // Sign-out must still be there and not displaced by the new block.
    signOutPresent: [...document.querySelectorAll('button')].some(b => /sign out|end session|reset/i.test(b.textContent)),
  };
}));
console.log('--- signed in, account sheet ---', JSON.stringify(signedIn, null, 2));
await app.screenshot({ path: '/tmp/mission-account.png' });
await app.close();
await browser.close();

const pass = link
  && /our mission/i.test(link.text)
  && link.href === 'https://bloomtt.netlify.app/'
  && link.target === '_blank'
  // Without noopener the opened page gets a handle on this one via window.opener.
  && /noopener/.test(link.rel || '') && /noreferrer/.test(link.rel || '')
  && link.height >= 44
  && link.onSignInScreen && link.visibleWithoutScrolling
  && layout.ctaPresent && layout.noSideScroll
  // Reachable after sign-in too, with the same safety attributes.
  && signedIn.reachedApp && signedIn.sheetOpen && signedIn.inSheet
  && signedIn.href === 'https://bloomtt.netlify.app/'
  && signedIn.target === '_blank'
  && /noopener/.test(signedIn.rel || '') && /noreferrer/.test(signedIn.rel || '')
  && signedIn.height >= 44 && signedIn.saysNewTab && signedIn.signOutPresent
  && errors.length === 0;
console.log('\nerrors:', errors.length ? errors : 'none');
console.log(pass ? 'MISSION LINK: PASS' : 'MISSION LINK: FAIL');
process.exit(pass ? 0 : 1);
