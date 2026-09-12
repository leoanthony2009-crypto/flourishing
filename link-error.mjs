// What the app does with the address a FAILED magic link lands on.
// Now that Site URL points here, an expired or already-used link redirects to this app with
// the reason in the fragment — the exact shape the live /auth/v1/verify endpoint returns.
// Nothing read it before, so the person clicked a link, arrived at a blank sign-in screen,
// and was told nothing. These are real Location values captured from the live endpoint.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8765/index.html';
const CASES = [
  ['expired or used link (live shape)',
   '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=',
   /already been used or has expired/],
  ['denied, no code',
   '#error=access_denied&error_description=Something+went+wrong',
   /was not accepted/],
  ['error in the query string instead',
   '?error=server_error&error_description=Unexpected+failure',
   /Unexpected failure/],
  ['opened normally — no error at all', '', null],
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const results = [];
for (const [name, suffix, expect] of CASES) {
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + suffix, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2200);
  const seen = await page.evaluate(() => ({
    alert: document.querySelector('[role="alert"]')?.textContent?.trim() || '',
    url: location.href,
    onSignIn: !!document.querySelector('#signin-email'),
  }));
  results.push({
    case: name.slice(0, 34),
    explains: expect ? expect.test(seen.alert) : seen.alert === '',
    // The reason must not survive a refresh, or it reappears after the person has moved on.
    urlCleaned: !/error/.test(seen.url),
    // And they must be able to act on it right away.
    canRetry: seen.onSignIn,
    errs: errors.length,
    message: seen.alert.slice(0, 52),
  });
  await page.close();
}
await browser.close();

console.table(results);
const pass = results.every(r => r.explains && r.urlCleaned && r.canRetry && r.errs === 0);
console.log(pass ? '\nLINK ERROR: PASS' : '\nLINK ERROR: FAIL');
process.exit(pass ? 0 : 1);
