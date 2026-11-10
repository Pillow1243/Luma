# Luma

**Light up your conversations.** A premium, realtime messenger with a dark
glassmorphic interface — built as a Next-gen React web app, an installable PWA,
and a native Android app.

<p align="center">
  <img src="branding/luma-icon-source.png" width="128" alt="Luma app icon" />
</p>

| | |
| --- | --- |
| **Web app** | https://luma-messenger-chi.vercel.app |
| **Android APK** | See [GitHub Releases](https://github.com/Pillow1243/Luma/releases) for the Capacitor debug preview. It is not signed with the existing release key and cannot upgrade a release-signed APK in place. |
| **Package** | `app.luma.messenger` |
| **Backend** | Supabase — Postgres + RLS + Realtime + Storage |

---

## Features

- **Audio/video calls** for direct chats and small groups (up to six) using
  WebRTC and membership-scoped Supabase Realtime signaling. A configured TURN
  account is needed for dependable connections across restrictive networks.
- **Offline history and outbox** — recent visited conversations remain
  readable; queued text messages survive reload and retry when connected.
- **Experimental secret text** — opt-in, device-bound encrypted direct text
  with a 24-hour expiry and a security code. This is not an audited or
  forward-secret protocol; read [the security limitations](docs/UPGRADE.md).
- **Polls, stickers and optional GIPHY**, plus swipe gestures and celebrations.
- **Realtime messaging** over Supabase Realtime — new messages, edits, deletions
  and reactions stream into every open chat with no polling.
- **Optimistic send** — bubbles appear instantly with a spinner, then reconcile
  with the server row.
- **Read receipts** — single tick on send, double cyan tick once the peer's
  `last_read_at` passes the message.
- **Typing indicators** — per-chat, expiring after 5s, driven by
  `chat_participants.typing_until`.
- **Reactions** with an animated picker and per-emoji counts.
- **Replies** with quoted previews that jump to the original message.
- **Rich media** — images, video, audio and arbitrary files up to 20 MB, served
  through short-lived signed URLs from a private bucket.
- **Direct + group chats** — 1:1 and up to 100-person groups, de-duplicated by a
  `create_chat` Postgres function.
- **Channels** — public channels anyone can discover and join, private channels
  with admin-approved join requests; admins post, members read, admins manage.
- **Saved Messages** — a personal, private chat that lives in your sidebar.
- **Starred messages** — star anything, browse it on the /starred page.
- **Mentions & notifications** — `@mention` teammates; unread notification
  badge with a bell tray, plus Web Push via the service worker.
- **Pins & disappearing messages** — pin messages to a chat; set a per-chat
  TTL for self-destructing messages (enforced server-side by `pg_cron`).
- **Search** — full-text-ish message search (term/chat/sender/media) and
  people & channel discovery.
- **Blocking & reporting** — block a user and their messages are rejected at
  the database; report a message for admin review.
- **Forwarding, replies, reactions** with an animated picker and per-emoji
  counts.
- **Unread counts, search, avatars, presence dots, dark/light appearance**.
- **Glassmorphism + Framer Motion** throughout: aurora backdrop, spring-driven
  layout animations, animated segmented controls and toasts.

## Architecture

```
src/
  lib/          supabase client, typed data layer, formatters
  context/      Auth (session + profile), Theme, Toasts
  components/   Aurora, Avatar, LumaMark, MessageBubble, Composer, modals…
  pages/        AuthPage, MessengerPage, StarredPage, JoinPage (/join/:token)
mobile/
  apk-shell/    dependency-free native Android shell (Java) + launcher assets
  keystore/     release signing key
scripts/
  build-apk.mjs       Gradle-free signed release APK builder
  make-icons.py       one master artwork → favicon/PWA/OG/android icons
  make-shell-res.py   native shell resources
  make-keystore.py    release signing key
supabase/
  schema.sql                reference dump (not applied directly)
  migrations/               source of truth — apply in order
    20261109000000_luma_v3_1_schema.sql
    20261109000000_luma_v3_2_rls_and_triggers.sql
    20261109000000_luma_v3_3_rpcs.sql
    20261109000004_luma_v3_hardening.sql
    20261109000005_luma_v3_cron.sql
    20261109000006_luma_v3_rpc_fixes.sql
    20261110000000_calls_secret_polls.sql
tests/
  rls-tests.mjs             live authorization suite (manual run)
```

### Data model

| Table | Purpose |
| --- | --- |
| `profiles` | Public display name + avatar path (auto-created by `handle_new_user`) |
| `chats` | `kind` (`direct`/`group`/`channel`/`saved`), `is_group`, `username` (channels), TTL, pins, `created_by` |
| `chat_participants` | Membership + role (`is_admin`), `last_read_at`, `last_seen_at`, `typing_until` |
| `messages` | `body`, `reply_to`, media metadata, `expires_at` (disappearing) |
| `message_reactions` | `(message_id, user_id, emoji)` |
| `starred_messages` | Per-user stars |
| `notifications` | Mention/notification inbox with read state |
| `push_subscriptions` | Web Push endpoints for the service worker |
| `blocks` | User blocks (enforced in `send_message`) |
| `message_reports` | Reported messages, readable by chat admins/reporters |
| `chat_invites` / `join_requests` | Invite links + private-channel join approval |
| `calls` / `call_participants` / `call_signals` | Call history, invitations and recipient-scoped WebRTC signaling |
| `user_public_keys` | Experimental device-bound secret-text public keys |
| `polls` / `poll_options` / `poll_votes` | Single-choice, member-visible polls |

Every table is protected by **row-level security**: membership predicates
(`is_chat_member`, `is_chat_admin`) gate reads and writes, senders are pinned
to `auth.uid()`, and an outsider with a valid session sees **zero** rows.
This was verified by direct execution against the production project (see
Testing).

---

## Local development

```bash
npm install
cp .env.example .env      # add your Supabase URL + anon key
npm run dev               # http://localhost:5173
```

Env vars:

| Key | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | anon **or** `sb_publishable_…` key |
| `VITE_APP_URL` | public web URL |
| `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | optional Open Relay/Metered configuration; example credentials are not guaranteed |
| `VITE_GIPHY_API_KEY` | optional GIPHY developer key; built-in stickers work without it |

## Build

```bash
npm test          # IndexedDB, crypto and idempotency tests
npm run build     # typecheck + production bundle → dist/
npm run preview   # serve the production bundle
```

## Testing

`tests/rls-tests.mjs` is the live authorization suite: four throwaway accounts
sign up through the real auth flow and every allowed/denied assertion runs
through the same PostgREST path the app uses.

```bash
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<publishable key> \
  node tests/rls-tests.mjs
# then remove the fixtures it creates (see the header comment in the file)
```

For the last delivery, the same assertions were executed against the
production project with SQL (`set role authenticated` + JWT claims):

- **59 authorization checks** — direct chat (12), group admin rules (15),
  channels incl. join approval (12), notifications/blocks/reports/stars/
  saved-chat/push/expired rows (20). All passing.
- **6 storage checks** — avatar folder isolation, chat-media membership
  gating for upload/read. All passing.
- **Expiry enforcement** — an expired message inserted during the suite was
  reclaimed by the `cleanup_expired_messages` cron job (verified live).
- The SQL runner cannot be used from CI (the SQL API is privileged), so the
  Node suite exists for environments with network access; CI runs typecheck +
  build only.

## Deploy (Vercel)

The app deploys to the **`luma-messenger`** project (production alias
`https://luma-messenger-chi.vercel.app`). Note: `luma-messenger.vercel.app`
serves a different, stale deployment outside this project and is not ours.

`vercel.json` pins the Vite preset (`build → dist`), SPA rewrites, immutable
asset caching and security headers (CSP, HSTS, …). The project is configured
with `buildCommand=npm run build`, `installCommand=npm install`,
`outputDirectory=dist`. Automatic git deployments are disabled, so deploys are
explicit:

```bash
npx vercel --prod   # after `vercel link` to the luma-messenger project
```

`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_APP_URL` are set on
the project for Production, Preview and Development.

## Android

See **[docs/ANDROID_CAPACITOR.md](docs/ANDROID_CAPACITOR.md)** for the full
guide. Quick start:

```bash
npm run build
npx cap add android
node scripts/configure-capacitor-android.mjs
npx cap sync android
cd android && ./gradlew assembleDebug
```

The Capacitor debug preview uses the bundled web app at one local secure origin,
so the same IndexedDB history is available online and offline. It is a debug
build, not a release-signed upgrade. The original release keystore is not in
this repository. The legacy Gradle-free WebView shell remains a separate build.

For the new calling/offline/encryption architecture, operational setup, and
important limitations, see **[docs/UPGRADE.md](docs/UPGRADE.md)**.

## Supabase setup notes

- **Email confirmation is disabled** (`mailer_autoconfirm = true`), so new
  accounts can sign in immediately without an SMTP server.
- Allowed redirect URLs include the Vercel domain, `*.vercel.app`,
  `capacitor://localhost` and localhost.
- Buckets: `avatars` (5 MB, per-user folder) and `chat_media` (20 MB,
  `<chat>/<user>/…`), both private with membership-scoped read policies
  (execution-tested).
- `pg_cron` job `cleanup-expired-messages` runs every 5 minutes and
  reclaims expired (disappearing) messages.

## Icon

One master artwork (`branding/luma-icon-source.png` — a rounded conversation
bubble with a central spark on a violet gradient) drives **every** icon:

- web favicon (`.ico`, 16–64 px) and Apple touch icon
- PWA icons 192/512/1024 + maskable safe-zone variant
- OpenGraph card
- Android launcher (`mdpi → xxxhdpi`), round variant, adaptive
  foreground + `#0B0716` background, and the launch splash

Regenerate everything with `npm run icons`.

## License

MIT
