# Luma: security and reliability audit

**Scope.** The whole application: the React/Vite client in `src/`, the four edge
functions in `supabase/functions/`, the database (schema, RLS, RPCs,
triggers) and its deployment, the authentication configuration, and the CI that
is supposed to catch regressions.

**Snapshot.** Repository `d823d66` + this branch (`2.1.0`, 12.2k lines of
TypeScript, 21 components, 19 migrations, 4 edge functions). Live project
`lnhmbjqjfrnqkpsjpszb` (PostgreSQL 17.11, free plan) at
`https://luma-messenger-chi.vercel.app`.

**How this was produced.** By reading the code and by *running* the database:
two harnesses now replay the schema from scratch and exercise 86 authorization
scenarios, and a third compares the replay against a fingerprint captured from
the live project. Findings that were not verified this way are labelled as such.
Where a claim could not be tested — a Deno edge function with no runtime
available, GoTrue itself, a browser — this document says so instead of implying
coverage.

---

## 1. Summary

The application is in better shape than its history suggests, and the gap
between "what the repository says" and "what production runs" was the most
dangerous thing in it. That gap is now measurable and mostly closed in the
repository; closing it *on production* is a separate, deliberate step that has
not been taken yet.

| area | verdict |
|---|---|
| Authorization model (RLS + RPC) | **Strong.** 23 tables, 47 policies, every helper `security definer` with `set search_path = ''` and explicit `auth.uid()` checks. 86 negative tests pass. |
| Repository ↔ production drift | **Was the top risk.** Fixed in the repository, **not yet deployed**. |
| Sign-out / shared-device handling | **Was broken.** Cached data for the previous account survived sign-out. Fixed in the repository. |
| Push notifications | **Was exploitable** (endpoint takeover, client-trusted text). Fixed in the repository. |
| End-to-end encryption | **Sound design, unverified implementation.** No independent review of the ratchet or the key exchange. |
| Authentication configuration | **Weakest link today.** 6-character minimum, no leaked-password check, no CAPTCHA, no SMTP. |
| Test coverage | **Was zero for the database.** Now three suites; the browser/auth/Realtime layer is still manual. |
| Operations | **Single free-plan project, no verified backup, no staging.** |

Nothing here is a claim that the app has been penetration-tested. It has not.

---

## 2. What is genuinely good

Worth stating plainly, because a report that only lists defects is misleading.

* **The write model is column-scoped.** `authenticated` holds
  `SELECT` on tables and `INSERT`/`UPDATE` on *specific columns*
  (`messages`: body/media/pinned/expires; `chats`: name/description/avatar/…)
  but never on `sender_id`, `is_admin`, `created_by` or `uses`. Spoofing is
  rejected by the grant system before any policy is consulted — a defence that
  survives a buggy policy. `tests/db/security.mjs` asserts this per column.
* **Every privileged function is `security definer set search_path = ''`.**
  No `search_path` hijack is possible, and object names are schema-qualified.
  New functions the harness checked are revoked from `PUBLIC`/`anon` explicitly
  (the trap: `create function` grants `EXECUTE` to `PUBLIC` by default).
* **Server-side invariants are real invariants.** `messages_guardian` enforces
  membership, block state, length and rate limits; `protect_participant_role`
  stops a member promoting themselves; `sync_poll_vote_counts` keeps tallies
  correct so a client cannot write them; `profiles_privacy_guard` protects
  `last_seen_at`.
* **The E2EE design is conservative.** X25519 + HKDF + AES-GCM with
  chat/sender/recipient bound as AAD, per-message ratchet with
  `MAX_SKIP`/`MAX_STORED_SKIPPED` bounds, ciphertext-only persistence in
  IndexedDB, and an outbox that refuses to retry permanently-failing sends
  (`/^(22|23|28|42|P0001)/`) instead of spamming.
* **Transport hardening is already in place** in `vercel.json`: CSP without
  `unsafe-eval`, `frame-ancestors 'self'`, HSTS with a two-year max-age,
  `nosniff`, a scoped `Permissions-Policy`, and a service worker served
  `max-age=0, must-revalidate`.

---

## 3. Findings

Severity is about impact if exploited, not about how hard it was to find.
Columns: what it is, why it matters, and its state.

### P0 — fixed in the repository, **not deployed**

**3.1 Web Push endpoint takeover.** `register_push_subscription` upserted with
`on conflict (endpoint) do update set … user_id = excluded.user_id`. Push
endpoints are not secrets — they appear in every push payload log and in the
browser's own subscription list — so anyone who observed an endpoint could
re-register it under their own account. The effect is two-sided: the victim
stops receiving notifications for their messages, and the attacker receives
them. On a messenger, an attacker who can also read the notification body sees
the sender, the chat name and the message preview.

*Fix:* `20261110160000_harden_push_registration.sql` — the owner of an endpoint
can never change; a mismatched `user_id` raises `42501`.
*Verified:* forced to fail without the migration; passes with it.

### P1 — fixed in the repository, **not deployed**

**3.2 Fresh installs could not publish secret-chat keys.** The repository
definition of `publish_prekey_bundle` wrote a `text` value into
`user_public_keys.public_key`, which is `jsonb`. Production has the corrected
body; a deployment from this repository would not. This is the failure mode the
parity harness exists for: production works, so nobody notices until the next
environment is built from the repo.

**3.3 The client calls a poll RPC that a fresh install did not have.** The
client uses the 6-argument `create_luma_poll`; replaying the migrations produced
only the 3-argument one. Production happened to have the right one.

**3.4 `poll_vote_counts` lost `authenticated SELECT`** while keeping
`TRUNCATE`, `REFERENCES` and `TRIGGER`. Losing `SELECT` breaks the poll UI;
keeping `TRUNCATE` is a privilege nobody needs.

**3.5 The `profiles_update` policy existed on production but not in the
repository** — a fresh install could not edit a profile at all. Found by the
parity suite, not by reading code.

**3.6 `handle_profile_delete` could hand a chat to a deleted account.** It
transferred ownership without preferring live profiles.

**3.7 Group and channel avatars could not be uploaded by their owner.**
`media_upload` required the uploader's id in the path segment *and*
membership; avatars live at `<chat_id>/<owner_id>/avatar-*`, so the owner — the
only person allowed to set the avatar — was the one person who could not upload
it. *Fix:* `20261110170000`, an `avatar-*` branch gated on
`public.is_chat_admin(...)`, plus `php|jsp` added to the blocked-extension list.

### P2 — fixed in the repository

**3.8 Sign-out left the previous account's data on the device.** Cached chats,
message snapshots, the outbox and composer drafts lived in IndexedDB and
`localStorage` under keys that did not include the user id, and `signOut` only
cleared the session. On a shared or lost device the next person to sign in — or
anyone with the browser profile — had the previous user's conversations.

*Fix:* `clearOfflineUser(userId)` now purges chats, messages, outbox, reactions
and drafts; `clearDrafts(userId)` removes `luma-draft:<userId>:*` and
`luma-draft:guest:*`; drafts are keyed by user; `signOut` and `signOutAll` purge
*before* `supabase.auth.signOut()` so a failed network call cannot leave data
behind. Secret-chat identity keys are deliberately **not** purged by default —
they are unrecoverable — so they are behind an explicit checkbox with a warning
in `ProfileModal`.

**3.9 `send-push` let any authenticated user push arbitrary text to any chat.**
It accepted `{chatId, title, preview}` and forwarded them to every other
participant's devices. There was no membership check, no authorship check, no
rate limit, no deduplication, and it notified participants of secret chats —
including, in the old call path, an E2EE body.

*Fix (repository only, see §4):* the function now takes `{chatId, messageId}`,
reads the row itself, requires membership *and* that the caller sent the
message, refuses secret chats with `{skipped:"secret_chat"}`, derives the text
server-side (`describe()` redacts `luma:e2ee:v2:` bodies to "New encrypted
message"), deduplicates on `push_log.message_id`, rate-limits to 30 requests per
minute per user, and prunes subscriptions on `404`/`410`. The client no longer
sends any user-visible text.

**3.10 `check_rate_limit` was executable by `authenticated`.** Any user could
reset their own abuse counters for `send_message`, `create_invite` and
`request_join`. Now `service_role`-only.

**3.11 An invite link wasted a use when it granted nothing.** `redeem_invite`
incremented `uses` before it knew whether the caller could join, so a member
re-opening their own group's link consumed a use of a `max_uses` invite. *Fix:*
membership is idempotent and the counter only moves when membership is actually
granted. Concurrency is still safe: the reservation is one conditional
`UPDATE … WHERE uses < max_uses RETURNING`.

I also wrote, then deleted, a test asserting that a *failed* redemption burns a
use — it does not, in either version, because the raised exception rolls back
the request's transaction. The test was vacuous and the underlying bug was not
there.

### P2/P3 — open, not fixed

**3.12 Authentication is the weakest link.** From the live project's auth
configuration:

| setting | value | concern |
|---|---|---|
| minimum password length | **6** | the client asks for 8 (`AuthPage`, `App.tsx`, `ProfileModal`), so 6–7 is only reachable by bypassing the UI; the *server* decides, and it allows it |
| leaked-password (HIBP) check | off | |
| CAPTCHA | off | signup is open and unthrottled beyond `rate_limit_email_sent: 2` |
| SMTP | none | reset/confirmation mail goes through Supabase's shared sender: deliverability and a shared reputation |
| refresh token rotation | on | good |
| update password requires current password | **off** | a stolen session can change the password |
| sessions inactivity timeout / single session | none | |

Recommended, in order: minimum length 8 (matching the UI), HIBP on, custom
SMTP, `security_update_password_require_reauthentication` on.

**3.13 Channels have no member cap; groups do.** `group`/`channel` joins via
invite are capped at 100 by a literal inside three functions, while
`subscribe_channel` is uncapped. That is either intentional (channels are meant
to be broadcast) or an oversight — it is undocumented either way, and the
constant cannot be configured per chat.

**3.14 Persian localisation is partial.** The `fa` dictionary now has complete
parity with `en` (85 keys each, zero untranslated values), but ~164 user-facing
strings are still inline English in JSX — `MessageBubble` (31), `ChatInfoModal`
(22), `ChatWindow` (20), `ProfileModal` (16), `Poll` (12) and others. These are
the most *visible* strings in the app, so a Persian user sees a half-translated
interface. No Persian-specific layout review (RTL mirroring, numeral shaping)
has been done.

**3.15 No VAPID or TURN secrets are configured.** `send-push` returns
`{configured:false}` and the client falls back to local desktop notifications;
`turn-credentials` falls back to STUN only. Calls therefore only work on
permissive networks — a real limitation for a messenger, not a security bug.

### Limitations of this audit

* **The edge functions have never been executed.** There is no Deno runtime
  here, and the functions cannot be deployed without changing production. The
  `send-push` rewrite is reviewed, type-consistent with the schema (the columns
  it uses exist — verified), and covered by a migration for the table it needs,
  but it is **untested code**. Deploy it to a staging project first.
* **GoTrue, Storage's signed URLs and Realtime authorization were not
  exercised**; they are Supabase-managed. `tests/rls-tests.mjs` covers them
  against the hosted project but needs real accounts and is manual.
* **The E2EE implementation was not audited cryptographically.** The design is
  documented and bounded; nothing here substitutes for a review of the ratchet,
  the AAD binding and the prekey bundle by someone who attacks it for a living.
* **No browser-based test exists** for the offline/outbox paths, so the leak fix
  in §3.8 is verified by unit-level reasoning and `tsc`, not by a running app.
* **The push ordering hazard in §4 is live**: the client on `main` sends the new
  request shape, the deployed function expects the old one, and the two only work
  together. It is benign today only because VAPID is unconfigured.

---

## 4. Why "fixed in the repository" is not "fixed"

Every migration named above is committed and tested here. **None of them has
been applied to the live project**, for one reason: there is no verified,
restorable backup, and applying DDL to the only production database with no way
back is the wrong trade.

Order of operations for deployment:

1. Confirm a restore point in *Database → Backups*; note the timestamp.
2. Apply, in order: `20261110150000_reconcile_with_production.sql`,
   `20261110160000_harden_push_registration.sql`,
   `20261110170000_fix_chat_avatar_upload.sql`,
   `20261110180000_push_log.sql`,
   `20261110190000_fix_redeem_invite_uses.sql`.
3. Deploy the rewritten `send-push` (and only then does the client's
   `{chatId, messageId}` call make sense — the two must ship together).
4. Set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` and
   `ALLOWED_ORIGINS` for the function.
5. Re-capture the fingerprint (§6 of `docs/DB.md`), delete the matching entries
   from `04_pending_production_changes.json`, and re-run
   `npm run test:db:parity` — it should report zero differences.
6. Only then mark the findings in `docs/DB.md` §7 as deployed.

Steps 3–4 have an ordering constraint that is easy to get wrong: the function
deployed today (version 1) expects `{chatId, title, preview}` and accepts no
`messageId`, while the client merged in this branch sends `{chatId, messageId}`.
Ship the client alone and the deployed function answers `400 chatId required` —
silently, because the call is deliberately best-effort.

What limits the damage today is that **no VAPID keys are configured**, so the
deployed function returns `{configured:false}` before it reads any content and
the client falls back to local desktop notifications. In other words Web Push is
currently inert in production; it will stay inert after the client deploy until
somebody adds the VAPID secrets *and* deploys the new function. Do all three in
one step, or leave Web Push off.

---

## 5. Luma vs. Telegram

Telegram is the obvious reference point for a self-described encrypted
messenger, so the comparison is useful — not because Luma should equal Telegram,
but because the gaps explain the claims Luma must *not* make.

| capability | Luma | Telegram | note |
|---|---|---|---|
| E2EE 1:1 chats | yes, opt-in per chat (X25519 + double ratchet, AES-GCM) | yes, opt-in "Secret Chats" | Luma's design is comparable; neither has been independently audited in this codebase's case |
| E2EE group/channel chats | **no** | no (groups are server-side encrypted) | consistent with Telegram; both rely on server integrity for groups |
| E2EE on by default | no | no | Telegram's defaults are the industry's most-criticised; "opt-in E2EE" is normal, not a scandal |
| Multi-device encrypted history | no (keys are per-device; secret-chat keys do not survive sign-out) | no for secret chats | Luma is honest about this; WhatsApp-style key backup is a large project |
| Server-side message storage | yes, plaintext for normal chats | yes | a hosted Postgres means the operator can read normal chats — same trust model as Telegram for non-secret chats |
| Forward secrecy / post-compromise security | yes (ratchet) | secret chats only | |
| Sender-verifiable identity (key transparency) | **no** | no (Telegram has no KT either) | the classic MITM-on-first-contact gap; both share it |
| Disappearing messages | yes (`expires_at`, `cleanup_expired_messages`) | yes | |
| Voice/video calls | yes (WebRTC, P2P, no TURN configured) | yes, with relayed TURN | Luma's calls fail on strict NATs |
| Groups | yes, ≤100 members | yes, up to 200k | |
| Channels | yes, uncapped | yes, unlimited subscribers | |
| Polls | yes (anonymous, multi-choice, deadlines) | yes | Luma's are close to parity |
| Bots / platform API | **no** | extensive | largest functional gap |
| Moderation tooling | minimal (report, block, admin) | extensive | |
| Self-hosting | yes | **no** | Luma's genuine advantage |
| Open source | yes | clients only | |
| Multi-platform apps | PWA + Capacitor Android shell | native everywhere | |
| Independent security audit | **no** | partially (crypto design published) | Luma should not claim "secure", only "encrypted by design" |
| Offline queue | yes (60 s backoff, permanent-failure handling) | yes | Luma's is more carefully bounded than most hobby apps |

What this means for positioning: **Luma is a competent, self-hostable Telegram
subset with an opt-in E2EE mode that is architecturally sound but unaudited.**
It is not "more secure than Telegram" in any defensible sense — it has fewer
eyes on it — and it is not a Telegram replacement for groups, bots or scale.

---

## 6. Recommendations, in priority order

1. **Deploy the migrations and the `send-push` rewrite together** (§4), after a
   verified backup. Until then, the P0 push-takeover fix exists only in git.
2. **Harden auth**: minimum length 8, HIBP on, custom SMTP,
   require-reauthentication-for-password-change. This is configuration, not
   code.
3. **Get the edge functions into a staging project.** Reviewing TypeScript that
   has never run is not verification. `push_log`-based deduplication in
   particular should be exercised with a real retry.
4. **Commission a review of the E2EE layer**, or explicitly label it
   "experimental" in the UI. The current claim ("encrypted") is defensible for
   transport; "end-to-end encrypted" invites a comparison the code has not
   earned until someone attacks it.
5. **Finish the Persian localisation** (§3.14) — the most visible quality gap to
   a Persian-speaking user.
6. **Configure VAPID and TURN** so notifications and calls work outside a lab
   network.
7. **Keep the harnesses honest**: they are the only reason anything in §3 was
   found. Add a scenario whenever a policy changes, and keep
   `04_pending_production_changes.json` empty except for genuinely undeployed
   work.

---

## 7. Verification

Reproduce everything claimed about the database (no Supabase account needed):

```bash
docker run -d --name luma-pg -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
export DATABASE_URL="postgresql://postgres:postgres@localhost:55432/postgres"
npm run test:db:all
```

Expected output:

```
✓ FRESH and UPGRADE paths produce an identical schema
  tables: 24   policies: 47   functions: 53
86/86 authorization checks passed
✓ Repository schema matches the captured production fingerprint.
6 difference(s) are expected and tracked in supabase/baseline/04_pending_production_changes.json.
```

The six tracked differences are the undeployed migrations; the parity suite
fails on anything *untracked*, so drift cannot hide behind them.

`npm run lint`, `npm test` (11/11) and `npm run build` are green on this branch.
