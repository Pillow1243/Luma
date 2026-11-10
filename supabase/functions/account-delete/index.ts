import { createClient } from "jsr:@supabase/supabase-js@2";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed =
    origin === "https://luma-messenger-chi.vercel.app" ||
    origin === "capacitor://localhost" ||
    origin === "https://localhost" ||
    origin === "http://localhost" ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.e2b\.app$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://luma-messenger-chi.vercel.app",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";

  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();

  if (userErr || !user || !user.email) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers });
  }

  let body: { password?: string; confirmation?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON payload" }), { status: 400, headers });
  }

  if (!body.password || body.confirmation !== "DELETE") {
    return new Response(
      JSON.stringify({ error: "Current password and DELETE confirmation required" }),
      { status: 400, headers }
    );
  }

  // Verify current password before irreversible account deletion
  const verifyClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { error: signInErr } = await verifyClient.auth.signInWithPassword({
    email: user.email,
    password: body.password,
  });
  if (signInErr) {
    return new Response(JSON.stringify({ error: "Incorrect password" }), { status: 403, headers });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Best-effort cleanup of user avatars folder
  try {
    const { data: avatarFiles } = await admin.storage.from("avatars").list(user.id, { limit: 100 });
    if (avatarFiles && avatarFiles.length > 0) {
      await admin.storage
        .from("avatars")
        .remove(avatarFiles.map((f) => `${user.id}/${f.name}`));
    }
  } catch {
    // non-fatal
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) {
    return new Response(JSON.stringify({ error: delErr.message }), { status: 500, headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});
