// The app has to open on bad school wifi. It also has to keep nothing private in that cache:
// every Supabase response is scoped to one school by RLS, so a cached copy on a handed-over
// device would be a leak RLS cannot help with. Both halves are asserted here.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, serviceWorkers: 'allow' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
// Registration happens on window load; give it a moment plus a reload so it takes control.
await page.waitForTimeout(1500);
const registered = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return !!r && !!(r.active || r.installing || r.waiting);
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  const c = await caches.open(names[0]);
  const keys = await c.keys();
  return { cacheNames: names, urls: keys.map(r => new URL(r.url).pathname).sort() };
});

// ---- the privacy half: a real API response must NOT end up in the cache ----------
// Drive one same-origin fetch and one cross-origin (Supabase-shaped) fetch, then look.
await page.evaluate(async () => {
  try { await fetch('/manifest.webmanifest'); } catch (e) {}
  try { await fetch('https://phnpteeujuaqebzteacd.supabase.co/rest/v1/pulses?select=note'); } catch (e) {}
});
await page.waitForTimeout(1200);
const afterFetches = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = [];
  for (const n of names) {
    const keys = await (await caches.open(n)).keys();
    out.push(...keys.map(r => r.url));
  }
  return out;
});

// ---- offline ---------------------------------------------------------------------
await ctx.setOffline(true);
const offline = await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' })
  .then(async (r) => {
    // The component mounts after parse; reading straight after domcontentloaded catches an
    // empty body and says "broken" about an app that works.
    await page.waitForTimeout(2500);
    return {
    status: r ? r.status() : 0,
    // The real question: does a principal see the app, or a browser error page?
    showsApp: await page.evaluate(() => /Principal Pulse|radar this week/i.test(document.body.innerText)),
    title: await page.title(),
    };
  })
  .catch((e) => ({ status: 0, showsApp: false, error: String(e).slice(0, 80) }));
await ctx.setOffline(false);

await browser.close();

console.log('registered        :', registered, '| controlled:', controlled);
console.log('cache             :', JSON.stringify(cached, null, 1));
console.log('urls after fetches:', JSON.stringify(afterFetches.map(u => u.replace('http://127.0.0.1:8765', '')), null, 1));
console.log('offline load      :', JSON.stringify(offline));

const supabaseCached = afterFetches.some(u => /supabase\.co/.test(u));
const checks = {
  workerRegisters:      registered,
  workerTakesControl:   controlled,
  shellIsCached:        cached.urls.includes('/index.html') || cached.urls.includes('/'),
  oneCacheOnly:         cached.cacheNames.length === 1,
  // The whole point: no per-school API response is ever stored.
  noSupabaseInCache:    !supabaseCached,
  opensOffline:         offline.showsApp === true,
  titleSurvivesOffline: offline.title === 'Bloom Principal Pulse',
  noPageErrors:         errors.length === 0,
};
console.log('\n' + JSON.stringify(checks, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? 'failed: ' + failed.join(', ') : 'opens offline, caches nothing private');
console.log(failed.length ? 'OFFLINE: FAIL' : 'OFFLINE: PASS');
process.exit(failed.length ? 1 : 0);
