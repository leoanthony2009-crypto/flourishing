# Handoff: Bloom Principal Pulse — backend, auth & AI proxy

## Overview
Bloom Principal Pulse is a weekly mobile check-in for the principals of five Bloom Academy schools in Trinidad & Tobago. Each Monday a principal picks the one theme needing attention (Step 1), sees an aggregated network view (Step 2), gets an evidence-based 60-second idea with optional AI tailoring and routes to support (Step 3), and earns points toward partner perks (Step 4, currently "Term 2 preview").

The front end is finished and deployable (`deploy/`). This package specifies the backend that turns it from a per-device demo into a real pilot, in the agreed order:

1. **Supabase auth + server-side aggregation with a minimum-cell rule**
2. **AI proxy** for "Tailor this idea"
3. **Partner perks** — schema and server-issued codes, switched on when the first partner signs

## About the design files
`Bloom Principal Pulse.dc.html` (plus `support.js`, `shell.js`, `ios-frame.jsx`, `image-slot.js`, images) is a **design reference built in HTML**. It runs as a standalone prototype and is bundled to `deploy/index.html`. The task is **not** to rewrite the UI — it is high-fidelity and can ship as-is — but to replace its localStorage data layer with the API described here. Every place the client reads/writes storage is listed under *Client integration points*. If you prefer to port the UI to a framework, treat the HTML as pixel-accurate.

## Fidelity
**High-fidelity.** Colours, type, spacing, copy and interactions are final. Do not restyle.

---

## 1. Data model (Supabase / Postgres)

Run `schema.sql` in this folder. Summary:

| Table | Purpose | Notes |
|---|---|---|
| `schools` | The five Bloom schools | `id uuid`, `name`, `short_name`, `region` |
| `profiles` | One row per authenticated user | `user_id → auth.users`, `school_id`, `role` (`principal` / `central` / `admin`) |
| `weeks` | Monday-start ISO week rows | `week_start date pk` (generated on demand) |
| `pulses` | One per school per week | `school_id`, `week_start`, `topic` (enum of 14 ids), `impact` (`little` / `quite_a_bit` / `a_lot`), `note` (text, nullable), `submitted_by`, `submitted_at`; unique `(school_id, week_start)` |
| `support_requests` | "I need central-team support" | `school_id`, `week_start`, `type` (`advice`/`conversation`/`practical_help`/`urgent`), `topic`, `impact`, `context`, `help`, `ref` (`BP-YYMMDD-NNN`), `status` (`new`/`in_progress`/`closed`), `assigned_to` |
| `shared_resources` | "Share this support with colleagues → Add to resources" | `school_id`, `topic`, `title`, `try_it`, `text`, `created_by` |
| `points_ledger` | Append-only points events | `school_id`, `week_start`, `kind` (`pulse`/`note`/`full_network`/`redeem`), `delta int`, `ref` |
| `perks` | Partner offers | `id`, `partner`, `offer`, `detail`, `cost`, `terms`, `active bool`, `valid_days int` |
| `redemptions` | Server-issued codes | `school_id`, `perk_id`, `code`, `issued_at`, `expires_at`, `used_at` |
| `ai_tailor_log` | Audit of AI calls (no note stored) | `school_id`, `week_start`, `topic`, `model`, `outcome` (`done`/`declined`/`rejected`/`error`), `latency_ms` |

Topic ids (must match client): `workload, staffing, teaching, behaviour, attendance, safeguarding, parents, send, culture, confidence, resources, change, data, other`.

### Row-level security (in `schema.sql`)
- Principals: `select/insert/update` on `pulses`, `support_requests`, `shared_resources`, `points_ledger(select)`, `redemptions` **only where `school_id = their profile's school_id`**. They never read other schools' rows.
- Central team (`role in ('central','admin')`): read all `support_requests`; **no direct read of `pulses.note`** — notes are exposed only via the `support_requests.context` the principal chose to send. Aggregates come from the RPC below, never raw rows.
- `pulses.note` is excluded from all analytics views and from the aggregation function.

## 2. Auth (Supabase Auth, magic link)
- Provider: **email magic link (OTP)** only. No passwords.
- Allow-list: sign-in succeeds only if the email exists in `profiles` (enforce with a `before insert on auth.users` hook or an edge function `check_allowlist`). Five principals + central team seeded from `seed.sql`.
- Session: Supabase JS client, persisted; the PWA reopens signed in.
- Client change: replace the Step 0 school picker with an email field → "Send me a sign-in link" → "Check your email" state. On session, fetch `profiles` → `school_id`, `short_name` for the header. Remove "Switch school" from the header menu for principals; keep it for `admin` (impersonation for demos, logged).

## 3. Server-side aggregation with a minimum-cell rule
Never send other schools' pulses to a client. Expose one RPC:

```sql
select * from network_pulse(p_week_start date default current_monday());
```
Returns JSON:
```json
{
  "week_start": "2026-09-07",
  "included": 4,
  "current": [{"topic":"workload","count":3}, ...],
  "previous": [...],
  "four_weeks": [{"topic":"workload","counts":[2,2,3,3]}, ...],
  "suppressed": ["send"]
}
```
Rules (implemented in `aggregate.sql`):
- **Minimum cell = 2.** Any topic chosen by exactly 1 school in a week is **not returned by name**; it is reported only inside `included` and listed in `suppressed` as a count, not a topic. The client shows "1 further theme not shown to protect privacy".
- `included` = number of schools with a pulse that week (0–5).
- Hot = count ≥ 3; Rising = count > previous week; Persistent = present (≥2) in ≥3 of last 4 weeks. Compute client-side from the returned counts exactly as today.
- Own school's topic is always known to the client (it submitted it), so the "N of 5 schools chose this theme" chip may still say "1 of 5" for the principal's own theme.
- **Safeguarding exception:** if `safeguarding` count is 1 it is suppressed like any other topic; no special surfacing. The central team sees safeguarding *requests* (not pulses) via `support_requests`.
- Notes are never aggregated, summarised or returned.

Scheduled job (Supabase cron, Monday 06:00 AST): create the week row, send the Monday invite email/push.

## 4. AI proxy ("Tailor this idea")
The client currently calls `window.claude.complete`. Replace with `POST /functions/v1/tailor` (Supabase Edge Function, `tailor/index.ts` in this folder).

- Auth: requires a valid Supabase JWT; looks up `school_id`.
- Rate limit: 6 calls / school / day (KV or a `count(*)` on `ai_tailor_log`).
- Request: `{ topic, impact, note, base: {title, body, tryIt, prompt, evidence, source, local}, more: {checklist[], idea{title, body}} }` — the client already assembles this.
- Model: Anthropic Messages API, `claude-sonnet-4-5`, `max_tokens 500`, system prompt = `AI_SYSTEM` from the client (copied verbatim into `tailor/prompt.ts`). Keep the closed-world rules: only supplied evidence; no new stats/laws/programmes/phone numbers/links/names; decline (`tailored:false`) when the note is vague; refuse safeguarding.
- Server-side validation (mirror of the client's): reject if output contains URLs, `\d{3}[- ]\d{4}`, a percentage not present in `base.evidence`, or "research shows/according to/study"; enforce word limits (title 8, body 50, tryIt 40, prompt 22, grounding 28). Retry up to 3× (Sonnet → Sonnet → Haiku). Return `{ status: 'done', data }`, `{ status: 'declined', reason }` or `{ status: 'error' }`.
- Hard block: if `topic === 'safeguarding'` return `declined` without calling the model.
- Log to `ai_tailor_log` **without the note or the output**.
- Env: `ANTHROPIC_API_KEY` in Supabase secrets only.

## 5. Perks (switch on after first signed partner)
- `perks.active = false` for all rows until a partner signs; client stays in "Term 2 preview" while no active perks exist (`GET /rest/v1/perks?active=eq.true` returns `[]`).
- Points are computed server-side from `points_ledger`: `+10` on pulse insert, `+5` if `note` non-empty, `+10` to every school when `included = 5` for the week (cron after Friday 17:00). Client displays `sum(delta)`; never trusts local math.
- Redemption: `POST /functions/v1/redeem { perk_id }` → checks balance, inserts `points_ledger(kind='redeem', delta=-cost)`, issues code `BLOOM-<PARTNER3>-<6 alnum>` server-side, `expires_at = now() + valid_days`. Partner verification page (`/verify?code=`) for staff at the till — public read of `used_at`/`expires_at` only, mark used with a partner PIN.

## 6. Central-team inbox (admin view)
Minimal web page (can reuse the app's Account-sheet inbox layout): list `support_requests` newest first with `ref`, school, type, theme, impact, context, help, status; set `status`, `assigned_to`. Urgent type → email + SMS to the CEBM duty line immediately (Supabase webhook → Twilio/Resend). Show CEBM +1 868-607-2326, Lifeline (800) 5588 and Children's Authority 996 in the page footer exactly as in the app.

---

## Client integration points (localStorage → API)
| Key today | Replace with |
|---|---|
| `bloom-pulse-school` | `profiles.school_id` from session |
| `bloom-pulse-draft:<school>` | Keep local (drafts are device-local by design) |
| `bloom-pulse-submissions` | `pulses` upsert on submit; `network_pulse()` RPC for Step 2 |
| `bloom-pulse-requests` | `support_requests` insert; inbox reads for central role |
| `bloom-pulse-shared` | `shared_resources` (per school) |
| `bloom-pulse-rewards` | `points_ledger` sum + `redemptions` |
| `window.claude.complete` | `POST /functions/v1/tailor` |

Logic class methods to touch: `persist`, `submit`, `sendCentral`, `saveShared`, `refine`, `redeemPerk`, `loadForSchool`, `componentDidMount`. Everything else (rendering, hot/rising/persistent maths, PDF export, share sheet) is unchanged.

Seeded demo data (`PAST`, `CURRENT`) should be dropped once real pulses exist; keep the `scenario` tweak only in the design file.

## Safeguarding & data-handling policy (summary)
- `pulses.note` is optional, max 240 chars, visible only to the submitting school and never to central staff or analytics. It is passed to the AI proxy for tailoring and **not stored** in the AI log.
- `support_requests.context` is the only note-like text the central team sees, and only because the principal chose to send it.
- The app is not a safeguarding reporting route. Every urgent surface repeats: CEBM +1 868-607-2326 (Mon–Fri 8–4), Lifeline (800) 5588 (24/7), Children's Authority 996, emergency 999.
- Retention: `pulses` 24 months, `support_requests` 36 months, `ai_tailor_log` 12 months, drafts device-only.

## Design tokens (unchanged)
Ink `#14224A` · Navy `#1E3A78` · Lavender `#F0ECF6` / `#D8D2E4` / `#C9B8E6` · Paper `#FFFEF9` · Canvas `#F6F5F0` · Gold `#8A6614` / `#D9B44A` / `#F8F3E8` · Muted `#666A80`.
Headings Source Serif 4 (500); body system-ui. Radii 12/14/16/999. Min target 44px.

## Files in this package
- `README.md` — this document
- `schema.sql` — tables, enums, RLS policies
- `aggregate.sql` — `network_pulse()` RPC with minimum-cell rule, `current_monday()`
- `seed.sql` — five schools, perks (inactive), central-team profile placeholders
- `tailor/index.ts` — Supabase Edge Function for the AI proxy
- `tailor/prompt.ts` — the system prompt (verbatim from the client)
- `redeem/index.ts` — server-issued perk codes
- `design/` — `Bloom Principal Pulse.dc.html` + runtime files and images (the design reference)
- `deploy/` — current static build (for comparison)
