// End-to-end check of the built app against the live Supabase project.
// Exercises the magic-link request path with an address that is NOT on the pilot
// allow-list, so it proves connectivity and the rejection path without sending mail.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });

const errors = [], api = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', async r => {
  const u = r.url();
  if (u.includes('supabase.co')) api.push(`${r.status()} ${r.request().method()} ${u.replace(/^https:\/\/[^/]+/, '')}`);
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#signin-email', { timeout: 15000 });

const btn = page.locator('button', { hasText: 'Send me a sign-in link' });
console.log('button disabled with empty email:', await btn.isDisabled());

await page.fill('#signin-email', 'not-an-email');
await page.waitForTimeout(300);
console.log('button disabled with invalid email:', await btn.isDisabled());

// An address that is not on pilot_allowlist. shouldCreateUser:false means Supabase
// rejects it without sending anything.
await page.fill('#signin-email', 'nobody-not-on-the-list@example.invalid');
await page.waitForTimeout(300);
console.log('button enabled with valid email:', await btn.isEnabled());

await btn.click();
await page.waitForTimeout(6000);

const state = await page.evaluate(() => ({
  alert: document.querySelector('[role="alert"]')?.textContent?.trim() || null,
  checkEmailShown: document.body.innerText.includes('Check your email'),
  stillOnSignIn: !!document.querySelector('#signin-email'),
}));

console.log('\n--- supabase calls ---');
api.forEach(a => console.log('  ' + a));
console.log('\n--- ui state after submit ---');
console.log(JSON.stringify(state, null, 2));
console.log('\n--- js errors (' + errors.length + ') ---');
errors.slice(0, 10).forEach(e => console.log('  ' + e));

await page.screenshot({ path: '/tmp/e2e.png' });
await browser.close();

const reachedSupabase = api.some(a => a.includes('/auth/v1/otp'));
const rejectedCleanly = !state.checkEmailShown && !!state.alert;
const ok = reachedSupabase && rejectedCleanly && errors.length === 0;
console.log(ok ? '\nE2E: PASS' : '\nE2E: FAIL');
process.exit(ok ? 0 : 1);
