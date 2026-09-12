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
  && errors.length === 0;
console.log('\nerrors:', errors.length ? errors : 'none');
console.log(pass ? 'MISSION LINK: PASS' : 'MISSION LINK: FAIL');
process.exit(pass ? 0 : 1);
