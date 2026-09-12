// "Delete my account and data" — a store requirement (Apple 5.1.1(v), Google Play) and the
// right thing regardless. The UI half: it must be reachable, state plainly what goes and what
// stays, refuse to fire without a typed confirmation, and never fire twice.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.addInitScript(() => {
  let real;
  Object.defineProperty(window, 'BloomAPI', { configurable:true, get(){return real;}, set(v){ real=v;
    // The app reloads after a successful delete, so a window global would be wiped before the
    // assertion runs. sessionStorage survives a same-tab navigation — and must not be reset
    // by the init script running again on that reload.
    if (!sessionStorage.getItem('__deletes')) sessionStorage.setItem('__deletes', '[]');
    const deleted = () => JSON.parse(sessionStorage.getItem('__deletes') || '[]').length > 0;
    // Once the account is deleted there is no session and no profile, which is what the
    // reload must land on. A stub that keeps signing them back in would hide the bug.
    v.getSession = async () => (deleted() ? null : { user:{id:'u-1'} }); v.onAuthChange = () => {};
    v.loadProfile = async () => (deleted() ? { absent:true } : { profile:{ user_id:'u-1', email:'h@x.tt', school_id:'s1', role:'principal' } });
    v.listSchools = async () => ([{id:'s1',name:'Bloom Academy, Port of Spain',short_name:'Port of Spain'}]);
    v.listPerks = async () => ([]); v.myPulse = async () => null; v.myPulseHistory = async () => ([]);
    v.networkPulse = async (w) => ({week_start:w,included:0,schools_total:5,excludes_self:true,current:[],previous:[],four_weeks:[],suppressed:0});
    v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
    v.listShared = async () => ([]); v.listRequests = async () => ([]);
    v.deleteAccount = async (word) => {
      const seen = JSON.parse(sessionStorage.getItem('__deletes') || '[]');
      seen.push(word);
      sessionStorage.setItem('__deletes', JSON.stringify(seen));
      await new Promise(r => setTimeout(r, 600));
      return { status:'ok' };
    };
  }});
});
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil:'networkidle', timeout:60000 });
await page.waitForTimeout(2500);
await page.evaluate(() => [...document.querySelectorAll('button')]
  .find(b => /account/i.test(b.getAttribute('aria-label')||''))?.click());
await page.waitForTimeout(700);

const entry = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  const b = [...d.querySelectorAll('button')].find(x => /Delete my account/i.test(x.textContent));
  return { reachable: !!b, hiddenUntilOpened: !d.querySelector('#del-word'),
           height: b ? Math.round(b.getBoundingClientRect().height) : 0 };
});

await page.evaluate(() => [...document.querySelectorAll('button')]
  .find(x => /Delete my account/i.test(x.textContent)).click());
await page.waitForTimeout(500);

const opened = await page.evaluate(() => {
  const t = document.querySelector('[role="dialog"]').innerText;
  const btn = [...document.querySelectorAll('button')].find(x => /Delete everything/i.test(x.textContent));
  return {
    fieldShown: !!document.querySelector('#del-word'),
    // A principal must be able to see what survives before they decide.
    saysWhatGoes: /your sign-in, your profile, every note/i.test(t),
    saysWhatStays: /Kept:/i.test(t) && /earlier weeks/i.test(t),
    saysIrreversible: /cannot be undone/i.test(t),
    saysThisWeekWithdrawn: /withdrawn/i.test(t),
    disabledBeforeTyping: btn ? btn.disabled : null,
  };
});

// Wrong word must not arm it.
await page.fill('#del-word', 'delete please');
await page.waitForTimeout(250);
const wrongWord = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Delete everything/i.test(x.textContent));
  return { stillDisabled: b.disabled, calls: JSON.parse(sessionStorage.getItem('__deletes') || '[]').length };
});

// Right word, typed lower case — the check is case-insensitive but exact in substance.
await page.fill('#del-word', 'delete');
await page.waitForTimeout(250);
const armed = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Delete everything/i.test(x.textContent));
  return { enabled: !b.disabled };
});

// Five rapid taps: exactly one delete.
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Delete everything/i.test(x.textContent));
  for (let i = 0; i < 5; i++) b.click();
});
await page.waitForTimeout(1800);
const fired = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__deletes') || '[]'));
// And the app must have taken them away from the signed-in view.
const afterDelete = await page.evaluate(() => ({
  backToSignIn: !!document.querySelector('#signin-email'),
  draftGone: !Object.keys(localStorage).some(k => k.startsWith('bloom-pulse-draft:')),
}));
console.log('after  :', JSON.stringify(afterDelete));

await browser.close();

console.log('entry  :', JSON.stringify(entry));
console.log('opened :', JSON.stringify(opened, null, 1));
console.log('guards :', JSON.stringify({ wrongWord, armed, fired }));

const checks = {
  reachableInAccountSheet: entry.reachable,
  collapsedByDefault:      entry.hiddenUntilOpened,
  tapTarget44:             entry.height >= 44,
  statesWhatIsDeleted:     opened.saysWhatGoes,
  statesWhatIsKept:        opened.saysWhatStays,
  statesIrreversible:      opened.saysIrreversible,
  statesWeekWithdrawn:     opened.saysThisWeekWithdrawn,
  disabledUntilConfirmed:  opened.disabledBeforeTyping === true && wrongWord.stillDisabled === true,
  wrongWordNeverFires:     wrongWord.calls === 0,
  armsOnTheRightWord:      armed.enabled,
  firesExactlyOnce:        fired.length === 1,
  sendsTheTypedWord:       fired[0] && fired[0].toUpperCase() === 'DELETE',
  returnsToSignIn:         afterDelete.backToSignIn,
  clearsLocalDraft:        afterDelete.draftGone,
  noPageErrors:            errors.length === 0,
};
console.log('\n' + JSON.stringify(checks, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? 'failed: ' + failed.join(', ') : 'deletion is deliberate, honest and single-shot');
console.log(failed.length ? 'DELETE ACCOUNT: FAIL' : 'DELETE ACCOUNT: PASS');
process.exit(failed.length ? 1 : 0);
