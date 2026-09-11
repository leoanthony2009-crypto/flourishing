// Drives inbox.html's real boot/render path with a stubbed Supabase client, so the card
// markup, filters and status controls are exercised without a live session.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
// This sandbox blocks fonts.googleapis.com; the page has a Georgia/serif fallback.
const IGNORE = /favicon|ERR_CONNECTION_RESET|ERR_TUNNEL|fonts\.googleapis/;
page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
page.on('requestfailed', r => { if (!/fonts\.googleapis|fonts\.gstatic/.test(r.url())) errors.push('REQFAIL ' + r.url()); });

// The page loads /supabase.js itself, which would overwrite anything set beforehand, so
// serve the stub in its place.
const STUB = `(${(() => {
  const SCHOOL = '11111111-1111-1111-1111-111111111111';
  const ROWS = [
    { id:'r1', ref:'BP-260907-101', school_id:SCHOOL, week_start:'2026-09-07', type:'advice',
      topic:'workload', impact:'a_lot', context:'Two staff out and cover is thin.',
      help:'A 20-minute call this week', status:'new', assigned_to:null,
      created_by:'u1', created_at:'2026-09-08T10:00:00Z' },
    { id:'r2', ref:'BP-260907-102', school_id:SCHOOL, week_start:'2026-09-07', type:'urgent',
      topic:'safeguarding', impact:'a_lot', context:'Need to talk to someone today.',
      help:null, status:'new', assigned_to:null, created_by:'u2', created_at:'2026-09-07T08:00:00Z' },
    { id:'r3', ref:'BP-260831-103', school_id:SCHOOL, week_start:'2026-08-31', type:'conversation',
      topic:'attendance', impact:'quite_a_bit', context:'Pattern in Form 3.', help:null,
      status:'closed', assigned_to:'me-uid', created_by:'u3', created_at:'2026-09-01T09:00:00Z' },
  ];
  const patched = [];
  window.__patched = patched;

  const result = (data) => Promise.resolve({ data, error: null });
  function table(name) {
    const api = {
      _rows: name === 'support_requests' ? ROWS
           : name === 'schools' ? [{ id:SCHOOL, name:'Bloom Academy, Arima', short_name:'Arima' }]
           : [{ user_id:'me-uid', email:'central@cebm.tt', role:'central', display_name:'CEBM' }],
      select() { return api; },
      order() { return api; },
      limit() { return result(api._rows); },
      eq() { return api; },
      maybeSingle() { return result(api._rows[0]); },
      single() { return result(api._patch ? { ...api._rows[0], ...api._patch } : api._rows[0]); },
      update(fields) { patched.push(fields); api._patch = fields; return api; },
      then(res) { return result(api._rows).then(res); },
    };
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
await page.waitForTimeout(1200);

const probe = await page.evaluate(() => ({
  inboxVisible: !document.getElementById('inbox').hidden,
  signinHidden: document.getElementById('signin').hidden,
  who: document.getElementById('who').textContent.trim(),
  count: document.getElementById('count').textContent.trim(),
  cards: document.querySelectorAll('.req').length,
  // "open" is the default filter, so the closed one is excluded
  refsShown: [...document.querySelectorAll('.ref')].map(e => e.textContent.trim()),
  urgentFirst: document.querySelector('.req')?.classList.contains('urgent'),
  statusSelects: document.querySelectorAll('select[data-status]').length,
  assignButtons: document.querySelectorAll('button[data-claim]').length,
  showsContext: document.body.innerText.includes('Two staff out and cover is thin.'),
}));
console.log('--- default (open) ---');
console.log(JSON.stringify(probe, null, 2));

// Switch to "All" and confirm the closed request appears.
await page.click('.chip[data-filter="all"]');
await page.waitForTimeout(300);
const all = await page.evaluate(() => ({
  cards: document.querySelectorAll('.req').length,
  hasClosed: document.body.innerText.includes('BP-260831-103'),
}));
console.log('--- all ---');
console.log(JSON.stringify(all));

// Change a status and confirm the update payload.
await page.selectOption('select[data-status="r1"]', 'in_progress');
await page.waitForTimeout(400);
await page.click('button[data-claim="r2"]');
await page.waitForTimeout(400);
const patched = await page.evaluate(() => window.__patched);
console.log('--- writes sent to support_requests ---');
console.log(JSON.stringify(patched));

await page.screenshot({ path: '/tmp/inbox-data.png', fullPage: true });
await browser.close();

const ok = probe.inboxVisible && probe.cards === 2 && probe.urgentFirst
  && probe.statusSelects === 2 && probe.showsContext && all.cards === 3 && all.hasClosed
  && patched.some(p => p.status === 'in_progress') && patched.some(p => p.assigned_to === 'me-uid')
  && errors.length === 0;
console.log('\nerrors:', errors.length ? errors : 'none');
console.log(ok ? 'INBOX RENDER: PASS' : 'INBOX RENDER: FAIL');
process.exit(ok ? 0 : 1);
