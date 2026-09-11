import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });

const errors = [], logs = [], requests = [];
page.on('console', m => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', r => requests.push(`FAILED ${r.url()} — ${r.failure()?.errorText}`));
page.on('request', r => { const u = r.url(); if (!u.startsWith('http://127.0.0.1') && !u.startsWith('data:') && !u.startsWith('blob:')) requests.push('EXTERNAL ' + u); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3500);

const probe = await page.evaluate(() => ({
  supabaseLib: typeof window.supabase?.createClient,
  bloomApi: typeof window.BloomAPI?.sendMagicLink,
  configured: window.BloomAPI?.configured?.(),
  clientReady: !!window.BloomAPI?.client?.(),
  emailInput: !!document.querySelector('#signin-email'),
  heading: document.querySelector('h1')?.textContent?.trim(),
  buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 8),
  schoolPickerGone: !document.body.innerText.includes('Bloom Academy, Port of Spain'),
  bodyLen: document.body.innerText.length,
}));

console.log('--- probe ---');
console.log(JSON.stringify(probe, null, 2));
console.log('--- console errors (' + errors.length + ') ---');
errors.slice(0, 15).forEach(e => console.log('  ' + e));
console.log('--- notable requests (' + requests.length + ') ---');
requests.slice(0, 15).forEach(r => console.log('  ' + r));

await page.screenshot({ path: '/tmp/claude-0/-home-user-flourishing/27806993-06db-50c8-a90d-1e029668c165/scratchpad/signin.png' });
await browser.close();

const ok = probe.supabaseLib === 'function' && probe.bloomApi === 'function' && probe.configured
  && probe.emailInput && probe.schoolPickerGone && errors.length === 0;
console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL');
process.exit(ok ? 0 : 1);
