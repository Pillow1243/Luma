# Luma Bot API v1 (implementation status: code present, not deployed)

This document describes the first HTTP API implemented by `supabase/functions/bot-api` and the database objects in migration `20261112000000_luma_v4_privacy_scheduling_bots.sql`. Production deployment is intentionally blocked until schema drift has been reconciled, migration replay/security tests pass, and a verified restore point or isolated staging project is available.

## Authentication and scopes

Send a bot token as `Authorization: Bearer luma_bot_<48 lowercase hex characters>`. Raw tokens are returned only at creation/rotation; the database stores SHA-256 hashes. Revoke exposed tokens immediately. Current scopes are:

- `chats:read`
- `messages:read`
- `messages:send`

Scopes are deny-by-default. The API also checks that the bot owner's account remains a participant of each requested chat. A bot does not inherit a user's membership or administrative role beyond that explicit owner-membership check and cannot alter roles or membership.

## Routes

Base path is `/functions/v1/bot-api/v1`:

- `GET /me`
- `GET /chats?limit=50&offset=0`
- `GET /chats/{chatId}/messages?limit=50&offset=0`
- `POST /messages` with JSON `{ "chatId": "<uuid>", "body": "...", "replyTo": "<uuid>" }`

Pagination is offset-based, with `limit` clamped to 1–100. Message sends accept `Idempotency-Key` (UUID); repeated requests return the original message only when it belongs to the same chat and sender. Requests have bounded size and message text length.

## Errors and rate limits

Errors use `{ "error": { "code": "...", "message": "..." }, "contract": "v1" }`. Current implementation targets 100 API requests per bot per minute. A production-grade atomic rate-limit RPC, webhook retry queue, and persistent idempotency record are not yet implemented; the current log-count limiter and best-effort webhook callback are not suitable for high-volume/public production traffic.

Webhook callbacks, when configured, are HTTPS-only, HMAC-SHA256 signed in `X-Luma-Signature`, time-bounded, and do not follow redirects. DNS-rebinding and outbound-egress protections require infrastructure-level controls before enabling untrusted bot webhook destinations in production.

## Versioning and deprecation

`v1` is the initial contract. Breaking behavior requires a new path version (`v2`), with a published sunset date and migration guide. Additive fields may be introduced within a version. This API is not yet a stable public SLA.
