// Accessibility regressions that are invisible in review and silent in use.
//
// The big one: the bundler boots with document.documentElement.replaceWith(...), so anything
// living only in the outer <head> is destroyed the moment JavaScript runs. The page title, the
// manifest and every icon were — a tab with no name, a screen reader with nothing to announce
// on load, and no "Add to Home Screen" on an app whose whole premise is a weekly phone habit.
// Static HTML looks perfect; only the live DOM shows it. So these assertions run post-boot.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];

const STUB = () => {
  let real;
  Object.defineProperty(window, 'BloomAPI', { configurable:true, get(){return real;}, set(v){ real=v;
    v.getSession = async () => ({ user:{id:'u-1'} }); v.onAuthChange = () => {};
    v.loadProfile = async () => ({ profile:{ user_id:'u-1', email:'h@x.tt', school_id:'s1', role:'principal' } });
    v.listSchools = async () => ([{id:'s1',name:'Bloom Academy, Port of Spain',short_name:'Port of Spain'}]);
    v.listPerks = async () => ([]); v.myPulse = async () => null; v.myPulseHistory = async () => ([]);
    v.networkPulse = async (w) => ({week_start:w,included:3,schools_total:5,min_cell:2,excludes_self:true,
      current:[{topic:'workload',count:2}],previous:[],four_weeks:[],suppressed:1});
    v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
    v.listShared = async () => ([]); v.listRequests = async () => ([]);
    v.upsertPulse = async () => ({}); v.insertRequest = async () => ({}); v.addShared = async () => ({});
    v.tailor = async () => ({status:'error',reason:'not_configured'});
  }});
};

const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
await page.addInitScript(STUB);
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2800);

// ---- 1. What survives the documentElement swap ------------------------------
const head = await page.evaluate(() => ({
  title: document.title,
  lang: document.documentElement.lang,
  manifest: !!document.querySelector('link[rel="manifest"]'),
  icon: !!document.querySelector('link[rel="icon"]'),
  appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
  viewport: !!document.querySelector('meta[name="viewport"]'),
}));

// ---- 2. Names, labels and targets across the signed-in app -------------------
const probe = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; };
  // Mirrors how an assistive technology resolves a name, including <label for>.
  const named = (el) => {
    if (el.getAttribute('aria-label')) return true;
    const lb = el.getAttribute('aria-labelledby');
    if (lb && document.getElementById(lb)) return true;
    if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
    if (el.closest('label')) return true;
    if (el.getAttribute('title')) return true;
    return !!(el.textContent || '').trim();
  };
  const controls = [...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]')].filter(vis);
  return {
    controls: controls.length,
    unnamed: controls.filter(el => !named(el)).map(el => el.outerHTML.slice(0, 80)),
    // WCAG 2.2 SC 2.5.8 sets a 24x24 floor; this app's own convention is 44.
    below24: controls.filter(el => { const r = el.getBoundingClientRect(); return r.height < 24 || r.width < 24; })
      .map(el => `${el.tagName}:${(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,30)}`),
    below44: controls.filter(el => el.getBoundingClientRect().height < 44)
      .map(el => `${el.tagName}:${(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,30)}`),
    imagesMissingAlt: [...document.querySelectorAll('img')].filter(vis).filter(i => i.getAttribute('alt') === null).length,
  };
};
const step1 = await page.evaluate(probe);

// ---- 3. The modal sheet: labelled, focus moved in, focus restored on close ----
const beforeOpen = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /account/i.test(x.getAttribute('aria-label') || ''));
  b.setAttribute('data-opener', '1'); b.focus();
  return document.activeElement === b;
});
await page.click('button[data-opener="1"]');
await page.waitForTimeout(700);
const opened = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  return {
    present: !!d,
    modal: d && d.getAttribute('aria-modal') === 'true',
    labelled: !!(d && (d.getAttribute('aria-label') || d.getAttribute('aria-labelledby'))),
    // Focus must be inside the sheet, or a keyboard user is tabbing through the page behind it.
    focusInside: !!(d && d.contains(document.activeElement)),
    hasCloseButton: !!(d && d.querySelector('button[aria-label="Close"]')),
  };
});
// Escape must close it — the sheet covers the whole screen on a phone.
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const closed = await page.evaluate(() => ({
  gone: !document.querySelector('[role="dialog"]'),
  focusRestored: document.activeElement === document.querySelector('button[data-opener="1"]'),
  focusNotLost: document.activeElement !== document.body,
}));

await page.close();
await browser.close();

console.log('--- head, after the documentElement swap ---'); console.log(JSON.stringify(head, null, 1));
console.log('--- step 1 controls ---'); console.log(JSON.stringify(step1, null, 1));
console.log('--- modal sheet ---'); console.log(JSON.stringify({ beforeOpen, opened, closed }, null, 1));

const checks = {
  titleSurvives:    head.title === 'Bloom Principal Pulse',
  langDeclared:     head.lang === 'en-TT',
  manifestSurvives: head.manifest,
  iconSurvives:     head.icon && head.appleIcon,
  viewportSurvives: head.viewport,
  everyControlNamed: step1.unnamed.length === 0,
  meetsWcag2258:     step1.below24.length === 0,
  meetsOwn44Rule:    step1.below44.length === 0,
  everyImageHasAlt:  step1.imagesMissingAlt === 0,
  dialogIsModal:     opened.present && opened.modal && opened.labelled,
  focusEntersDialog: opened.focusInside,
  dialogHasClose:    opened.hasCloseButton,
  escapeCloses:      closed.gone,
  focusRestored:     closed.focusRestored,
  noPageErrors:      errors.length === 0,
};
console.log('\n' + JSON.stringify(checks, null, 1));
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log('errors:', errors.length ? errors : 'none');
console.log(failed.length ? 'failed: ' + failed.join(', ') : 'all accessibility checks passed');
console.log(failed.length ? 'A11Y: FAIL' : 'A11Y: PASS');
process.exit(failed.length ? 1 : 0);
