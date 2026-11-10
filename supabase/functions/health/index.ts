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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: "Misconfigured environment" }), {
      status: 500,
      headers,
    });
  }

  const started = performance.now();
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { error } = await admin.from("profiles").select("id", { count: "exact", head: true });
  const latencyMs = Math.round(performance.now() - started);

  return new Response(
    JSON.stringify({
      ok: !error,
      service: "luma-edge",
      db: error ? "degraded" : "healthy",
      latencyMs,
      timestamp: new Date().toISOString(),
    }),
    { status: error ? 503 : 200, headers }
  );
});
