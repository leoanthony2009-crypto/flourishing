# Bloom Principal Pulse — web build

Static build of the app. No build step at deploy time: everything here is ready to serve.

Do not edit these files by hand. `index.html` is generated from `design/` by `build.py` at the
repository root — run `npm run build`, and `npm run check` to confirm it is in sync.

## Deploy to Vercel

1. `npm i -g vercel` (or the dashboard → "Add New Project" → drag this folder).
2. From this folder: `vercel --prod`. Framework preset **Other**, no build command,
   output directory `.`.
3. Open the URL on a phone → "Add to Home Screen" installs it as a standalone app.

Live at **https://flourishing-sage.vercel.app** (`/inbox` for the central team).

Hand out that URL, not the `…-wendell-s-projects-….vercel.app` or `…-git-main-….vercel.app`
ones — Vercel Authentication gates those by default, so they ask for a Vercel login. The
canonical production domain is exempt and public.

One setting still worth doing: Supabase → Authentication → **URL Configuration** → set
*Site URL* and *Redirect URLs* to `https://flourishing-sage.vercel.app`. Magic links point at
`http://localhost:3000` until you do — the sign-in screen's "The link didn't work" fallback
covers it meanwhile, but setting it means nobody has to paste anything. See `SETUP.md`.

## What's inside

| File | |
|---|---|
| `index.html` | the principal app, self-contained — React, Lucide, supabase-js, fonts, logos and the data layer are all inlined |
| `inbox.html` | the central-team inbox: every support request, newest first, with status and assignment |
| `supabase.js` | supabase-js UMD, used by `inbox.html` (the app has its own copy inlined) |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png`, `favicon.ico` | installable-app metadata |
| `vercel.json` | clean URLs and basic security headers |

`index.html` makes no third-party network requests at all — it talks only to the Supabase
project. `inbox.html` additionally pulls Source Serif 4 from Google Fonts, and falls back to
Georgia if that is unavailable.

## Behaviour

- Sign-in is a Supabase magic link, restricted to addresses on `pilot_allowlist`. There is no
  demo mode and no school picker: the school comes from the signed-in profile.
- On phones (≤520px) the app fills the screen and respects safe areas; on desktop it previews
  inside an iPhone frame.
- Step 2 is drawn entirely from the `network_pulse()` RPC, which applies a minimum-cell rule of
  2 server-side. A theme only one school picked is never named to the client.
- Drafts stay in `localStorage` — they are device-local by design. Everything else is in
  Postgres under row-level security.
- "Tailor this idea" calls the `tailor` edge function. Without `ANTHROPIC_API_KEY` set it
  returns an error and the app shows the evidence-based default idea instead.
- `inbox.html` is for `central` and `admin` profiles. Principals who open it are told so and
  sent back to the app.

## Privacy

- Principals' pulse notes are visible only to the submitting school. Central staff never see
  them — the only note-like text they see is the `context` a principal chose to attach to a
  support request.
- Aggregation runs server-side; the client only ever receives counts.
- The app is not a safeguarding reporting route. Every urgent surface, and the inbox footer,
  repeats CEBM +1 868-607-2326, Lifeline (800) 5588, Children's Authority 996 and
  emergency 999.
