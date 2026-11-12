import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * link-preview v1 — SSRF-safe OpenGraph unfurling with DB cache.
 * Contract: POST { url: string } (auth required) -> { preview, contract }
 *   preview: { url, title, description, imageUrl, cached }
 * Guards: http/https only, blocks private/loopback/link-local hosts, 5s
 * timeout, 256KB cap, HTML parsed for og:* tags only (no script execution).
 * Results cached in link_previews (30d TTL via cleanup_v4_retention).
 */

const CONTRACT = "v1";
const MAX_BODY_BYTES = 4 * 1024;
const MAX_HTML_BYTES = 256 * 1024;

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

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^169\.254\./.test(h) || /^fe80:/i.test(h) || /^fc/i.test(h) || /^fd/i.test(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  return false;
}

function extractOg(html: string, pageUrl: string): { title: string; description: string; imageUrl: string | null } {
  const get = (prop: string): string => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
    return (html.match(re)?.[1] ?? html.match(re2)?.[1] ?? "").trim().slice(0, 500);
  };
  const title = get("og:title") || (html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] ?? "").trim();
  const description = get("og:description") || get("description");
  let imageUrl: string | null = get("og:image") || null;
  if (imageUrl) {
    try {
      const u = new URL(imageUrl, pageUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") imageUrl = null;
      else if (isPrivateHost(u.hostname)) imageUrl = null;
      else imageUrl = u.toString().slice(0, 2000);
    } catch {
      imageUrl = null;
    }
  }
  return { title: title.slice(0, 300), description: description.slice(0, 500), imageUrl };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return err("method_not_allowed", "Method not allowed", 405, headers);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return err("unauthorized", "Unauthorized", 401, headers);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return err("invalid_session", "Invalid session", 401, headers);

  let body: { url?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return err("payload_too_large", "Request body too large", 413, headers);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return err("invalid_json", "Invalid JSON", 400, headers);
  }
  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (!rawUrl || rawUrl.length > 2000) return err("invalid_request", "url required (max 2000 chars)", 400, headers);

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return err("invalid_request", "Invalid URL", 400, headers);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return err("invalid_request", "Only http(s) URLs are supported", 400, headers);
  }
  if (isPrivateHost(target.hostname)) {
    return err("forbidden", "Private/internal hosts are not allowed", 403, headers);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const urlHash = await sha256Hex(target.toString());

  const { data: cached } = await admin
    .from("link_previews").select("url, title, description, image_url").eq("url_hash", urlHash).maybeSingle();
  if (cached) {
    return json({ preview: { url: cached.url, title: cached.title, description: cached.description, imageUrl: cached.image_url, cached: true }, contract: CONTRACT }, 200, headers);
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5000);
  try {
    // Do not follow redirects automatically: each hop must be revalidated or
    // an attacker can redirect an innocuous public URL to an internal service.
    let res: Response | null = null;
    let current = target;
    for (let hop = 0; hop < 4; hop += 1) {
      res = await fetch(current.toString(), {
        method: "GET",
        headers: { "User-Agent": "Luma-LinkPreview/1.0 (+https://luma-messenger-chi.vercel.app)", Accept: "text/html" },
        signal: ctrl.signal,
        redirect: "manual",
      });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get("location");
      if (!location || hop === 3) return err("redirect_limit", "Too many redirects", 502, headers);
      current = new URL(location, current);
      if ((current.protocol !== "https:" && current.protocol !== "http:") || isPrivateHost(current.hostname)) {
        return err("forbidden", "Redirect to private/internal host is not allowed", 403, headers);
      }
    }
    if (!res) return err("fetch_failed", "Could not fetch URL", 502, headers);
    if (!res.ok) return err("fetch_failed", `Upstream returned ${res.status}`, 502, headers);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return err("unsupported", "Only HTML pages can be previewed", 415, headers);
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += dec.decode(value, { stream: true });
        if (html.length > MAX_HTML_BYTES) break;
      }
    } else {
      html = (await res.text()).slice(0, MAX_HTML_BYTES);
    }
    const og = extractOg(html.slice(0, MAX_HTML_BYTES), target.toString());
    const preview = { url: target.toString(), title: og.title || target.hostname, description: og.description, imageUrl: og.imageUrl, cached: false };
    await admin.from("link_previews").upsert({
      url_hash: urlHash, url: target.toString(), title: preview.title, description: preview.description, image_url: preview.imageUrl,
    }, { onConflict: "url_hash" });
    return json({ preview, contract: CONTRACT }, 200, headers);
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") return err("timeout", "Preview fetch timed out", 504, headers);
    return err("fetch_failed", "Could not fetch URL", 502, headers);
  } finally {
    clearTimeout(timeout);
  }
});
