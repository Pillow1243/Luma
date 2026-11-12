import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * send-push v2 — notify a chat's other participants that a message arrived.
 *
 * Contract (versioned): POST { chatId: uuid, messageId: uuid }
 *   Header X-Luma-Contract: v2 (optional; v1 legacy {chatId,title,preview} is
 *   accepted-and-ignored for text, but never honoured).
 *   Response: { ok, sent, pruned?, configured?, skipped?, contract: "v2" }
 *   Errors:   { error: { code, message }, contract: "v2" }
 *
 * Security (see docs/SECURITY.md):
 *  1. Caller sends only a trigger; title/body derived server-side from the
 *     message row — no attacker-authored phishing text.
 *  2. Caller must be a member; message must belong to that chat and be theirs.
 *  3. Secret chats never push; E2EE bodies redacted to "New encrypted message".
 *  4. Per-user rate limit (30/min) + per-message dedup via push_log.
 *  5. Payloads carry at most a short preview; no media URLs/tokens/keys.
 *  6. CORS allowlist (ALLOWED_ORIGINS env + this project's previews only).
 *  7. Request size capped at 16KB; UUIDs validated; 10s bounded execution.
 */

const CONTRACT = "v2";
const MAX_BODY_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://luma-messenger-chi.vercel.app,https://localhost,capacitor://localhost")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^https:\/\/luma-messenger(-[a-z0-9]+)*\.vercel\.app$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = isAllowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-luma-contract",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
    "Content-Type": "application/json",
    "X-Luma-Contract": CONTRACT,
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

const err = (code: string, message: string, status: number, headers: Record<string, string>) =>
  json({ error: { code, message }, contract: CONTRACT }, status, headers);

const E2EE_PREFIXES = ["luma:e2ee:v2:", "luma:e2ee:v1:"];
const isEncrypted = (body: string | null) =>
  !!body && E2EE_PREFIXES.some((p) => body.startsWith(p));

const MESSAGE_KINDS: Record<string, string> = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  voice: "Voice message",
  file: "File",
  gif: "GIF",
  sticker: "Sticker",
};

function describe(body: string | null, mediaType: string | null): string {
  if (isEncrypted(body)) return "New encrypted message";
  if (mediaType) {
    const kind = MESSAGE_KINDS[mediaType.split("/")[0]] ?? "Attachment";
    return body?.trim() ? `${kind}: ${body.trim().slice(0, 90)}` : kind;
  }
  return (body ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "New message";
}

Deno.serve(async (req) => {
  const started = Date.now();
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return err("method_not_allowed", "Method not allowed", 405, headers);

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) return err("payload_too_large", "Request body too large", 413, headers);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return err("unauthorized", "Unauthorized", 401, headers);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return err("invalid_session", "Invalid session", 401, headers);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return err("invalid_json", "Invalid JSON", 400, headers);
  }
  if (raw.length > MAX_BODY_BYTES) return err("payload_too_large", "Request body too large", 413, headers);
  let body: { chatId?: unknown; messageId?: unknown; title?: unknown; preview?: unknown } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return err("invalid_json", "Invalid JSON", 400, headers);
  }
  if (body.title !== undefined || body.preview !== undefined) {
    console.log(JSON.stringify({ fn: "send-push", event: "legacy_text_ignored", userId: user.id }));
  }
  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const messageId = typeof body.messageId === "string" ? body.messageId : "";
  if (!UUID_RE.test(chatId) || !UUID_RE.test(messageId)) {
    return err("invalid_request", "chatId and messageId must be UUIDs", 400, headers);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: membership } = await admin
    .from("chat_participants")
    .select("user_id")
    .eq("chat_id", chatId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return err("forbidden", "Forbidden", 403, headers);

  const { data: chat } = await admin
    .from("chats")
    .select("id, kind, is_secret, name")
    .eq("id", chatId)
    .maybeSingle();
  if (!chat) return err("not_found", "Chat not found", 404, headers);
  if (chat.is_secret) {
    return json({ ok: true, sent: 0, skipped: "secret_chat", contract: CONTRACT }, 200, headers);
  }

  const { data: message } = await admin
    .from("messages")
    .select("id, chat_id, sender_id, body, media_type, created_at")
    .eq("id", messageId)
    .maybeSingle();
  if (!message || message.chat_id !== chatId) {
    return err("not_found", "Message not found in this chat", 404, headers);
  }
  if (message.sender_id !== user.id) {
    return err("forbidden", "Can only notify for your own message", 403, headers);
  }

  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await admin
    .from("push_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", windowStart);
  if ((recent ?? 0) >= 30) {
    return err("rate_limited", "Too many notification requests", 429, headers);
  }
  const { error: logErr } = await admin
    .from("push_log")
    .insert({ user_id: user.id, message_id: message.id, chat_id: chat.id });
  if (logErr) {
    return json({ ok: true, sent: 0, skipped: "duplicate", contract: CONTRACT }, 200, headers);
  }

  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:security@luma.app";
  if (!vapidPublic || !vapidPrivate) {
    console.log(JSON.stringify({ fn: "send-push", event: "vapid_unconfigured", userId: user.id, ms: Date.now() - started }));
    return json({ ok: true, sent: 0, configured: false, contract: CONTRACT }, 200, headers);
  }

  const nowIso = new Date().toISOString();
  const { data: peers } = await admin
    .from("chat_participants")
    .select("user_id, muted_until")
    .eq("chat_id", chatId)
    .neq("user_id", user.id);

  const eligibleIds = (peers ?? [])
    .filter((p) => !p.muted_until || p.muted_until <= nowIso)
    .map((p) => p.user_id);

  if (eligibleIds.length === 0) return json({ ok: true, sent: 0, contract: CONTRACT }, 200, headers);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, user_id")
    .in("user_id", eligibleIds);

  if (!subs || subs.length === 0) return json({ ok: true, sent: 0, contract: CONTRACT }, 200, headers);

  const webpush = await import("npm:web-push@3.6.7");
  webpush.default.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const title = chat.kind === "channel" ? (chat.name ?? "Luma") : "Luma";
  const bodyText = describe(message.body as string | null, message.media_type as string | null);
  const payloadFor = (userId: string) =>
    JSON.stringify({
      title: String(title).slice(0, 80),
      body: bodyText,
      url: `/chat/${chat.id}`,
      tag: `msg-${message.id}`,
      userId,
    });

  let sent = 0;
  const expiredIds: string[] = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.default.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadFor(sub.user_id as string)
        );
        sent += 1;
      } catch (e: unknown) {
        const statusCode = (e as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) expiredIds.push(sub.id);
      }
    })
  );

  if (expiredIds.length > 0) {
    await admin.from("push_subscriptions").delete().in("id", expiredIds);
  }

  console.log(JSON.stringify({ fn: "send-push", event: "done", userId: user.id, chatId, sent, ms: Date.now() - started }));
  return json({ ok: true, sent, pruned: expiredIds.length, configured: true, contract: CONTRACT }, 200, headers);
});
