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
| **Android APK** | [`release/luma-1.0.0.apk`](release) (also attached to GitHub Releases) |
| **Package** | `app.luma.messenger` |
| **Backend** | Supabase — Postgres + RLS + Realtime + Storage |

---

## Features

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
- **Direct + group chats** — 1:1 and up to 30-person groups, de-duplicated by a
  `create_chat` Postgres function.
- **Unread counts, search, avatars, presence dots, dark/light appearance**.
- **Glassmorphism + Framer Motion** throughout: aurora backdrop, spring-driven
  layout animations, animated segmented controls and toasts.

## Architecture

```
src/
  lib/          supabase client, typed data layer, formatters
  context/      Auth (session + profile), Theme, Toasts
  components/   Aurora, Avatar, LumaMark, MessageBubble, Composer, modals…
  pages/        AuthPage, MessengerPage
mobile/
  apk-shell/    dependency-free native Android shell (Java) + launcher assets
  keystore/     release signing key
scripts/
  build-apk.mjs       Gradle-free signed release APK builder
  make-icons.py       one master artwork → favicon/PWA/OG/android icons
  make-shell-res.py   native shell resources
  make-keystore.py    release signing key
supabase/
  schema.sql          tables, RLS policies, RPCs, storage policies (reference)
```

### Data model

| Table | Purpose |
| --- | --- |
| `profiles` | Public display name + avatar path (auto-created by `handle_new_user`) |
| `chats` | `is_group`, optional `name`, `created_by` |
| `chat_participants` | Membership + `last_read_at`, `last_seen_at`, `typing_until` |
| `messages` | `body`, `reply_to`, media metadata |
| `message_reactions` | `(message_id, user_id, emoji)` |

Every table is protected by **row-level security**: `is_chat_member(chat_id)`
gates reads, senders are pinned to `auth.uid()`, and an outsider with a valid
session sees **zero** chats, messages or reactions (verified).

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
| `VITE_APP_URL` | public web URL (used by the mobile shell) |

## Build

```bash
npm run build     # typecheck + production bundle → dist/
npm run preview   # serve the production bundle
```

## Deploy (Vercel)

`vercel.json` pins the Vite preset (`build → dist`), SPA rewrites, immutable
asset caching and security headers. Deploy with the CLI:

```bash
npx vercel --prod
```

Set the two `VITE_SUPABASE_*` variables for the Production, Preview and
Development environments before deploying.

## Android

See **[docs/ANDROID_CAPACITOR.md](docs/ANDROID_CAPACITOR.md)** for the full
guide. Quick start:

```bash
npm run release                 # web build + signed release APK
npm run apk -- --debug          # debug variant
npx cap add android && npx cap sync android && npx cap open android   # Gradle path
```

The APK loads the live Vercel app and falls back to the bundle embedded inside
the APK when the network is unavailable, so first launch always renders Luma.

## Supabase setup notes

- **Email confirmation is disabled** (`mailer_autoconfirm = true`), so new
  accounts can sign in immediately without an SMTP server.
- Allowed redirect URLs include the Vercel domain, `*.vercel.app`,
  `capacitor://localhost` and localhost.
- Buckets: `avatars` (5 MB, per-user folder) and `chat_media` (20 MB,
  `<chat>/<user>/…`), both private with membership-scoped read policies.

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
