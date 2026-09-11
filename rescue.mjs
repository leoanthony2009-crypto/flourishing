// Exercises the "the link didn't work" rescue path in the built app.
// Only the two network calls are stubbed; the UI, state and wiring are the real thing.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });

await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#signin-email', { timeout: 15000 });

// Replace only the two calls that would leave the sandbox.
await page.evaluate(() => {
  window.__calls = [];
  window.BloomAPI.sendMagicLink = async (email) => { window.__calls.push(['send', email]); return true; };
  window.BloomAPI.completeSignIn = async (pasted) => {
    window.__calls.push(['complete', pasted]);
    if (!/^https?:\/\//.test(pasted.trim())) throw new Error('bad_link');
    if (pasted.includes('used')) throw new Error('Token has expired or is invalid');
    return { session: {} };
  };
});

await page.fill('#signin-email', 'principal.arima@bloom.tt');
await page.click('button:has-text("Send me a sign-in link")');
await page.waitForTimeout(600);

const sent = await page.evaluate(() => ({
  checkEmail: document.body.innerText.includes('Check your email'),
  hasDisclosure: !!document.evaluate("//button[contains(., \"The link didn’t work\")]", document, null, 9, null).singleNodeValue,
  pasteFieldHidden: !document.querySelector('#paste-link'),
}));
console.log('after send:', JSON.stringify(sent));

// Open the disclosure.
await page.evaluate(() => document.evaluate("//button[contains(., \"The link didn’t work\")]", document, null, 9, null).singleNodeValue.click());
await page.waitForTimeout(400);
const opened = await page.evaluate(() => ({
  pasteFieldShown: !!document.querySelector('#paste-link'),
  buttonDisabledWhenEmpty: document.evaluate("//button[contains(., 'Sign me in')]", document, null, 9, null).singleNodeValue?.disabled,
}));
console.log('disclosure open:', JSON.stringify(opened));

// 1. Garbage input -> friendly, specific error.
await page.fill('#paste-link', 'not a link');
await page.waitForTimeout(250);
await page.click('button:has-text("Sign me in")');
await page.waitForTimeout(500);
const bad = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent?.trim());
console.log('bad input ->', JSON.stringify(bad));

// 2. Already-used link -> the expiry message, not the generic one.
await page.fill('#paste-link', 'https://x.supabase.co/auth/v1/verify?token=used123&type=magiclink');
await page.waitForTimeout(250);
await page.click('button:has-text("Sign me in")');
await page.waitForTimeout(500);
const expired = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent?.trim());
console.log('used link ->', JSON.stringify(expired));

// 3. A good link -> accepted, field clears, disclosure closes.
await page.fill('#paste-link', 'https://x.supabase.co/auth/v1/verify?token=good456&type=magiclink');
await page.waitForTimeout(250);
await page.click('button:has-text("Sign me in")');
await page.waitForTimeout(800);
const ok = await page.evaluate(() => ({
  fieldGone: !document.querySelector('#paste-link'),
  noAlert: !document.querySelector('[role="alert"]'),
  calls: window.__calls,
}));
console.log('good link ->', JSON.stringify(ok));

await page.screenshot({ path: '/tmp/rescue.png' });
await browser.close();

const pass = sent.checkEmail && sent.hasDisclosure && sent.pasteFieldHidden
  && opened.pasteFieldShown && opened.buttonDisabledWhenEmpty === true
  && /doesn’t look like a sign-in link/.test(bad || '')
  && /already been used or has expired/.test(expired || '')
  && ok.fieldGone && ok.noAlert
  && ok.calls.filter(c => c[0] === 'complete').length === 3
  && errors.length === 0;
console.log('\nerrors:', errors.length ? errors : 'none');
console.log(pass ? 'RESCUE: PASS' : 'RESCUE: FAIL');
process.exit(pass ? 0 : 1);
