import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * account-delete v2 — verified self-service account deletion.
 * Contract: POST { password: string, confirmation: "DELETE" }
 *   -> { ok: true, contract: "v2" } | { error: { code, message }, contract }
 * Requires current password (re-auth) + explicit DELETE confirmation.
 * Cleans avatars + chat_media objects owned by the user before deleting the
 * auth user (DB cascades remove rows; storage objects need explicit removal).
 * Never deletes other users' objects: paths are scoped to user.id prefix.
 */

const CONTRACT = "v2";
const MAX_BODY_BYTES = 8 * 1024;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    origin === "https://luma-messenger-chi.vercel.app" ||
    origin === "capacitor://localhost" ||
    origin === "https://localhost" ||
    origin === "http://localhost" ||
    /^https:\/\/luma-messenger(-[a-z0-9]+)*\.vercel\.app$/i.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.e2b\.app$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://luma-messenger-chi.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-luma-contract",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
    "Content-Type": "application/json",
    "X-Luma-Contract": CONTRACT,
  };
}

const err = (code: string, message: string, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify({ error: { code, message }, contract: CONTRACT }), { status, headers });

async function listAllPaths(admin: ReturnType<typeof createClient>, bucket: string, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  let offset = 0;
  const page = 100;
  for (;;) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: page, offset });
    if (error || !data || data.length === 0) break;
    for (const f of data) {
      if (f.id === null) {
        // Folder — recurse one level (chat_media layout is <chat>/<user>/<file>).
        const sub = await listAllPaths(admin, bucket, `${prefix}/${f.name}`);
        paths.push(...sub);
      } else {
        paths.push(`${prefix}/${f.name}`);
      }
    }
    if (data.length < page) break;
    offset += page;
  }
  return paths;
}

Deno.serve(async (req) => {
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
    error: userErr,
  } = await userClient.auth.getUser();

  if (userErr || !user || !user.email) return err("invalid_session", "Invalid session", 401, headers);

  let body: { password?: unknown; confirmation?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return err("payload_too_large", "Request body too large", 413, headers);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return err("invalid_json", "Invalid JSON payload", 400, headers);
  }

  if (typeof body.password !== "string" || !body.password || body.confirmation !== "DELETE") {
    return err("invalid_request", "Current password and DELETE confirmation required", 400, headers);
  }

  const verifyClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { error: signInErr } = await verifyClient.auth.signInWithPassword({
    email: user.email,
    password: body.password,
  });
  if (signInErr) return err("incorrect_password", "Incorrect password", 403, headers);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Best-effort storage cleanup scoped strictly to this user's prefix.
  try {
    const avatarPaths = await listAllPaths(admin, "avatars", user.id);
    for (let i = 0; i < avatarPaths.length; i += 100) {
      const { error } = await admin.storage.from("avatars").remove(avatarPaths.slice(i, i + 100));
      if (error) throw new Error("Could not remove account avatar files");
    }
  } catch {
    return err("storage_cleanup_failed", "Could not safely clean up account files", 503, headers);
  }
  try {
    // Stored message media paths are captured before the auth deletion cascades.
    // Page to completion; never silently delete the account while leaving a
    // partial set of known user-owned objects behind.
    const mediaPaths: string[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("messages")
        .select("media_path")
        .eq("sender_id", user.id)
        .not("media_path", "is", null)
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      mediaPaths.push(...(data ?? []).map((m) => m.media_path as string));
      if (!data || data.length < pageSize) break;
    }
    for (let i = 0; i < mediaPaths.length; i += 100) {
      const { error } = await admin.storage.from("chat_media").remove(mediaPaths.slice(i, i + 100));
      if (error) throw error;
    }
  } catch {
    return err("storage_cleanup_failed", "Could not safely clean up account files", 503, headers);
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) return err("delete_failed", delErr.message, 500, headers);

  console.log(JSON.stringify({ fn: "account-delete", event: "deleted", userId: user.id }));
  return new Response(JSON.stringify({ ok: true, contract: CONTRACT }), { status: 200, headers });
});
