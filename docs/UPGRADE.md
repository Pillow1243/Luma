# Luma upgrade: calls, offline, and secret text

## Calls

Direct chats and groups of **2–6 members** can start audio or video calls.
Supabase Postgres Changes carries call invitations, SDP offers/answers and ICE
candidates. RLS restricts calls to chat members and signaling rows to their
intended recipient; clients delete consumed signals and a scheduled job removes
stale signals and calls. Media is a WebRTC peer-to-peer mesh, not an SFU; larger
groups require a media server. Incoming calls currently ring only while Luma is
open and connected. They do not use operating-system CallKit/FCM/PushKit.

Microphone/camera access requires a secure origin and permission. Screen share
requires browser support and is generally unavailable in Android WebView. ICE
restart is best-effort. The client includes public Open Relay example settings,
which are **not guaranteed credentials**. For deployment, obtain a free
Open Relay/Metered account, then set `VITE_TURN_URLS`, `VITE_TURN_USERNAME`
and `VITE_TURN_CREDENTIAL` at build time. Test relay-only calls on actual
restricted networks. Static browser-visible TURN credentials can be abused;
production should obtain short-lived credentials from an authenticated backend.
STUN alone cannot guarantee connectivity across all NATs/firewalls.

## Experimental secret text

Secret text is **opt-in per direct chat** (the lock in the header). Only new
text sent while it is on is encrypted: P-256 ECDH, HKDF-SHA-256 and AES-256-GCM
with a random nonce and chat/sender/recipient bound as authenticated data. The
non-extractable private key is stored in IndexedDB on the first device; only
its public key is sent to Supabase. Both people must open the updated app on
their respective devices first. Compare the displayed security codes through a
trusted independent channel. A changed pinned peer key blocks secret sending.

**This is experimental and has not had an independent security audit.** It is
not Signal: there is no ratchet, forward secrecy, key backup, multi-device
synchronization, automatic recovery, or cryptographic account identity
verification. Losing browser storage or uninstalling the app can permanently
lose the private key and access to these messages. The server still sees
metadata; old/plain messages, attachments, GIFs, polls, reactions and calls
are not covered by this text encryption. Secret messages have a 24-hour expiry;
the client hides expired messages and the existing server cron deletes expired
rows, but neither prevents screenshots or guarantees deletion of recipient
copies. Encrypted text is not searchable on the server. Do not use this mode for
high-risk communications until it is professionally reviewed and replaced by
an audited, ratcheting protocol.

## Offline behavior and privacy

After a successful online sign-in and visit, the app shell, the recent chat
list, and up to 150 messages per visited conversation are cached in IndexedDB,
scoped by account. Text sends are saved to a durable outbox *before* the
composer clears; a stable UUID prevents duplicates if a server response is
lost. Queued messages retry when connected and survive reloads. Permanent
failures offer retry/discard. The app must be open for synchronization; media,
voice notes, poll creation/votes and archive actions require a connection.
Offline reads require an existing local session. Browser eviction, private
browsing, device storage failures, or expired authentication can prevent
recovery. Regular message history/outbox data is stored **unencrypted on the
device**; secret-message bodies remain ciphertext there. A shared device user
with access to browser storage may read cached data. Signing out does not
silently delete a device's unrecoverable secret key or all cached data.

## Polls, stickers and GIFs

Polls are single-choice; every member can see individual votes. Built-in emoji
stickers work without a key. Set `VITE_GIPHY_API_KEY` to a free GIPHY developer
key to enable GIF search. GIFs load from GIPHY, so GIPHY can observe the request;
they are not encrypted and are not guaranteed to work offline.

## Verification

- `npm test`, `npm run lint`, `npm run build`, `npm audit`. After building,
  `CHROME_PATH=/path/to/chromium npm run test:browser:calls` exercises real
  local WebRTC media connections with fake devices and a mocked Supabase backend.
- `supabase/migrations/20261110000000_calls_secret_polls.sql` is the additive
  migration. Apply it before deploying the frontend.
- Test call acceptance, decline, hangup, groups, screen share, permission
  denial, and relay-only ICE with real browsers/devices and your TURN service.
- Test sign-in, reload offline, enqueue, restart, reconnect, and account change.
- The current test suite validates crypto round trips and tamper detection,
  IndexedDB account isolation and expiry, idempotent message retries, and
  browser call/screen-share smoke tests with mocked Supabase traffic. These are
  not a substitute for a real two-device/network/security test.
