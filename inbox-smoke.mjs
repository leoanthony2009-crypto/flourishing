import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const vp of [{ width: 1100, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_TUNNEL|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://127.0.0.1:8765/inbox.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const probe = await page.evaluate(() => ({
    supabaseLoaded: typeof window.supabase?.createClient,
    signinVisible: !document.getElementById('signin').hidden,
    inboxHidden: document.getElementById('inbox').hidden,
    sendDisabled: document.getElementById('send').disabled,
    footerHasCEBM: document.body.innerText.includes('+1 868-607-2326'),
    footerHasLifeline: document.body.innerText.includes('(800) 5588'),
    footerHasAuthority: document.body.innerText.includes('996'),
    noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
  }));
  console.log(vp.name, JSON.stringify(probe));
  console.log(vp.name, 'errors:', errors.length ? errors : 'none');
  await page.screenshot({ path: `/tmp/inbox-${vp.name}.png`, fullPage: true });
  await page.close();
}
await browser.close();
