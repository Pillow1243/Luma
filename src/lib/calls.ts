import { supabase } from "./supabase";
import type { CallRecord } from "./types";

/** Open Relay's public example credentials are best-effort only. Set your own
 * free Metered/Open Relay credentials for a real deployment; for production,
 * prefer short-lived credentials issued by a backend rather than a static key. */
export function iceServers(): RTCIceServer[] {
  const urls = (import.meta.env?.VITE_TURN_URLS as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean)
    ?? ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443?transport=tcp"];
  return [
    { urls: ["stun:stun.l.google.com:19302", "stun:openrelay.metered.ca:80"] },
    { urls, username: (import.meta.env?.VITE_TURN_USERNAME as string | undefined) || "openrelayproject", credential: (import.meta.env?.VITE_TURN_CREDENTIAL as string | undefined) || "openrelayproject" },
  ];
}
export const hasOwnTurnCredentials = Boolean(import.meta.env?.VITE_TURN_USERNAME && import.meta.env?.VITE_TURN_CREDENTIAL);

/** Prefer the transceiver actually bound to a negotiated SDP media section.
 * An answerer can also have an unassociated transceiver with a null MID; a
 * track placed there will not reach the other participant without negotiation.
 */
export function videoTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
  const videos = pc.getTransceivers().filter((t) => t.sender.track?.kind === "video" || t.receiver.track.kind === "video");
  return videos.find((t) => t.mid !== null) ?? videos[0];
}

export async function listCalls(chatId: string): Promise<CallRecord[]> {
  const { data, error } = await supabase.from("calls").select("*").eq("chat_id", chatId).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as CallRecord[];
}
