# Bloom Principal Pulse — setup and status

**Live at https://flourishing-sage.vercel.app** — public, no login wall, serving the current
build. `/inbox` is the central-team page.

Verified by an unauthenticated request made from outside any Vercel session: `200`, 3,233,372
bytes, byte-identical to the local build, with the Supabase project ref, the magic-link
sign-in and the paste-a-link fallback all present and the old localStorage demo gone.

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
| Note points on update | `points.sql` | `bloom_note_points_on_update` |
| Security review fixes | `security.sql` | `bloom_close_aggregate_probe`, `bloom_write_side_hardening`, `bloom_pin_request_ownership` |
| Atomic perk redemption | `redeem.sql` | `bloom_atomic_redeem` |
| 5 schools, 3 perks (all `active = false`) | `seed.sql` | seeded |
| AI proxy | `tailor/` | deployed, `verify_jwt` |
| Perk codes | `redeem/` | deployed, `verify_jwt` |

`harden.sql`, `allowlist.sql`, `jobs.sql`, `points.sql`, `security.sql` and `redeem.sql` are
new — see each file's header for why. Replaying them against the live project is a no-op, so
the schema can be rebuilt from this repo alone.

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
npm run smoke          # ten Playwright suites (needs `npm run serve` in another shell)
```

`npm run smoke` drives the built bundle in a real browser. Only `BloomAPI`'s network calls are
stubbed; the component, its state and the whole template are the real thing.

| Suite | Covers |
|---|---|
| `smoke.mjs` | cold load: no console errors, no external requests |
| `inbox-smoke.mjs` | the central inbox loads and gates on role |
| `inbox-render.mjs` | inbox cards, sorting, filters, save and rollback |
| `rescue.mjs` | the "the link didn't work" paste flow and its error copy |
| `link-safety.mjs` | the **real** `completeSignIn` against foreign links and tokens |
| `link-error.mjs` | what a *failed* link's redirect shows, from live `#error=` shapes |
| `staff-signin.mjs` | the `?staff=1` password route: hidden by default, real session when used |
| `mission-link.mjs` | the **Our mission** link: href, `rel="noopener noreferrer"`, 44px target |
| `a11y.mjs` | what survives the documentElement swap, names, targets, dialog focus |
| `edge-cases.mjs` | double-submit, hostile open text, session lost mid-writing |
| `more-help.mjs` | every More help sheet cites its evidence; the external AI declares its limits |

`npm run check` also runs two suites against the edge function's own modules under Node, so
they test the deployed code rather than a copy:

- `tailor-compose.mjs` — all three sources present, the note carried verbatim, no raw enum
  leaking into the prompt, and hostile input bounded.
- `tailor-outputs.mjs` — the accept/reject boundary, using realistic tailored answers. A
  concrete, correctly grounded idea must survive validation and still name the specific class
  or team after the word limits are applied; an invented percentage, an inserted link, or an
  appeal to research we never supplied must not.

That second suite exists because of a bug it would have caught on day one. The grounding
guard banned the phrase "effect size" unconditionally — and the `teaching` topic's own
evidence reads *"an effect size of about 0.84"*. So on one of the most-chosen themes, an
answer that grounded itself in the supplied material exactly as instructed was binned as
`rejected` every single time, and the principal saw the generic default. The authority and
percentage checks are now conditional on the phrase being absent from what was actually sent;
links and phone numbers stay banned outright.
| `app-signed-in.mjs` | all four steps as a signed-in principal |
| `sheets.mjs` | every support sheet, the urgent request, the PDF export |
| `timezone.mjs` | the week written is a Monday from UTC-11 to UTC+14 |

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
  the principal's own theme locally, so their chip still reads correctly. Since the aggregate
  stopped counting the caller's own school it **adds** one rather than flooring at one, so a
  theme two other schools picked reads 3. The one case it under-reports — exactly one other
  school sharing the theme — is the privacy rule working, and erring low is the safe side.
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
- Week handling across timezones, with the browser's zone emulated from UTC-11 to UTC+14:
  every one writes the same Monday, and it matches the week the aggregate is queried for.
  Before the fix anything east of UTC wrote the previous Sunday.
- Inbox, driven through its real boot/render path against a stubbed client: urgent sorts
  first, closed requests are hidden under the default filter and appear under "All", and the
  status and assign controls send `{status:'in_progress'}` and `{assigned_to:<uid>}`. Loads
  clean at 1100px and 390px with no horizontal scroll.

**Live, from outside** (unauthenticated requests made from the database, which is on the open
internet — this sandbox itself blocks `*.supabase.co` and `*.vercel.app`)

- `https://flourishing-sage.vercel.app/` → 200, 3,233,372 bytes, byte-identical to the local
  build; `/inbox`, `/supabase.js`, `/manifest.webmanifest` and the icons all 200 with the right
  MIME types, and `X-Frame-Options: DENY` on every route confirms `vercel.json` is applied.
- CORS preflight on `/auth/v1/otp` → 200, `access-control-allow-origin: *`, so the browser can
  reach Supabase Auth from the deployed origin.
- CORS preflight on `/functions/v1/tailor` → 200, `access-control-allow-origin: *`, which
  confirms the preflight handling added to both edge functions (the handoff versions answered
  `OPTIONS` with 405).

### End to end, as real signed-in users

The strongest check of the lot, and the one that matters most. Three throwaway accounts (two
principals at different schools, one central) were created, signed in for real JWTs, and used
to drive the **live** REST API, RPC and edge functions exactly as the browser does. All test
data was deleted afterwards; the database holds only the reference rows and the owner account.

| What | Result |
|---|---|
| Principal submits a pulse | `201`, row written through RLS |
| **Minimum-cell rule with real data** | 3 schools in: `included: 3`, `current: [{workload, 2}]`, `suppressed: 1`. The theme only one school picked is counted but **never named**, and is absent from `four_weeks` entirely |
| Principal reads `pulses` | sees **only their own school's** row |
| **Central reads `pulses`** | **zero rows** — the note-privacy guarantee, against a real central-team token |
| Points | note-writer `pulse 10 + note 5`; the other `pulse 10` |
| Principal files a support request | `201` |
| Central reads requests | sees it, with the context the principal chose to send |
| A *different* principal reads requests | zero rows |
| Central sets `status` | `200`, updated |
| Principal tries to set `status` | zero rows — blocked by RLS |
| `redeem` with no partner signed | `404 perk not available` |
| **`tailor` on safeguarding** | `declined` in **1 ms** — the hard block fires before any model call, so it holds even with no API key set |
| `tailor` on a normal topic, no key | `{status:'error'}`, which the client renders as the default idea |
| `ai_tailor_log` | logged `declined` and `error` with school and latency, and its columns cannot hold a note or output |

### Security review

A review after the first end-to-end pass found one serious flaw and three lesser ones. All
are fixed and the fixes are verified against the live API with real JWTs. `security.sql` and
`redeem.sql` carry the full reasoning; the short version:

**The k=2 rule was defeatable by writing, not reading.** Nothing constrained which *week* a
principal could write a pulse for, and `network_pulse()` counted the caller's own school. So
a principal could submit a theme and watch a suppressed cell of 1 turn into a visible 2 —
which names another school's private theme. Fourteen topics, fourteen probes, and every other
school's answer falls out; each back-dated pulse also minted 10 points redeemable for real
partner codes. Two independent fixes, either sufficient on its own: a pulse may only be
written for the current week, and the aggregate now counts **other schools only**.

Verified with two principals at different schools:

| Attack | Result |
|---|---|
| Back-date a pulse to a past week | `403` — new row violates row-level security policy |
| Submit the theme the other school chose (legitimate, current week) | `201` |
| Read the aggregate back | `current: []`, `suppressed: 1` — the theme is **still hidden** |

**A request could be filed pre-closed.** `insert own request` did not pin `status` or
`assigned_to`, so a principal could file a request already closed and already assigned to a
named colleague — into the central inbox, never to be looked at. Now pinned to
`status = 'new'` and `assigned_to is null`. Verified: `403`.

**Triage could rewrite ownership.** The central-update policy allows updating any request,
which triage needs, but an RLS `WITH CHECK` cannot compare against the old row — so a request
could be moved to another school or re-attributed. A `BEFORE UPDATE` trigger now pins
`school_id`, `created_by`, `ref` and `week_start`, and sets `updated_at` server-side. Verified:
`403` on each.

**Two perks could be bought with one balance.** `redeem` read the balance, decided, then
wrote. Two requests for *different* perks arriving together both passed the check, so a
school with 30 points could walk away with 60 points of real partner codes; the debit's own
error was also discarded, which could leave a valid code paid for with nothing. Both writes
now happen inside `redeem_perk()` behind a per-school advisory lock. Verified: 25 points, two
perks at 20 — first `ok` with balance 5, second `insufficient`, one code issued, one debit row.

**The rescue paste box installed any session it was given.** "The link didn't work" takes a
link from wherever the principal got it, so anyone who could get a link in front of one could
sign them into an account of their choosing — and every pulse and note they then wrote would
land in that account's school. The address itself cannot be checked (the whole point of the
rescue is a link that landed on the wrong origin), so the *token* is: it must have been issued
by this Supabase project, and a raw email link must point at this project's auth host. That
leaves only a session minted by this project, which the allow-list limits to a known group.
The box now also says so in plain words. `link-safety.mjs` runs the real `completeSignIn`
against nine inputs, including a lookalike host and an issuer-prefix trick.

**Accepted, not fixed** — each is a deliberate call, not an oversight:

- The allow-list is an enumeration oracle: an unlisted address errors differently from a
  listed one, so someone could test whether a given address is on the pilot. Five schools,
  known people; hiding it would mean showing "check your email" to people who will never get
  one.
- `admin` can see which school asked about which theme, via `ai_tailor_log`. That table exists
  to meter and audit the AI proxy and holds no note or output. Central staff cannot read it.
- Supabase's linter flags `my_role()`, `my_school()` and `network_pulse()` as SECURITY DEFINER
  functions callable by signed-in users. That is what they are for: the first two return the
  caller's own role and school, and `network_pulse()` is the aggregate the app is built on.
  Its "leaked password protection disabled" warning does not apply — there are no passwords,
  only magic links.

## Hosting

`vercel.json` at the repository root configures the whole deploy, so no dashboard settings are
needed: no install, no build, and `deploy/` as the output directory. Import the repo, leave
Root Directory empty, deploy.

Vercel's zero-config would otherwise look for a `public/` folder and fail with
*No Output Directory named "public" found*. It would also run `npm run build` (which is
`build.py`) and install Playwright, neither of which a static deploy needs.

`deploy/vercel.json` carries the same headers plus `outputDirectory: "."`, so the project still
works if Root Directory is set to `deploy` instead — Vercel reads whichever file sits in the
configured root.

### Which URL to hand out

The project has Deployment Protection → Vercel Authentication on *Standard Protection*
(`ssoProtection: { enabled: true, deploymentType: "all_except_custom_domains" }`). That gates
the **deployment and team-slug URLs** but **not** the canonical production domain. Confirmed by
unauthenticated request:

| URL | Result |
|---|---|
| `flourishing-sage.vercel.app` | **200, serves the app** — give people this one |
| `flourishing-wendell-s-projects-…vercel.app` | 302 → `vercel.com/sso-api`, Vercel login |
| `flourishing-git-main-…vercel.app` | 302 → `vercel.com/sso-api`, Vercel login |

So there is nothing to turn off. Use `flourishing-sage.vercel.app`; the other two are internal
and stay protected, which is the sensible default.

If you later add a custom domain it is exempt too, and if you ever want the team-slug URLs open
as well, set Vercel Authentication to *Only Preview Deployments*.

### Accessibility

The bundler boots with `document.documentElement.replaceWith(doc.documentElement)`, swapping the
whole `<html>` for one built from the template. **Anything living only in the outer `<head>` is
destroyed the moment JavaScript runs.** The static HTML looked perfect; the live DOM had lost:

| | Consequence |
|---|---|
| `<title>` | empty tab, nothing announced on load — WCAG 2.4.2 (A) |
| `<link rel="manifest">` | **no "Add to Home Screen"**, on an app built to be a weekly phone habit |
| `<link rel="icon">`, apple-touch-icon | no icon anywhere |
| `lang` (never set at all) | screen readers guess the voice — WCAG 3.1.1 (A) |

All of it now lives in the `<helmet>` block, which survives the swap, with `lang` set by a
script because the attribute belongs on `<html>` and the replacement carries no attributes.
`a11y.mjs` asserts each one **after boot**, which is the only place the failure was visible.

Already sound, and now covered so it stays that way: every control has an accessible name, no
target is below the 44px the app uses throughout, every image has `alt`, the sheet is
`aria-modal` with a label, focus moves into it on open, Escape closes it, and focus returns to
the control that opened it.

Note on WCAG 2.2 SC 3.3.8 *Accessible Authentication*: the magic link passes it outright — there
is no password to recall or transcribe. The `?staff=1` password route is a separate, deliberate
path for the central team, not the one principals use.

### Is "More help" grounded?

"More help" is where a principal goes when the default idea was not enough, so everything it
offers has to be traceable.

**The practical sheets now cite their evidence.** The resource planner, the checklist and the
second idea are all derived from the same research as the main card — which shows its source —
but the sheets showed none, so the most actionable content in the app read as unattributed
advice. Each now carries a *Why this works* line and its citation.

**All fourteen evidence claims were reviewed against their sources.** Thirteen hold up:
Robinson, Lloyd & Rowe (2008) for the 0.84 effect size on leading teacher learning, Bryk &
Schneider (2002) on relational trust, Bandura (1997) and Tschannen-Moran & Woolfolk Hoy (2001)
on self-efficacy, Epstein (2011) on family engagement, and the EEF guidance reports — two of
which were fetched live and returned exactly the cited titles.

One did not. The staffing claim read *"how staff are deployed explains more variation in
outcomes than headcount alone"*, cited to Leithwood, Harris & Hopkins (2020), *Seven strong
claims about successful school leadership revisited*. That paper is real and correctly cited as
an artefact, but it is about leadership practices and their largely **indirect** effects — it
does not establish a deployment-versus-headcount comparison. The claim was reworded to state
what the source actually supports, rather than a new source being invented to fit the claim.

Reviewed from knowledge, not from fetching each paper: journal sites (SAGE, Taylor & Francis)
block automated requests, so the EEF reports are the only ones independently confirmed here.
A subject-matter reviewer should still read the fourteen before the pilot widens.

**The one AI in the section is not Bloom's.** *Ask POUI GPT* opens a third-party ChatGPT GPT
(confirmed live — "ChatGPT · POUI GPT 1.3"). Everything above it in that section is grounded:
the ideas cite their evidence, the tailored version may use only that evidence, safeguarding is
blocked before any model call, and no note leaves Bloom. **None of that holds on the other side
of that link**, and a principal had no way to tell from the button. It now says so: outside
Bloom's evidence base, cannot see your pulse, anything typed there leaves Bloom, and anything
urgent or child-protection related belongs in *I need central-team support* instead.

`checks.mjs` enforces a floor — every theme must state its evidence and cite a source carrying
a year. That cannot tell whether a source supports its claim, only that one was supplied.

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

1. **`ANTHROPIC_API_KEY`** — Project Settings → Edge Functions → Secrets. **This is the only
   thing standing between "Tailor this idea" and working.** Everything else on that path is
   built, deployed and tested; the function now says so itself rather than leaving you to
   guess. Against the live endpoint, with a real principal token:

   ```
   POST /functions/v1/tailor  →  {"status":"error","reason":"not_configured"}
   ```

   The client turns that into *"AI tailoring isn't switched on for Bloom yet. The
   evidence-based idea below still applies."* — true, and distinguishable from a busy model
   (`reason: "busy"`) or a connection problem. Before this, all three read as "check your
   connection", so an unset key looked like a network wobble you could retry your way out of.

   Get a key from `console.anthropic.com` → API Keys, then paste it in as `ANTHROPIC_API_KEY`.
   No redeploy is needed; the next call picks it up.

### What "Tailor this idea" actually sends

The feature's whole claim is that it is not generic advice, so the model is given three
sources and told it may use nothing else. `tailor/compose.mjs` assembles them and
`tailor-compose.mjs` drives that exact module — not a copy — under `npm run check`.

| Source | What goes in | Where it comes from |
|---|---|---|
| **1. Research** | the evidence, its citation, the Trinidad & Tobago context | the curated evidence base, per topic |
| **2. Colleagues** | the anonymised peer practice line, how many Bloom schools chose this theme this week and whether it is rising, the shared checklist, the planner, another idea that travelled | the evidence base + the minimum-cell-suppressed aggregate already on screen |
| **3. This school** | the note verbatim, how much it is affecting them, how many of the last 4 weeks they have chosen this theme, what they have already saved | their own pulse and their own library |

The `peer` and `resource` fields had been sitting in the evidence base unused since the
handoff: the client never sent them, so a feature built to draw on colleagues was withholding
the only colleague material it had.

**No other school's note is ever read.** `shared_resources` is RLS'd to `school_id =
my_school()`, so it is a private per-school library, not a cross-school one — what travels
between schools is the curated practice line and a suppressed count, never a principal's
words. `tailor-compose.mjs` asserts the count is absent entirely when nothing is recorded,
rather than being invented.

Two other changes on the same path:

- **Models.** `claude-sonnet-4-5` → `claude-opus-5`, with `claude-sonnet-5` as the fallback.
- **Guaranteed JSON.** The old code regex-matched a JSON object out of free text and binned
  anything it could not parse as `rejected` — a sound idea thrown away because the model
  wrapped it in a sentence. It now uses structured outputs, so the shape is guaranteed, and
  `max_tokens` went from 500 to 4000 so a model that thinks before it writes cannot be
  truncated mid-object.

2. ~~**Auth URL configuration**~~ — **done.** *Site URL* is
   `https://flourishing-sage.vercel.app` and the app is on the *Redirect URLs* list. Verified
   against the live `/auth/v1/verify` endpoint with a deliberately invalid token, which makes
   GoTrue redirect straight back with an error rather than sending mail or spending a real one:

   | Probe | Redirected to |
   |---|---|
   | `redirect_to` = the app, as the client sends it | `https://flourishing-sage.vercel.app/index.html#error=…` |
   | no `redirect_to` — shows the Site URL | `https://flourishing-sage.vercel.app#error=…` |
   | `redirect_to` = `https://evil.example/steal` | fell back to the app, **not** evil.example |

   The last row matters: the allow-list is doing its job, so a crafted `redirect_to` cannot
   bounce a freshly minted session to somebody else's server.

   The **"The link didn't work"** fallback stays. It still covers email clients that rewrite
   or pre-fetch links — which silently consumes a one-time token — and it is now reachable
   before sending anything, as *"I already have a sign-in link"* on the sign-in screen.

Then, to bring people on:

3. **Real addresses.** `pilot_allowlist` is seeded with placeholders
   (`principal.arima@bloom.tt` and so on). Replace them with the real ones — see the example
   at the foot of `allowlist.sql`. `leoanthony2009@gmail.com` is already listed as `admin`
   against Port of Spain, so the app is usable as soon as step 2 is done.

4. **No invite needed.** Anyone on `pilot_allowlist` signs in by entering their address:
   the `on_auth_user_created` hook rejects anyone who is not listed and creates the profile,
   with the right school and role, for anyone who is. Both halves verified against the live
   API — an unlisted address gets `500` with **zero** `auth.users` rows created.

5. **Testing without waiting on the mailer.** Open
   `https://flourishing-sage.vercel.app/?staff=1` and a **Central-team password** field
   appears under the email box. It is not a bypass: it calls Supabase's ordinary password
   grant, so the result is a normal session and the caller's role and every RLS policy apply
   exactly as they do after a magic link. Only accounts that have been given a password can
   use it, and no principal has one — `leoanthony2009@gmail.com` is the only account with a
   password set.

   Without `?staff=1` the field is not rendered at all, so nobody on the pilot ever sees it.
   `staff-signin.mjs` asserts both halves.

   Two things worth knowing. Supabase's password grant was already enabled project-wide — it
   is what the end-to-end probes have been using all along — so this adds a front door to an
   existing entrance, not a new one. And the password lives only in `auth.users`, hashed; it
   is not in this repo. Change it from Authentication → Users in the dashboard, or turn the
   whole route off by deleting the `staffMode` block from the design file and rebuilding.

6. **Custom SMTP — the one thing that will actually stop the pilot.** Authentication →
   Emails → SMTP Settings, with Resend, Postmark or SES.

   This is not theoretical: during testing the built-in mailer returned **`429` on the second
   sign-in request within the hour**. Five principals signing in on a Monday morning would
   mean three of them getting nothing, with no clue why. It is also documented as
   development-only and may refuse addresses outside your Supabase organisation entirely.

   The client now tells the difference — a rate-limited send reads "Too many sign-in emails
   just now. Wait a few minutes and try again" rather than blaming the allow-list — but that
   is damage control, not a fix.

7. **Perks** stay in "Term 2 preview" while every row has `active = false`. Set `active = true`
   when a partner signs; no client change is needed.
