import { createClient } from "@supabase/supabase-js";

const url = import.meta.env?.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !key) {
  // Surfaced in the UI instead of a blank white screen.
  console.error(
    "[Luma] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY environment variables."
  );
}

export const SUPABASE_URL = url ?? "";
export const SUPABASE_ANON_KEY = key ?? "";
export const isSupabaseConfigured = Boolean(url && key);

// Keep the client constructible when configuration is absent so the app can
// render ConfigMissing instead of throwing during module initialization.
export const supabase = createClient(SUPABASE_URL || "https://missing-config.invalid", SUPABASE_ANON_KEY || "missing-config", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Native (Capacitor) builds run from capacitor://localhost — keep the
    // session in localStorage so it survives app restarts.
    storageKey: "luma-auth",
    flowType: "pkce",
  },
  realtime: {
    params: { eventsPerSecond: 20 },
  },
  global: {
    headers: { "x-client-info": "luma-web/1.0.0" },
  },
});

/** Public URL helper for a private-bucket object (signed URLs handled elsewhere). */
export const BUCKET_AVATARS = "avatars";
export const BUCKET_MEDIA = "chat_media";
