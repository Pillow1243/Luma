import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * health v2 — liveness + DB readiness probe.
 * Contract: GET /health -> { ok, service, db, latencyMs, timestamp, contract }
 * No auth required; never leaks schema details. CORS allowlist only.
 */

const CONTRACT = "v2";

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
    "Content-Type": "application/json",
    "X-Luma-Contract": CONTRACT,
  };
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: { code: "method_not_allowed", message: "Method not allowed" }, contract: CONTRACT }), { status: 405, headers });
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: { code: "misconfigured", message: "Misconfigured environment" }, contract: CONTRACT }), { status: 500, headers });
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
      contract: CONTRACT,
    }),
    { status: error ? 503 : 200, headers }
  );
});
