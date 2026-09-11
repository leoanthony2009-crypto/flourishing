# Bloom Principal Pulse — setup and status

The app is built, wired to Supabase and verified. **Two dashboard settings are left**, both
listed under "Before the first principal signs in" — neither can be done through the tooling
available here.

## Supabase project

| | |
|---|---|
| Project | `bloom-principal-pulse` |
| Ref | `phnpteeujuaqebzteacd` |
| Region | `us-east-1` (closest to Trinidad & Tobago) |
| API URL | `https://phnpteeujuaqebzteacd.supabase.co` |
| Publishable key | `sb_publishable_SzTl41P5xSLODN4juR-Hwg_Q9BWkfS-` |

The URL and key are baked into the client. Both are safe to ship: every table is behind RLS,
and the anonymous role can read nothing at all (verified below).

### What is applied

| Step | Source | Migration |
|---|---|---|
| Schema, enums, RLS, points trigger | `schema.sql` | `bloom_schema` |
| `network_pulse()`, `current_monday()`, `award_full_network()` | `aggregate.sql` | `bloom_aggregate` |
| Function privileges and `search_path` | `harden.sql` | `bloom_function_hardening` |
| Pilot allow-list + auto-provisioning hook | `allowlist.sql` | `bloom_pilot_allowlist` |
| pg_cron jobs + retention | `jobs.sql` | `bloom_scheduled_jobs` |
| 5 schools, 3 perks (all `active = false`) | `seed.sql` | seeded |
| AI proxy | `tailor/` | deployed, `verify_jwt` |
| Perk codes | `redeem/` | deployed, `verify_jwt` |

`harden.sql`, `allowlist.sql` and `jobs.sql` are new — see each file's header for why.

### Scheduled jobs

| Job | Schedule | Does |
|---|---|---|
| `bloom-full-network-bonus` | Fri 17:00 AST (`0 21 * * 5`) | `award_full_network()` — +10 to every school when all five took part |
| `bloom-retention-purge` | 1st monthly, 03:00 UTC | pulses > 24 months, requests > 36 months, AI log > 12 months |

The Monday 06:00 invite and the urgent-request alert to the CEBM duty line still need an
email/SMS provider; see the note at the foot of `jobs.sql`.

## Client

`design/Bloom Principal Pulse.dc.html` is the source of truth. `design/supabase-api.js` is the
data layer. Styling is untouched.

Every row of the handoff's *Client integration points* table is wired:

| localStorage key | Now |
|---|---|
| `bloom-pulse-school` | magic-link session → `profiles.school_id` |
| `bloom-pulse-draft:<school>` | still localStorage (drafts are device-local by design) |
| `bloom-pulse-submissions` | `pulses` upsert + `network_pulse()` RPC |
| `bloom-pulse-requests` | `support_requests` |
| `bloom-pulse-shared` | `shared_resources` |
| `bloom-pulse-rewards` | `points_ledger` sum + `redemptions` + `/functions/v1/redeem` |
| `window.claude.complete` | `POST /functions/v1/tailor` |

### Central-team inbox

`deploy/inbox.html` is README section 6: every `support_requests` row newest first (urgent
pinned to the top) with ref, school, type, theme, impact, context and what would help, plus
controls to set `status` and claim `assigned_to`. Same magic-link sign-in; `central` and
`admin` only, and a principal who opens it is told so and sent back to the app. The CEBM,
Lifeline, Children's Authority and emergency numbers are in the footer, as in the app.

Central staff reach it from the app's Account sheet ("Open the full inbox"), which is shown
only to those two roles.

### Building

`deploy/index.html` is a single self-contained 3.2 MB file. The Claude Design bundler that
produced it is not available here, so `build.py` reproduces it: same asset manifest, same DOM
re-serialisation, with supabase-js and the data layer inlined the way lucide already was, so
the installed PWA has no third-party runtime dependency.

```
npm run check          # verify-build + staleness + static checks (run this)
npm run build          # rebuild deploy/index.html from design/
npm run verify-build   # assert the transform reproduces the originally shipped bundle
npm run check-bundle   # assert the committed bundle matches design/
npm run serve          # http://127.0.0.1:8765
npm run smoke          # headless load: no console errors, no external requests
```

Two guards make the build trustworthy. `verify-build` re-runs the transform on the pristine
design file (`build-reference.dc.html`) and compares against a pinned sha256 of the bundle as
originally shipped, so the transform is proven before it is trusted with edited source.
`check-bundle` asserts the committed bundle is what `design/` currently produces. Builds are
byte-reproducible — gzip mtimes are zeroed — so that comparison is meaningful and rebuilds
make clean diffs.

## Verified

Against temporary fixtures, all since removed — the database holds only the 5 schools, 3
inactive perks and 7 allow-list rows.

**Aggregation and privacy**
- `workload ×3, staffing ×1, behaviour ×1` → `current: [{workload,3}]`, `suppressed: 2`.
  Themes chosen by one school are never named.
- One school, one pulse → `current: []`, `suppressed: 1`, `included: 1`. The client re-adds
  the principal's own theme locally, so their chip still reads correctly.
- Four-week series zeroes sub-threshold cells: `workload [0,2,2,3]`.

**Access control**
- With 15 pulses across 5 schools, one principal's session saw 3 pulses, 1 profile, 3 ledger
  rows. Central/admin have no `select` policy on `pulses` at all.
- The `anon` role reads **zero** rows from `schools`, `perks` and `pilot_allowlist`, and is
  blocked from `network_pulse()` and `award_full_network()`.
- `award_full_network()` as a signed-in principal raises `insufficient_privilege`.
- Allow-list hook: an unlisted address is rejected and **no** `auth.users` row is created; a
  listed address is admitted and its profile appears with the right school and role.

**App**
- Points trigger: a pulse with a note gives `sum(delta) = 15`.
- Headless load of the built bundle: zero console errors, zero external network requests.
- All template bindings resolve; the logic block parses; `localStorage` is used only for
  drafts.
- Inbox, driven through its real boot/render path against a stubbed client: urgent sorts
  first, closed requests are hidden under the default filter and appear under "All", and the
  status and assign controls send `{status:'in_progress'}` and `{assigned_to:<uid>}`. Loads
  clean at 1100px and 390px with no horizontal scroll.

Not verified here: the browser's own network path to Supabase and the edge-function CORS
preflight — this sandbox blocks `*.supabase.co` and the CDNs, so neither a browser nor curl
can reach the project. Everything reachable over SQL was checked directly.

## Deliberately not built

Two items from the handoff have no implementation here, both because building them now would
mean inventing a design the spec leaves open:

- **Partner verification page** (`/verify?code=`, README §5). The spec gates the whole perks
  phase on the first partner signing, and all three `perks` rows are still `active = false`.
  It would need a public unauthenticated endpoint over `redemptions` and somewhere to keep a
  per-partner PIN — neither is in `schema.sql`. Adding a public read surface before it is
  needed is the wrong trade. When a partner signs: add `perks.verify_pin`, and serve the
  lookup from an edge function with the service role so only `used_at` and `expires_at` are
  ever exposed.

- **Outbound email and SMS** (README §3 and §6): the Monday 06:00 invite, and the immediate
  alert to the CEBM duty line when an `urgent` request arrives. Both need a Resend/Twilio
  account and keys. The cron slot and the trigger point are noted at the foot of `jobs.sql`.

## Before the first principal signs in

Two settings, both in the Supabase dashboard, both unavailable to the tooling here:

1. **`ANTHROPIC_API_KEY`** — Project Settings → Edge Functions → Secrets. Until it is set,
   `tailor` returns `{status:'error'}` on every call. The client already degrades correctly:
   it shows the evidence-based default idea with an explanation, so nothing looks broken.

2. **Auth URL configuration** — Authentication → URL Configuration. Set *Site URL* to wherever
   the app is hosted and add that origin to *Redirect URLs*. The default is
   `http://localhost:3000`, so **magic links will not work until this is changed** — the link
   in the email would send principals to localhost. The client requests
   `window.location.origin + pathname` as its redirect.

Then, to bring people on:

3. **Real addresses.** `pilot_allowlist` is seeded with placeholders
   (`principal.arima@bloom.tt` and so on). Replace them with the real ones — see the example
   at the foot of `allowlist.sql`. `leoanthony2009@gmail.com` is already listed as `admin`
   against Port of Spain, so the app is usable as soon as step 2 is done.

4. **Invite them** — Authentication → Users → Invite. The hook creates each profile
   automatically from the allow-list row; there is no second step.

5. **Custom SMTP** — the built-in mailer is rate-limited to a handful of messages an hour and
   is not meant for real delivery. Needed before five principals rely on a Monday email.

6. **Perks** stay in "Term 2 preview" while every row has `active = false`. Set `active = true`
   when a partner signs; no client change is needed.
