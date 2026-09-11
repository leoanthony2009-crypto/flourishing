# Bloom Principal Pulse — backend setup

State of the pilot backend and what is still needed before principals can sign in.

## Supabase project

| | |
|---|---|
| Project | `bloom-principal-pulse` |
| Ref | `phnpteeujuaqebzteacd` |
| Region | `us-east-1` (closest to Trinidad & Tobago) |
| API URL | `https://phnpteeujuaqebzteacd.supabase.co` |
| Publishable key | `sb_publishable_SzTl41P5xSLODN4juR-Hwg_Q9BWkfS-` |

The URL and publishable key are in the client (`design/Bloom Principal Pulse.dc.html`, in the
`<helmet>` block). Both are safe to ship: every table is behind RLS and the publishable key
carries no privileges of its own.

### Applied

| Step | Source | Result |
|---|---|---|
| Schema, enums, RLS, points trigger | `schema.sql` | migration `bloom_schema` |
| `network_pulse()`, `current_monday()`, `award_full_network()` | `aggregate.sql` | migration `bloom_aggregate` |
| Function privileges & `search_path` | `harden.sql` | migration `bloom_function_hardening` |
| 5 schools, 3 perks (all `active = false`) | `seed.sql` | seeded |
| AI proxy | `tailor/index.ts` + `tailor/prompt.ts` | deployed, `verify_jwt: true` |
| Perk codes | `redeem/index.ts` | deployed, `verify_jwt: true` |

`harden.sql` was not in the handoff package. The linter flagged that `award_full_network()`
is `SECURITY DEFINER` and, like every function in `public`, exposed over `/rest/v1/rpc` with
PostgreSQL's default `EXECUTE` grant to `PUBLIC` — so any signed-in principal could have
awarded +10 points to all five schools on demand. That grant is revoked; the rest is
`search_path` pinning on the definer helpers.

Both edge functions also gained CORS preflight handling, which the handoff versions lacked.
The client is a static page on a different origin, so the browser sends an `OPTIONS`
preflight that the original code answered with `405`.

### Verified

Run against temporary fixtures, since removed (the database now holds only the 5 schools and
3 inactive perks):

- **Minimum-cell rule.** A week of `workload ×3, staffing ×1, behaviour ×1` returned
  `current: [{workload, 3}]` with `suppressed: 2`. The single-school themes are not named.
- **Own-school visibility.** One school, one pulse → `current: []`, `suppressed: 1`,
  `included: 1`. The client re-adds the principal's own theme locally, so the chip can still
  read "1 of 5" for their own choice without the server ever naming it.
- **Four-week series.** `workload [0,2,2,3]`, `attendance [0,3,3,0]` — cells below 2 zeroed.
- **RLS.** With 15 pulses across 5 schools, one principal's session saw 3 pulses,
  1 profile and 3 ledger rows. Central/admin have no `select` policy on `pulses` at all.
- **Points trigger.** A pulse with a note produced `sum(delta) = 15` (10 + 5).
- **Privilege fix.** `award_full_network()` as an authenticated principal now raises
  `insufficient_privilege`.

## Still needed before go-live

1. **`ANTHROPIC_API_KEY`.** The `tailor` function is deployed but will return
   `{status:'error'}` on every call until the secret is set — Supabase MCP cannot write
   secrets, so set it in Dashboard → Project Settings → Edge Functions → Secrets. The client
   degrades correctly meanwhile: the evidence-based default idea is shown.
2. **Principal accounts.** There are no `auth.users` yet, so no one can sign in. Invite the
   five principals and the central team (Dashboard → Authentication → Invite, or the admin
   API), then create their `profiles` rows — see the commented examples at the foot of
   `seed.sql`.
3. **Allow-list.** The README asks for sign-in to succeed "only if the email exists in
   `profiles`", enforced by a `before insert on auth.users` hook. That is circular as
   specified: `profiles.user_id` is a FK to `auth.users`, so the profile cannot exist before
   the user. Enforced instead in two layers that need no schema change:
   `signInWithOtp({ shouldCreateUser: false })` so no one self-registers, and a check in
   `onSession()` that signs out any session without a `profiles` row. If you want it at the
   database level too, it needs a separate `allowed_emails` table — say the word and I'll
   add one.
4. **Cron.** Not set up. Two jobs from the README: create the week row and send the Monday
   invite (Mon 06:00 AST); `select award_full_network()` after Fri 17:00 AST.
5. **Perks.** All three rows are `active = false`, so the app stays in "Term 2 preview"
   until a partner signs. Flip `active` to switch redemption on — no client change needed.
6. **Redirect URL.** Magic links use `window.location.origin + pathname`. Add the deployed
   origin to Dashboard → Authentication → URL Configuration before the first invite.
