// The "the link didn't work" box installs whatever session it is handed, so it is the one
// place in the app where somebody else's link can sign a principal into somebody else's
// school. These cases run the REAL completeSignIn against the REAL configured project —
// nothing is stubbed — because a stub would only prove the stub rejects things.
import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForSelector('#signin-email', { timeout: 15000 });

const results = await page.evaluate(async () => {
  const origin = new URL(window.BLOOM_SUPABASE.url).origin;
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Shape only — the signature is never checked here, and the server would reject it anyway.
  const tok = (iss) => `${b64({ alg: 'HS256' })}.${b64({ iss, sub: 'u', role: 'authenticated' })}.sig`;

  const cases = [
    ['plain rubbish',            'hello'],
    ['token link, wrong host',   'https://evil.example/auth/v1/verify?token=abc&type=magiclink'],
    ['token link, lookalike',    `https://phnpteeujuaqebzteacd.supabase.co.evil.example/auth/v1/verify?token=abc&type=magiclink`],
    ['token link, real project', `${origin}/auth/v1/verify?token=abc&type=magiclink`],
    ['session from elsewhere',   `https://localhost:3000/#access_token=${tok('https://attacker.supabase.co/auth/v1')}&refresh_token=r`],
    ['session, no issuer',       `https://localhost:3000/#access_token=${tok('')}&refresh_token=r`],
    ['session, junk token',      'https://localhost:3000/#access_token=notajwt&refresh_token=r'],
    ['session, prefix trick',    `https://localhost:3000/#access_token=${tok(origin + '.evil.example/auth/v1')}&refresh_token=r`],
    ['session, real project',    `https://localhost:3000/#access_token=${tok(origin + '/auth/v1')}&refresh_token=r`],
    // What people can actually paste. None of these are bad links.
    ['link wrapped in <>',       `<${origin}/auth/v1/verify?token=abc&type=signup>`],
    ['link broken by a newline', `${origin}/auth/v1/verify?token=abc\n&type=signup`],
    ['address bar, no scheme',   `localhost:3000/#access_token=${tok(origin + '/auth/v1')}&refresh_token=r`],
    ['fragment on its own',      `#access_token=${tok(origin + '/auth/v1')}&refresh_token=r`],
    ['fragment, no hash',        `access_token=${tok(origin + '/auth/v1')}&refresh_token=r`],
    // ...and the gate must not go soft just because the scheme is missing.
    ['no scheme, wrong host',    'evil.example/auth/v1/verify?token=abc&type=magiclink'],
    ['no scheme, foreign token', `localhost:3000/#access_token=${tok('https://attacker.supabase.co/auth/v1')}&refresh_token=r`],
  ];

  const out = [];
  for (const [name, input] of cases) {
    let err = null;
    try { await window.BloomAPI.completeSignIn(input); } catch (e) { err = (e && e.message) || String(e); }
    out.push({ name, error: err });
  }
  return out;
});

await browser.close();
console.table(results);

const by = (n) => results.find(r => r.name === n).error;
const checks = {
  // Rejected before any network call, by the origin/issuer gate.
  rubbishRejected:        by('plain rubbish') === 'bad_link',
  wrongHostRejected:      by('token link, wrong host') === 'foreign_link',
  lookalikeHostRejected:  by('token link, lookalike') === 'foreign_link',
  foreignSessionRejected: by('session from elsewhere') === 'foreign_link',
  issuerlessRejected:     by('session, no issuer') === 'foreign_link',
  junkTokenRejected:      by('session, junk token') === 'foreign_link',
  // The issuer test must compare a whole origin, not a string prefix.
  prefixTrickRejected:    by('session, prefix trick') === 'foreign_link',
  // These two get past the gate and are then refused by Supabase itself, which is the point:
  // the gate must not be what decides a genuine link is valid.
  realProjectLinkPasses:  by('token link, real project') !== 'foreign_link' && by('token link, real project') !== null,
  realSessionPasses:      by('session, real project') !== 'foreign_link' && by('session, real project') !== null,
  // Accepted: normalised, then judged on the token, not on how tidily it was copied.
  angleBracketsAccepted:  by('link wrapped in <>') !== 'bad_link' && by('link wrapped in <>') !== 'foreign_link',
  newlineAccepted:        by('link broken by a newline') !== 'bad_link' && by('link broken by a newline') !== 'foreign_link',
  schemelessAccepted:     by('address bar, no scheme') !== 'bad_link' && by('address bar, no scheme') !== 'foreign_link',
  bareFragmentAccepted:   by('fragment on its own') !== 'bad_link' && by('fragment on its own') !== 'foreign_link',
  hashlessAccepted:       by('fragment, no hash') !== 'bad_link' && by('fragment, no hash') !== 'foreign_link',
  // Rejected all the same.
  schemelessEvilRejected: by('no scheme, wrong host') === 'foreign_link',
  schemelessForeignToken: by('no scheme, foreign token') === 'foreign_link',
};
console.log(JSON.stringify(checks, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? '\nLINK SAFETY: PASS' : '\nLINK SAFETY: FAIL');
process.exit(pass ? 0 : 1);
