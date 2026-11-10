# Luma upgrade: ratcheted secret chats, calls, offline, and security hardening

## Calls & TURN credentials

Direct chats and groups of **2–6 members** can start audio or video calls.
Supabase Postgres Changes carries call invitations, SDP offers/answers and ICE
candidates. RLS restricts calls to chat members and signaling rows to their
intended recipient; clients delete consumed signals and a scheduled job removes
stale signals and calls. Media is a WebRTC peer-to-peer mesh, not an SFU; larger
groups require a media server. Incoming calls ring while Luma is open and
connected.

The client requests short-lived ICE/TURN credentials from the authenticated
`turn-credentials` Supabase Edge Function before establishing a call, with
fallback to build-time `VITE_TURN_*` configuration and public STUN servers.
Microphone/camera access requires a secure origin and permission. Screen share
requires browser support and is generally unavailable in Android WebView.

## Secret chat mode (X3DH + Double Ratchet + encrypted media)

Secret mode is **opt-in per direct chat** (lock toggle in the chat header).
When enabled, new text messages, voice notes, and attachments are encrypted
client-side using Web Crypto (`P-256` ECDH, `ECDSA` signed prekeys, one-time
prekeys claimed atomically via `claim_prekey_bundle`, HKDF-SHA-256 root/chain
KDFs, and AES-256-GCM with `chatId`/`senderId`/`recipientId`/ratchet header AAD
binding). Attachments are encrypted into `.enc` blobs with ephemeral per-file
keys sealed inside the ratcheted payload, and decrypted locally before render.

Non-extractable identity private keys stay in device IndexedDB
(`luma-secret-v2`). Legacy `luma:e2ee:v1:` messages remain decryptable for
existing conversations. Compare the 60-digit safety number and fingerprint emojis
with your peer out of band; peer identity key rotation halts secret sends until
explicitly re-verified.

**Important caveats:** Losing browser storage or uninstalling the app deletes
device-bound identity and ratchet state (multi-device key backup is not yet
implemented). The server still observes chat membership, timestamps, and
attachment sizes. Encrypted text is not server-searchable. No formal third-party
cryptographic audit has been performed yet.

## Offline behavior and privacy

After an online sign-in and visit, the app shell (Service Worker `luma-v4-offline`),
recent chat list, and up to 150 messages per visited conversation are cached in
IndexedDB, scoped by account. Text sends save to a durable outbox with a stable
UUID *before* the composer clears and retry cleanly on reconnect. Regular message
history is stored unencrypted in IndexedDB; secret-message bodies stay as
ciphertext or TTL-scoped plaintext cache.

## Bilingual English / Persian (RTL) & accessibility

Luma supports English (`ltr`) and Persian (`fa`, `rtl`) with bundled
`Inter Variable` and `Vazirmatn Variable` fonts, Jalali/Persian locale date
formatting (`fa-IR`), logical CSS directional properties (`ms-*`, `ps-*`,
`start-*`, `end-*`), and full RTL icon flipping.

## Database, Edge Functions & verification

- Hardening migrations `20261110120000_luma_security_and_ratchet.sql` through
  `20261110143000_fix_handle_profile_delete_join_profiles.sql` enforce cascade
  deletes & ownership transfer on account removal, `last_seen_at` privacy
  triggering, server-side rate limiting, least-privilege table/column/function
  grants (`anon` completely revoked), SVG/executable upload blocking, trigram
  search indexes, `search_users`, `get_chat_sidebar_meta`, and X3DH prekey RPCs.
- Deployed Supabase Edge Functions: `health`, `account-delete`,
  `turn-credentials`, and `send-push`.
- Verification: `npm test` (11 unit tests covering IndexedDB isolation, X3DH +
  Double Ratchet multi-turn/out-of-order/concurrent race/key-change/encrypted
  media, idempotent retries, WebRTC transceivers, and SVG upload guards),
  `npm run lint`, `npm run build`, `tests/browser-calls.mjs` (WebRTC smoke test),
  and live Postgres `SET LOCAL ROLE anon/authenticated` security checks.
