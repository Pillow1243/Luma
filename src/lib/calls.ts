import { supabase } from "./supabase";
import type { CallRecord } from "./types";

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

/** Synchronous ICE fallback: public STUN + optional build-time TURN env vars.
 * Never embeds hardcoded third-party example TURN credentials. */
export function iceServers(): RTCIceServer[] {
  const urls = (import.meta.env?.VITE_TURN_URLS as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const username = import.meta.env?.VITE_TURN_USERNAME as string | undefined;
  const credential = import.meta.env?.VITE_TURN_CREDENTIAL as string | undefined;

  if (urls?.length && username && credential) {
    return [...DEFAULT_STUN_SERVERS, { urls, username, credential }];
  }
  return DEFAULT_STUN_SERVERS;
}

export const hasOwnTurnCredentials = Boolean(
  import.meta.env?.VITE_TURN_URLS &&
    import.meta.env?.VITE_TURN_USERNAME &&
    import.meta.env?.VITE_TURN_CREDENTIAL
);

let cachedIce: { servers: RTCIceServer[]; source: string; expires: number } | null = null;

/** Fetches short-lived TURN credentials from the authenticated `turn-credentials`
 * Supabase Edge Function when available, caching for 30 minutes. */
export async function fetchIceServers(): Promise<{ servers: RTCIceServer[]; source: string }> {
  if (cachedIce && cachedIce.expires > Date.now()) {
    return { servers: cachedIce.servers, source: cachedIce.source };
  }
  try {
    const { data, error } = await supabase.functions.invoke<{
      iceServers?: RTCIceServer[];
      source?: string;
    }>("turn-credentials");
    if (!error && Array.isArray(data?.iceServers) && data.iceServers.length > 0) {
      const source = data.source ?? "edge";
      cachedIce = {
        servers: data.iceServers,
        source,
        expires: Date.now() + 30 * 60_000,
      };
      return { servers: data.iceServers, source };
    }
  } catch {
    // Offline or edge unavailable — fall back cleanly
  }
  const fallback = iceServers();
  return {
    servers: fallback,
    source: hasOwnTurnCredentials ? "env-turn" : "stun-only",
  };
}

/** Prefer the transceiver actually bound to a negotiated SDP media section.
 * An answerer can also have an unassociated transceiver with a null MID; a
 * track placed there will not reach the other participant without negotiation.
 */
export function videoTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
  const videos = pc
    .getTransceivers()
    .filter((t) => t.sender.track?.kind === "video" || t.receiver.track.kind === "video");
  return videos.find((t) => t.mid !== null) ?? videos[0];
}

export async function listCalls(chatId: string): Promise<CallRecord[]> {
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as CallRecord[];
}
