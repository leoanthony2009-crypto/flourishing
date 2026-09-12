// "More help" is where a principal goes when the default idea was not enough. Everything it
// offers must be traceable: the practical content to the research it came from, and the one
// external AI to the fact that it is outside all of it.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_/.test(m.text())) errors.push(m.text()); });
// Neither external destination should ever be fetched by the test.
await page.route('**://chatgpt.com/**', r => r.abort());
await page.route('**://bloomtt.netlify.app/**', r => r.abort());

await page.addInitScript(() => {
  let real;
  Object.defineProperty(window, 'BloomAPI', { configurable:true, get(){return real;}, set(v){ real=v;
    v.getSession = async () => ({ user:{id:'u-1'} }); v.onAuthChange = () => {};
    v.loadProfile = async () => ({ profile:{ user_id:'u-1', email:'h@x.tt', school_id:'s1', role:'principal' } });
    v.listSchools = async () => ([{id:'s1',name:'Bloom Academy, Port of Spain',short_name:'Port of Spain'}]);
    v.listPerks = async () => ([]); v.myPulse = async () => null; v.myPulseHistory = async () => ([]);
    v.networkPulse = async (w) => ({week_start:w,included:3,schools_total:5,min_cell:2,excludes_self:true,
      current:[{topic:'teaching',count:2}],previous:[],four_weeks:[],suppressed:1});
    v.listLedger = async () => ([]); v.listRedemptions = async () => ([]);
    v.listShared = async () => ([]); v.listRequests = async () => ([]);
    v.upsertPulse = async () => ({}); v.insertRequest = async () => ({}); v.addShared = async () => ({});
    v.tailor = async () => ({status:'error',reason:'not_configured'});
  }});
});
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil:'networkidle', timeout:60000 });
await page.waitForTimeout(2500);
await page.click('button:has-text("Teaching & learning")');
await page.click('button:has-text("A lot")');
await page.waitForTimeout(300);
await page.click('button:has-text("Submit pulse")');
await page.waitForTimeout(1200);
await page.click('button:has-text("See my support")');
await page.waitForTimeout(1000);

// The three sheets whose content is derived from the evidence base must show it.
const GROUNDED = [
  ['I need a resource',        'resource'],
  ['Give me a practical tool', 'tool'],
  ['Show me another idea',     'idea'],
];
const rows = [];
for (const [label, id] of GROUNDED) {
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const t = d ? d.innerText : '';
    return {
      opens: !!d,
      showsWhy: /Why this works:/.test(t),
      // A citation a reader could actually check: named authors and a year.
      citesSource: /Source:/.test(t) && /\b(19|20)\d{2}\b/.test(t),
      sourceText: (t.match(/Source:[^\n]*/) || [''])[0].slice(0, 70),
    };
  });
  rows.push({ sheet: id, ...r });
  await page.click('button[aria-label="Close"]');
  await page.waitForTimeout(350);
}

// The peer sheet is colleague practice, not research; it must say what it is instead.
await page.click('button:has-text("How are other Bloom schools tackling this?")');
await page.waitForTimeout(600);
const peer = await page.evaluate(() => {
  const t = document.querySelector('[role="dialog"]').innerText;
  return { saysAnonymised: /No school or principal is identified/.test(t),
           doesNotFakeACitation: !/Source:/.test(t) };
});
await page.click('button[aria-label="Close"]');
await page.waitForTimeout(350);

// The external AI: reachable, but honest about being outside the guardrails.
const poui = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find(x => /POUI/i.test(x.textContent));
  const near = a ? (a.parentElement.innerText || '') : '';
  return {
    present: !!a,
    href: a && a.getAttribute('href'),
    rel: a && a.getAttribute('rel'),
    target: a && a.getAttribute('target'),
    saysOutsideEvidence: /outside Bloom.s evidence base/i.test(near),
    saysCannotSeePulse: /cannot see your pulse/i.test(near),
    warnsDataLeaves: /leaves Bloom/i.test(near),
    routesSafeguarding: /child-protection/i.test(near),
  };
});

await page.screenshot({ path: '/tmp/more-help.png', fullPage: true });
await browser.close();

console.table(rows);
console.log('peer sheet :', JSON.stringify(peer));
console.log('POUI entry :', JSON.stringify(poui, null, 1));

const checks = {
  everyGroundedSheetOpens:  rows.every(r => r.opens),
  everyGroundedSheetCites:  rows.every(r => r.showsWhy && r.citesSource),
  peerSaysItIsAnonymised:   peer.saysAnonymised,
  peerDoesNotFakeACitation: peer.doesNotFakeACitation,
  externalAiPresent:        poui.present && poui.href.includes('chatgpt.com'),
  externalAiSafeAttrs:      poui.target === '_blank' && /noopener/.test(poui.rel || '') && /noreferrer/.test(poui.rel || ''),
  externalAiDeclaresLimits: poui.saysOutsideEvidence && poui.saysCannotSeePulse
                            && poui.warnsDataLeaves && poui.routesSafeguarding,
  noPageErrors:             errors.length === 0,
};
console.log('\n' + JSON.stringify(checks, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? 'failed: ' + failed.join(', ') : 'More help is traceable end to end');
console.log(failed.length ? 'MORE HELP: FAIL' : 'MORE HELP: PASS');
process.exit(failed.length ? 1 : 0);
