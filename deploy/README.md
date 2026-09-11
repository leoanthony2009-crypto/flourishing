# Bloom Principal Pulse — web build

Static, dependency-free build of the principal-facing app (demo sign-in, Steps 1–4, support sheets, PDF share, perks). No build step.

## Deploy to Vercel
1. `npm i -g vercel` (or use the Vercel dashboard → "Add New Project" → drag this folder).
2. From this folder: `vercel --prod`. Framework preset: **Other**. No build command, output directory: `.`
3. Open the URL on a phone → "Add to Home Screen" installs it as a standalone app (PWA manifest included).

## What's inside
- `index.html` — the whole app, self-contained (React runtime, Lucide icons, logo, fonts inlined).
- `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` — installable-app metadata.
- `vercel.json` — clean URLs + basic security headers.

## Behaviour
- On phones (≤520px) the app fills the screen and respects safe areas; on desktop it previews inside an iPhone frame.
- Demo sign-in: pick one of five schools; drafts and submissions are stored per school in `localStorage` (Monday week start). Switch school from the header menu to submit as another principal and watch the network view update. Schools with no real submission use seeded demo data.
- Central-team requests, shared resources and perk redemptions persist on-device; the header menu shows a demo central-team inbox and a "Reset demo data" action.
- "Tailor this idea" (AI) needs a server-side proxy in production; the static build shows the evidence-based default with an explanatory message.

## Privacy assumptions (prototype)
- No backend yet: aggregates are computed on-device from seeded data. In production, aggregation must run server-side and the client must only receive counts/trends — never other schools' raw responses.
- Notes and support requests should be stored under row-level security and excluded from analytics.
