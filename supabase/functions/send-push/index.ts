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
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers });
  }

  let body: { chatId?: string; title?: string; preview?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
  }
  if (!body.chatId) {
    return new Response(JSON.stringify({ error: "chatId required" }), { status: 400, headers });
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Confirm caller belongs to this chat
  const { data: membership } = await admin
    .from("chat_participants")
    .select("user_id")
    .eq("chat_id", body.chatId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
  }

  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:security@luma.app";

  if (!vapidPublic || !vapidPrivate) {
    return new Response(
      JSON.stringify({ ok: true, sent: 0, configured: false }),
      { status: 200, headers }
    );
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

  if (eligibleIds.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, configured: true }), {
      status: 200,
      headers,
    });
  }

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", eligibleIds);

  if (!subs || subs.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, configured: true }), {
      status: 200,
      headers,
    });
  }

  const webpush = await import("npm:web-push@3.6.7");
  webpush.default.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const payload = JSON.stringify({
    title: String(body.title ?? "Luma").slice(0, 80),
    body: String(body.preview ?? "New message").slice(0, 140),
    url: `/chat/${body.chatId}`,
  });

  let sent = 0;
  const expiredIds: string[] = [];
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.default.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        );
        sent += 1;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          expiredIds.push(sub.id);
        }
      }
    })
  );

  if (expiredIds.length > 0) {
    await admin.from("push_subscriptions").delete().in("id", expiredIds);
  }

  return new Response(
    JSON.stringify({ ok: true, sent, pruned: expiredIds.length, configured: true }),
    { status: 200, headers }
  );
});
