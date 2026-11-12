import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * bot-api v1 — versioned public API for Luma bots.
 *
 * Auth: Authorization: Bearer luma_bot_<48 hex> (raw token, hashed server-side).
 * Scopes: messages:send, messages:read, chats:read (checked per endpoint).
 * Rate limit: 100 req/min per bot (bot_api_logs sliding window).
 * Idempotency: Idempotency-Key header on POST /v1/messages (24h dedup via
 *   messages.id reuse — client supplies UUID, server reconciles).
 * Errors: { error: { code, message }, contract: "v1" } — consistent shape.
 * Pagination: ?limit=&offset= (max 100).
 *
 * Endpoints:
 *   GET  /v1/me                         -> bot identity
 *   GET  /v1/chats                      -> chats the bot owner participates in
 *   GET  /v1/chats/:id/messages         -> paginated messages (member-scoped)
 *   POST /v1/messages {chatId, body, replyTo?} -> send as bot owner (scoped)
 *
 * Bots never gain implicit access to private conversations: every read/write
 * is checked against the bot owner's membership via service-role + explicit
 * membership queries. No arbitrary code execution; this function only
 * reads/writes rows through the same RLS-bypassing admin client with checks.
 */

const CONTRACT = "v1";
const MAX_BODY_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    origin === "https://luma-messenger-chi.vercel.app" ||
    origin === "capacitor://localhost" ||
    origin === "https://localhost" ||
    /^https:\/\/luma-messenger(-[a-z0-9]+)*\.vercel\.app$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://luma-messenger-chi.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-luma-contract, idempotency-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
    "Content-Type": "application/json",
    "X-Luma-Contract": CONTRACT,
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });
const err = (code: string, message: string, status: number, headers: Record<string, string>) =>
  json({ error: { code, message }, contract: CONTRACT }, status, headers);

function parsePagination(url: URL): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? "0") || 0, 0);
  return { limit, offset };
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) return err("misconfigured", "Server misconfigured", 500, headers);

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return err("unauthorized", "Bot token required", 401, headers);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Verify token via RPC (service_role only).
  const { data: verified, error: vErr } = await admin.rpc("verify_bot_token", { p_token: token });
  if (vErr || !verified || verified.length === 0) {
    return err("invalid_token", "Invalid or revoked bot token", 401, headers);
  }
  const { bot_id: botId, owner_id: ownerId, scopes } = verified[0] as {
    bot_id: string; owner_id: string; scopes: string[];
  };
  const hasScope = (s: string) => Array.isArray(scopes) && scopes.includes(s);

  // Rate limit: 100/min per bot.
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await admin
    .from("bot_api_logs")
    .select("id", { count: "exact", head: true })
    .eq("bot_id", botId)
    .gte("created_at", windowStart);
  if ((recent ?? 0) >= 100) return err("rate_limited", "Bot rate limit exceeded (100/min)", 429, headers);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/functions\/v1\/bot-api/, "").replace(/^\/v1/, "/v1");
  const log = async (endpoint: string, status: number) => {
    await admin.from("bot_api_logs").insert({ bot_id: botId, endpoint, status_code: status });
  };

  // GET /v1/me
  if (req.method === "GET" && (path === "/v1/me" || path === "/me")) {
    const { data: bot } = await admin.from("bots").select("id, name, username, description, is_active").eq("id", botId).maybeSingle();
    await log("GET /v1/me", 200);
    return json({ bot, scopes, contract: CONTRACT }, 200, headers);
  }

  // GET /v1/chats
  if (req.method === "GET" && (path === "/v1/chats" || path === "/chats")) {
    if (!hasScope("chats:read")) { await log("GET /v1/chats", 403); return err("forbidden", "Missing scope chats:read", 403, headers); }
    const { limit, offset } = parsePagination(url);
    const { data: memberships } = await admin
      .from("chat_participants").select("chat_id").eq("user_id", ownerId).range(offset, offset + limit - 1);
    const ids = (memberships ?? []).map((m) => m.chat_id);
    const { data: chats } = ids.length
      ? await admin.from("chats").select("id, name, kind, is_group, is_public, created_at").in("id", ids)
      : { data: [] };
    await log("GET /v1/chats", 200);
    return json({ chats: chats ?? [], limit, offset, contract: CONTRACT }, 200, headers);
  }

  // GET /v1/chats/:id/messages
  const chatMsgs = path.match(/^\/v1\/chats\/([0-9a-f-]{36})\/messages$/i) ?? path.match(/^\/chats\/([0-9a-f-]{36})\/messages$/i);
  if (req.method === "GET" && chatMsgs) {
    if (!hasScope("messages:read")) { await log("GET /v1/chats/:id/messages", 403); return err("forbidden", "Missing scope messages:read", 403, headers); }
    const chatId = chatMsgs[1];
    if (!UUID_RE.test(chatId)) return err("invalid_request", "Invalid chat id", 400, headers);
    const { data: member } = await admin.from("chat_participants").select("user_id").eq("chat_id", chatId).eq("user_id", ownerId).maybeSingle();
    if (!member) { await log("GET /v1/chats/:id/messages", 403); return err("forbidden", "Bot owner is not a member of this chat", 403, headers); }
    const { limit, offset } = parsePagination(url);
    const { data: messages } = await admin
      .from("messages").select("id, chat_id, sender_id, body, media_path, media_name, media_type, created_at")
      .eq("chat_id", chatId).is("deleted_at", null)
      .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    await log("GET /v1/chats/:id/messages", 200);
    return json({ messages: messages ?? [], limit, offset, contract: CONTRACT }, 200, headers);
  }

  // POST /v1/messages
  if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
    if (!hasScope("messages:send")) { await log("POST /v1/messages", 403); return err("forbidden", "Missing scope messages:send", 403, headers); }
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) return err("payload_too_large", "Request body too large", 413, headers);
    let body: { chatId?: unknown; body?: unknown; replyTo?: unknown; id?: unknown } = {};
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return err("payload_too_large", "Request body too large", 413, headers);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return err("invalid_json", "Invalid JSON", 400, headers);
    }
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    const text = typeof body.body === "string" ? body.body : "";
    if (!UUID_RE.test(chatId)) return err("invalid_request", "chatId must be a UUID", 400, headers);
    if (!text.trim() || text.length > 16000) return err("invalid_request", "body must be 1-16000 chars", 400, headers);
    const replyTo = typeof body.replyTo === "string" && UUID_RE.test(body.replyTo) ? body.replyTo : null;
    const idemKey = req.headers.get("idempotency-key") ?? (typeof body.id === "string" && UUID_RE.test(body.id) ? body.id : null);

    const { data: member } = await admin.from("chat_participants").select("user_id").eq("chat_id", chatId).eq("user_id", ownerId).maybeSingle();
    if (!member) { await log("POST /v1/messages", 403); return err("forbidden", "Bot owner is not a member of this chat", 403, headers); }

    // Idempotent send: reuse supplied UUID; reconcile on conflict.
    const msgId = idemKey ?? crypto.randomUUID();
    const { data: inserted, error: insErr } = await admin
      .from("messages")
      .insert({ id: msgId, chat_id: chatId, sender_id: ownerId, body: text.slice(0, 16000), reply_to: replyTo })
      .select("id, chat_id, sender_id, body, created_at")
      .single();
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505" && idemKey) {
        const { data: existing } = await admin.from("messages").select("id, chat_id, sender_id, body, created_at").eq("id", msgId).maybeSingle();
        if (existing && existing.sender_id === ownerId && existing.chat_id === chatId) {
          await log("POST /v1/messages", 200);
          return json({ message: existing, deduplicated: true, contract: CONTRACT }, 200, headers);
        }
      }
      await log("POST /v1/messages", 400);
      return err("send_failed", (insErr as { message?: string }).message ?? "Could not send message", 400, headers);
    }

    // Webhook delivery (best-effort, HMAC-signed).
    try {
      const { data: bot } = await admin.from("bots").select("webhook_url, webhook_secret").eq("id", botId).maybeSingle();
      if (bot?.webhook_url && isSafeWebhookUrl(bot.webhook_url)) {
        const payload = JSON.stringify({ event: "message.created", message: inserted });
        const sig = bot.webhook_secret
          ? await hmacHex(bot.webhook_secret, payload)
          : "";
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch(bot.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(sig ? { "X-Luma-Signature": sig } : {}) },
          body: payload,
          signal: ctrl.signal,
          redirect: "error",
        }).catch(() => {});
        clearTimeout(t);
      }
    } catch {
      // Webhook failure must not fail the send.
    }

    await log("POST /v1/messages", 201);
    return json({ message: inserted, contract: CONTRACT }, 201, headers);
  }

  await log(path, 404);
  return err("not_found", "Unknown endpoint", 404, headers);
});

function isSafeWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (u.protocol !== "https:" || u.username || u.password) return false;
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(h)) return false;
    const m = h.match(/^172\.(\d+)\./);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return false;
    return true;
  } catch {
    return false;
  }
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
