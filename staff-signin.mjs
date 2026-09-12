// The central team needs into the app without waiting on a rate-limited mailer. That route
// must not be visible to principals, and it must be an ordinary session — not a way around
// anything. Only BloomAPI's network call is stubbed; the gate, state and template are real.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8765/index.html';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = [];

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    let real;
    Object.defineProperty(window, 'BloomAPI', {
      configurable: true,
      get() { return real; },
      set(v) {
        real = v;
        window.__pw = [];
        v.getSession = async () => null;
        v.onAuthChange = () => {};
        v.signInWithPassword = async (email, password) => {
          window.__pw.push([email, password]);
          if (password !== 'right-password') { const e = new Error('Invalid login credentials'); throw e; }
          return { session: {} };
        };
      },
    });
  });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2200);
  return page;
}

// 1. A principal opening the app normally must never see it.
const plain = await open(BASE);
const hiddenByDefault = await plain.evaluate(() => ({
  noField: !document.querySelector('#signin-password'),
  // Not the bare word "password" — the normal screen already promises there is "no password
  // to remember". What must be absent is the staff block itself.
  noStaffBlock: !/Central-team password|Principals do not have a password/i.test(document.body.innerText),
  normalSignIn: !!document.querySelector('#signin-email'),
}));
await plain.close();

// 2. ...and not for a near-miss flag either.
const nearMiss = await open(BASE + '?staff=0');
const offForOtherValues = await nearMiss.evaluate(() => !document.querySelector('#signin-password'));
await nearMiss.close();

// 3. With the flag, it appears and works.
const staff = await open(BASE + '?staff=1');
const shown = await staff.evaluate(() => ({
  field: !!document.querySelector('#signin-password'),
  isPasswordType: document.querySelector('#signin-password')?.type === 'password',
  saysWhoItIsFor: /Principals do not have a password/i.test(document.body.innerText),
  emailStillThere: !!document.querySelector('#signin-email'),
}));

// Disabled until both fields are filled.
const disabledEmpty = await staff.evaluate(() => document.evaluate(
  "//button[contains(., 'Sign in with password')]", document, null, 9, null).singleNodeValue?.disabled);

await staff.fill('#signin-email', 'leoanthony2009@gmail.com');
await staff.fill('#signin-password', 'wrong-password');
await staff.waitForTimeout(250);
await staff.click('button:has-text("Sign in with password")');
await staff.waitForTimeout(600);
const wrong = await staff.evaluate(() => ({
  alert: document.querySelector('[role="alert"]')?.textContent?.trim() || '',
  stillOnSignIn: !!document.querySelector('#signin-email'),
}));

await staff.fill('#signin-password', 'right-password');
await staff.waitForTimeout(250);
await staff.click('button:has-text("Sign in with password")');
await staff.waitForTimeout(800);
const right = await staff.evaluate(() => ({
  calls: window.__pw,
  // The password must not be left sitting in component state after it is used.
  fieldCleared: document.querySelector('#signin-password')?.value === '',
}));
await staff.close();
await browser.close();

const out = { hiddenByDefault, offForOtherValues, shown, disabledEmpty, wrong, right };
console.log(JSON.stringify(out, null, 2));

const pass = hiddenByDefault.noField && hiddenByDefault.noStaffBlock && hiddenByDefault.normalSignIn
  && offForOtherValues
  && shown.field && shown.isPasswordType && shown.saysWhoItIsFor && shown.emailStillThere
  && disabledEmpty === true
  && /don’t match an account/.test(wrong.alert) && wrong.stillOnSignIn
  && right.calls.length === 2
  && right.calls[1][0] === 'leoanthony2009@gmail.com' && right.calls[1][1] === 'right-password'
  && right.fieldCleared
  && errors.length === 0;
console.log('\nerrors:', errors.length ? errors : 'none');
console.log(pass ? 'STAFF SIGN-IN: PASS' : 'STAFF SIGN-IN: FAIL');
process.exit(pass ? 0 : 1);
