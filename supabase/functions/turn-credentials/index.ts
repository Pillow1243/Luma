import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * turn-credentials v2 — short-lived ICE/TURN credentials for authenticated users.
 * Contract: POST (auth required) -> { iceServers, ttl, source, contract }
 * Falls back to STUN-only when no TURN provider is configured. Never embeds
 * static TURN secrets in the client bundle; static secrets live only here.
 * External provider calls are bounded to 5s via AbortController.
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

const DEFAULT_STUN = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

async function fetchWithTimeout(url: string, init: RequestInit, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" }, contract: CONTRACT }), { status: 401, headers });
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
    return new Response(JSON.stringify({ error: { code: "invalid_session", message: "Invalid session" }, contract: CONTRACT }), { status: 401, headers });
  }

  // Option 1: Cloudflare Calls ephemeral TURN credentials
  const cfTokenId = Deno.env.get("CF_TURN_TOKEN_ID");
  const cfApiToken = Deno.env.get("CF_TURN_API_TOKEN");
  if (cfTokenId && cfApiToken) {
    try {
      const res = await fetchWithTimeout(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${cfTokenId}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 3600 }),
        }
      );
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.iceServers)) {
          return new Response(
            JSON.stringify({ iceServers: json.iceServers, ttl: 3600, source: "cloudflare-ephemeral", contract: CONTRACT }),
            { status: 200, headers }
          );
        }
      }
    } catch {
      // fall through
    }
  }

  // Option 2: Metered dynamic TURN credentials
  const meteredDomain = Deno.env.get("METERED_DOMAIN");
  const meteredKey = Deno.env.get("METERED_API_KEY");
  if (meteredDomain && meteredKey) {
    try {
      const res = await fetchWithTimeout(
        `https://${meteredDomain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredKey)}`,
        {}
      );
      if (res.ok) {
        const iceServers = await res.json();
        if (Array.isArray(iceServers)) {
          return new Response(
            JSON.stringify({ iceServers, ttl: 3600, source: "metered-ephemeral", contract: CONTRACT }),
            { status: 200, headers }
          );
        }
      }
    } catch {
      // fall through
    }
  }

  // Option 3: Server-managed static TURN secrets (never exposed in client bundle)
  const turnUrls = Deno.env.get("TURN_URLS");
  const turnUser = Deno.env.get("TURN_USERNAME");
  const turnCred = Deno.env.get("TURN_CREDENTIAL");
  if (turnUrls && turnUser && turnCred) {
    return new Response(
      JSON.stringify({
        iceServers: [
          ...DEFAULT_STUN,
          {
            urls: turnUrls.split(",").map((s) => s.trim()).filter(Boolean),
            username: turnUser,
            credential: turnCred,
          },
        ],
        ttl: 3600,
        source: "server-turn",
        contract: CONTRACT,
      }),
      { status: 200, headers }
    );
  }

  return new Response(
    JSON.stringify({ iceServers: DEFAULT_STUN, ttl: 3600, source: "stun-only", contract: CONTRACT }),
    { status: 200, headers }
  );
});
