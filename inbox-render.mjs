// Drives inbox.html's real boot/render/patch path against a stubbed Supabase client, so the
// card markup, sorting, filters and the save/rollback behaviour are exercised for real.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// This sandbox blocks fonts.googleapis.com; the page has a Georgia/serif fallback.
const IGNORE = /favicon|ERR_CONNECTION_RESET|ERR_TUNNEL|fonts\.googleapis/;
page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
page.on('requestfailed', r => { if (!/fonts\.googleapis|fonts\.gstatic/.test(r.url())) errors.push('REQFAIL ' + r.url()); });

// The page loads /supabase.js itself, so the stub is served in its place.
const STUB = `(${(() => {
  const SCHOOL = '11111111-1111-1111-1111-111111111111';
  const ROWS = [
    { id:'r1', ref:'BP-260907-101', school_id:SCHOOL, week_start:'2026-09-07', type:'advice',
      topic:'workload', impact:'a_lot', context:'Two staff out and cover is thin.',
      help:'A 20-minute call this week', status:'new', assigned_to:null, created_at:'2026-09-08T10:00:00Z' },
    { id:'r2', ref:'BP-260907-102', school_id:SCHOOL, week_start:'2026-09-07', type:'urgent',
      topic:'safeguarding', impact:'a_lot', context:'Need to talk to someone today.',
      help:null, status:'new', assigned_to:null, created_at:'2026-09-07T08:00:00Z' },
    { id:'r3', ref:'BP-260831-103', school_id:SCHOOL, week_start:'2026-08-31', type:'conversation',
      topic:'attendance', impact:'quite_a_bit', context:'Pattern in Form 3.', help:null,
      status:'closed', assigned_to:'me-uid', created_at:'2026-09-01T09:00:00Z' },
  ];
  window.__patched = [];
  window.__failNextUpdate = false;

  const result = (data, error = null) => Promise.resolve({ data, error });

  function table(name) {
    const st = { name, filters: [], update: null };
    const api = {
      select() { return api; },
      order()  { return api; },
      eq(col, val)  { st.filters.push(['eq', col, val]);  return api; },
      neq(col, val) { st.filters.push(['neq', col, val]); return api; },
      limit()  { return result(rows()); },
      maybeSingle() { return result(rows()[0] || null); },
      single() {
        if (st.update) {
          if (window.__failNextUpdate) {
            window.__failNextUpdate = false;
            return result(null, { message: 'new row violates row-level security policy' });
          }
          const id = (st.filters.find(f => f[1] === 'id') || [])[2];
          const row = ROWS.find(r => r.id === id);
          Object.assign(row, st.update);
          window.__patched.push({ id, ...st.update });
          return result({ ...row });
        }
        return result(rows()[0] || null);
      },
      update(fields) { st.update = fields; return api; },
      then(res) { return result(rows()).then(res); },
    };
    function rows() {
      if (name === 'schools')  return [{ id:SCHOOL, name:'Bloom Academy, Arima', short_name:'Arima' }];
      if (name === 'profiles') return [{ user_id:'me-uid', email:'central@cebm.tt', role:'central', display_name:'CEBM' }];
      return ROWS.filter(r => st.filters.every(([op, col, val]) =>
        op === 'eq' ? r[col] === val : r[col] !== val));
    }
    return api;
  }

  window.supabase = {
    createClient: () => ({
      from: table,
      auth: {
        getSession: () => result({ session: { user: { id:'me-uid' } } }),
        onAuthStateChange: () => {},
        signOut: () => result(null),
        signInWithOtp: () => result(null),
      },
    }),
  };
}).toString()})()`;

await page.route('**/supabase.js', route =>
  route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));

await page.goto('http://127.0.0.1:8765/inbox.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);

const probe = await page.evaluate(() => ({
  inboxVisible: !document.getElementById('inbox').hidden,
  who: document.getElementById('who').textContent.trim(),
  count: document.getElementById('count').textContent.trim(),
  cards: document.querySelectorAll('.req').length,
  urgentFirst: document.querySelector('.req')?.classList.contains('urgent'),
  showsContext: document.body.innerText.includes('Two staff out and cover is thin.'),
  ownerShown: document.body.innerText.includes('Unassigned'),
  // every control must be distinguishable to a screen reader
  distinctSelectNames: new Set([...document.querySelectorAll('select[data-status]')]
    .map(e => e.getAttribute('aria-label'))).size,
  liveRegions: document.querySelectorAll('[aria-live]').length,
}));
console.log('--- default (open) ---');
console.log(JSON.stringify(probe, null, 2));

await page.click('.chip[data-filter="all"]');
await page.waitForTimeout(250);
const all = await page.evaluate(() => ({
  cards: document.querySelectorAll('.req').length,
  hasClosed: document.body.innerText.includes('BP-260831-103'),
}));
console.log('--- all ---', JSON.stringify(all));

// A successful status change.
await page.selectOption('select[data-status="r1"]', 'in_progress');
await page.waitForTimeout(400);
const ok = await page.evaluate(() => ({
  value: document.querySelector('select[data-status="r1"]').value,
  msg: document.getElementById('msg-r1').textContent.trim(),
}));
console.log('--- status change succeeds ---', JSON.stringify(ok));

// A rejected status change must roll the control back, not leave a state that was never saved.
await page.evaluate(() => { window.__failNextUpdate = true; });
await page.selectOption('select[data-status="r1"]', 'closed');
await page.waitForTimeout(500);
const rejected = await page.evaluate(() => ({
  value: document.querySelector('select[data-status="r1"]').value,
  msg: document.getElementById('msg-r1').textContent.trim(),
}));
console.log('--- status change REJECTED ---', JSON.stringify(rejected));

// Claim, and confirm focus is not thrown away by a full re-render.
await page.focus('select[data-status="r2"]');
await page.click('button[data-claim="r2"]');
await page.waitForTimeout(400);
const claimed = await page.evaluate(() => ({
  label: document.querySelector('button[data-claim="r2"]').textContent.trim(),
  focusKept: document.activeElement.tagName !== 'BODY',
  patched: window.__patched,
}));
console.log('--- claim ---', JSON.stringify(claimed));

await page.screenshot({ path: '/tmp/inbox-data.png', fullPage: true });
await browser.close();

const pass = probe.inboxVisible && probe.cards === 2 && probe.urgentFirst && probe.showsContext
  && probe.ownerShown && probe.distinctSelectNames === 2 && probe.liveRegions >= 2
  && all.cards === 3 && all.hasClosed
  && ok.value === 'in_progress' && ok.msg === 'Saved'
  && rejected.value === 'in_progress' && /Not saved/.test(rejected.msg)   // rolled back
  && claimed.label === 'Assigned to you' && claimed.focusKept
  && claimed.patched.some(p => p.status === 'in_progress')
  && claimed.patched.some(p => p.assigned_to === 'me-uid')
  && errors.length === 0;
console.log('\nerrors:', errors.length ? errors : 'none');
console.log(pass ? 'INBOX RENDER: PASS' : 'INBOX RENDER: FAIL');
process.exit(pass ? 0 : 1);
