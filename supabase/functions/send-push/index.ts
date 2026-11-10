import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * send-push — notify a chat's other participants that a message arrived.
 *
 * Security and privacy decisions (see docs/SECURITY.md):
 *
 *  1. The caller may only send a *notification trigger*, never the content.
 *     Title and body are derived server-side from the referenced message row,
 *     so the endpoint cannot be used to push attacker-authored text to other
 *     users' devices (phishing, "your account is compromised, click here").
 *  2. The caller must be a member of the chat, and the message must belong to
 *     that chat and be authored by the caller.
 *  3. Secret chats (`chats.is_secret`) never produce a push, and any message
 *     whose body carries the E2EE envelope marker is redacted: the server has no
 *     way to read it and must not pretend otherwise.
 *  4. Per-user rate limiting plus per-message deduplication keeps a compromised
 *     or scripted client from using the function as a spam amplifier.
 *  5. Push payloads contain at most a short preview; they never include media
 *     URLs, tokens, key material or the full message body.
 *  6. CORS is an allowlist, not a wildcard.
 */

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
  "https://luma-messenger-chi.vercel.app,https://localhost,capacitor://localhost")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Preview deployments of *this* project only. `*.vercel.app` as a whole would
  // include any attacker-controlled Vercel app.
  return /^https:\/\/luma-messenger(-[a-z0-9]+)*\.vercel\.app$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = isAllowedOrigin(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
    "Content-Type": "application/json",
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

/** Marker used by src/lib/secret.ts for client-side encrypted payloads. */
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
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401, headers);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Invalid session" }, 401, headers);

  let body: { chatId?: string; messageId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, headers);
  }
  // Content supplied by the client is ignored on purpose (see 1. above).
  const legacy = body as { title?: unknown; preview?: unknown };
  if (legacy.title !== undefined || legacy.preview !== undefined) {
    // Accept-and-ignore keeps old clients working without honouring their text.
    console.warn("send-push: ignored client-supplied notification text");
  }
  if (!body.chatId || !body.messageId) {
    return json({ error: "chatId and messageId required" }, 400, headers);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ---- authorization: caller is a member, message is theirs and in this chat
  const { data: membership } = await admin
    .from("chat_participants")
    .select("user_id")
    .eq("chat_id", body.chatId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return json({ error: "Forbidden" }, 403, headers);

  const { data: chat } = await admin
    .from("chats")
    .select("id, kind, is_secret, name")
    .eq("id", body.chatId)
    .maybeSingle();
  if (!chat) return json({ error: "Chat not found" }, 404, headers);
  if (chat.is_secret) {
    // Secret chats are deliberately silent: a push would leak timing and metadata.
    return json({ ok: true, sent: 0, skipped: "secret_chat" }, 200, headers);
  }

  const { data: message } = await admin
    .from("messages")
    .select("id, chat_id, sender_id, body, media_type, created_at")
    .eq("id", body.messageId)
    .maybeSingle();
  if (!message || message.chat_id !== body.chatId) {
    return json({ error: "Message not found in this chat" }, 404, headers);
  }
  if (message.sender_id !== user.id) {
    return json({ error: "Can only notify for your own message" }, 403, headers);
  }

  // ---- abuse control: per-user rate limit and per-message deduplication
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await admin
    .from("push_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", windowStart);
  if ((recent ?? 0) >= 30) {
    return json({ error: "Too many notification requests" }, 429, headers);
  }
  const { error: logErr } = await admin
    .from("push_log")
    .insert({ user_id: user.id, message_id: message.id, chat_id: chat.id });
  if (logErr) {
    // unique(message_id) — a retry of the same message must not notify twice.
    return json({ ok: true, sent: 0, skipped: "duplicate" }, 200, headers);
  }

  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:security@luma.app";
  if (!vapidPublic || !vapidPrivate) {
    return json({ ok: true, sent: 0, configured: false }, 200, headers);
  }

  const nowIso = new Date().toISOString();
  const { data: peers } = await admin
    .from("chat_participants")
    .select("user_id, muted_until")
    .eq("chat_id", body.chatId)
    .neq("user_id", user.id);

  const eligibleIds = (peers ?? [])
    .filter((p) => !p.muted_until || p.muted_until <= nowIso)
    .map((p) => p.user_id);

  if (eligibleIds.length === 0) return json({ ok: true, sent: 0 }, 200, headers);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, user_id")
    .in("user_id", eligibleIds);

  if (!subs || subs.length === 0) return json({ ok: true, sent: 0 }, 200, headers);

  const webpush = await import("npm:web-push@3.6.7");
  webpush.default.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  // Title/body come from the database, never from the request body.
  const title = chat.kind === "channel" ? (chat.name ?? "Luma") : "Luma";
  const bodyText = describe(message.body as string | null, message.media_type as string | null);
  const payloadFor = (userId: string) =>
    JSON.stringify({
      title: String(title).slice(0, 80),
      body: bodyText,
      // The chat id is needed to route the click; it is already known to the
      // recipient because they are a participant.
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
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) expiredIds.push(sub.id);
      }
    })
  );

  if (expiredIds.length > 0) {
    await admin.from("push_subscriptions").delete().in("id", expiredIds);
  }

  return json({ ok: true, sent, pruned: expiredIds.length, configured: true }, 200, headers);
});
