import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { iceServers, videoTransceiver } from "../lib/calls";
import { fetchProfile } from "../lib/data";
import type { CallParticipant, CallRecord, CallSignal, ChatSummary, Profile } from "../lib/types";
import { useAuth } from "./AuthContext";
import { useToast } from "./ToastContext";
import { CallOverlay } from "../components/CallOverlay";

type Incoming = { call: CallRecord; caller: Profile | null };
type CallView = {
  call: CallRecord;
  title: string;
  phase: "calling" | "connecting" | "active";
  local: MediaStream;
  remote: { userId: string; stream: MediaStream; name: string }[];
  muted: boolean;
  cameraOff: boolean;
  sharing: boolean;
};
type Session = {
  call: CallRecord; local: MediaStream; channel: RealtimeChannel | null;
  peers: Map<string, RTCPeerConnection>; remote: Map<string, MediaStream>;
  names: Map<string, string>; pendingIce: Map<string, RTCIceCandidateInit[]>;
  seen: Set<string>; chains: Map<string, Promise<void>>;
  screen: MediaStream | null; closed: boolean; timer: number | null; offerers: Set<string>; restarting: Set<string>;
  participantSyncVersion: number; participantSyncApplied: number;
};
type CallCtx = { startCall: (chat: ChatSummary, kind: "audio" | "video") => Promise<void>; busy: boolean };
const Ctx = createContext<CallCtx | null>(null);

function describeError(error: unknown) {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Allow microphone and camera access to make a call.";
  if (name === "NotFoundError") return "No microphone or camera was found.";
  return (error as { message?: string })?.message || "Could not connect the call.";
}
function media(kind: "audio" | "video") {
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("Calling requires a secure browser with WebRTC support.");
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: kind === "video" });
}
function titleFor(summary: ChatSummary, me: string) {
  return summary.chat.kind === "group" ? summary.chat.name || "Group call" : summary.participants.find((p) => p.id !== me)?.display_name || "Direct call";
}
function waitForSubscription(channel: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => { if (!settled) { settled = true; reject(new Error("Call signaling timed out. Check your connection.")); } }, 12000);
    channel.subscribe((status) => {
      if (settled) return;
      if (status === "SUBSCRIBED") { settled = true; clearTimeout(timeout); resolve(); }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { settled = true; clearTimeout(timeout); reject(new Error("Call signaling is unavailable.")); }
    });
  });
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const me = user?.id;
  const toast = useToast();
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [view, setView] = useState<CallView | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const incomingRef = useRef<Incoming | null>(null);
  const starting = useRef(false);
  const ending = useRef(false);
  const setInvitation = useCallback((value: Incoming | null) => { incomingRef.current = value; setIncoming(value); }, []);

  const cleanup = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s) {
      s.closed = true;
      if (s.timer) window.clearTimeout(s.timer);
      s.peers.forEach((p) => p.close());
      s.screen?.getTracks().forEach((t) => t.stop());
      s.local.getTracks().forEach((t) => t.stop());
      if (s.channel) void supabase.removeChannel(s.channel);
    }
    setView(null); setBusy(false); starting.current = false;
  }, []);
  const leave = useCallback(async () => {
    if (ending.current) return;
    ending.current = true;
    const id = sessionRef.current?.call.id;
    cleanup();
    if (id) await supabase.rpc("leave_luma_call", { call_uuid: id });
    ending.current = false;
  }, [cleanup]);

  const sendSignal = useCallback(async (s: Session, target: string, kind: CallSignal["kind"], payload: object) => {
    if (!me || s.closed) return;
    // Reuse the ID if a response is lost after insertion: Realtime and the
    // backlog may deliver it more than once, but the receiver's seen set will
    // process it only once even if it already deleted the original row.
    const id = crypto.randomUUID();
    let lastError: { message?: string; code?: string } | null = null;
    for (let attempt = 0; attempt < 3 && !s.closed; attempt++) {
      const { error } = await supabase.from("call_signals").insert({ id, call_id: s.call.id, from_user: me, to_user: target, kind, payload });
      if (!error || error.code === "23505") return;
      lastError = error;
      if (/^(22|23|28|42|P0001)/.test(error.code || "")) break;
      await new Promise((resolve) => window.setTimeout(resolve, 300 * 2 ** attempt));
    }
    if (lastError && !s.closed) console.warn("[Luma] signaling failed", lastError.message);
  }, [me]);
  const publishRemote = useCallback((s: Session) => {
    if (s.closed || sessionRef.current !== s) return;
    setView((v) => v ? { ...v, remote: [...s.remote].map(([userId, stream]) => ({ userId, stream, name: s.names.get(userId) || "Participant" })), phase: s.remote.size ? "active" : v.phase } : v);
  }, []);
  const createPeer = useCallback((s: Session, other: string, willOffer = false) => {
    const existing = s.peers.get(other);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    s.peers.set(other, pc);
    for (const track of s.local.getAudioTracks()) pc.addTrack(track, s.local);
    const video = s.screen?.getVideoTracks()[0] ?? s.local.getVideoTracks()[0];
    if (video) pc.addTrack(video, s.screen ?? s.local);
    // Only the offerer creates a spare video media section for an audio call.
    // On the answering side the remote offer creates the associated section;
    // an eagerly-added transceiver would remain unassociated (MID is null).
    else if (willOffer) pc.addTransceiver("video", { direction: "sendrecv" });
    pc.onicecandidate = (e) => { if (e.candidate) void sendSignal(s, other, "ice", e.candidate.toJSON()); };
    pc.ontrack = (e) => {
      let stream = s.remote.get(other);
      if (!stream) { stream = new MediaStream(); s.remote.set(other, stream); }
      if (!stream.getTracks().some((t) => t.id === e.track.id)) stream.addTrack(e.track);
      e.track.onended = () => { stream?.removeTrack(e.track); publishRemote(s); };
      publishRemote(s);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        // The original offerer negotiates an ICE restart, avoiding glare.
        setView((v) => v ? { ...v, phase: "connecting" } : v);
        if (s.offerers.has(other) && !s.restarting.has(other) && pc.signalingState === "stable") {
          s.restarting.add(other);
          void (async () => {
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              await sendSignal(s, other, "offer", pc.localDescription?.toJSON() ?? offer);
            } catch (error) { console.warn("[Luma] ICE restart failed", error); }
            finally { window.setTimeout(() => s.restarting.delete(other), 5000); }
          })();
        }
      }
      if (pc.connectionState === "connected") setView((v) => v ? { ...v, phase: "active" } : v);
    };
    return pc;
  }, [publishRemote, sendSignal]);

  const handleSignal = useCallback(async (s: Session, signal: CallSignal) => {
    if (s.closed || !me || signal.call_id !== s.call.id || signal.to_user !== me || s.seen.has(signal.id)) return;
    s.seen.add(signal.id);
    const previous = s.chains.get(signal.from_user) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      if (s.closed) return;
      const pc = createPeer(s, signal.from_user);
      if (signal.kind === "ice") {
        const candidate = signal.payload as RTCIceCandidateInit;
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else s.pendingIce.set(signal.from_user, [...(s.pendingIce.get(signal.from_user) ?? []), candidate]);
      } else {
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        if (signal.kind === "offer") {
          // Keep the negotiated video m-line bidirectional even for an audio
          // call, so either participant can later share without renegotiation.
          const video = videoTransceiver(pc);
          if (video) {
            video.direction = "sendrecv";
            const track = s.screen?.getVideoTracks()[0] ?? s.local.getVideoTracks()[0] ?? null;
            if (video.sender.track !== track) await video.sender.replaceTrack(track);
          }
        }
        for (const candidate of s.pendingIce.get(signal.from_user) ?? []) await pc.addIceCandidate(candidate).catch(() => {});
        s.pendingIce.delete(signal.from_user);
        if (signal.kind === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await sendSignal(s, signal.from_user, "answer", pc.localDescription?.toJSON() ?? answer);
        }
      }
      await supabase.from("call_signals").delete().eq("id", signal.id);
    });
    s.chains.set(signal.from_user, work);
    try { await work; } catch (err) { console.warn("[Luma] could not process call signal", err); }
  }, [createPeer, me, sendSignal]);

  const syncParticipants = useCallback(async (s: Session) => {
    if (!me || s.closed) return;
    const version = ++s.participantSyncVersion;
    const { data, error } = await supabase.from("call_participants").select("*").eq("call_id", s.call.id);
    // Realtime updates can launch overlapping queries; a slow older response
    // must not overwrite the newer participant state already applied.
    if (error || s.closed || version < s.participantSyncApplied) return;
    s.participantSyncApplied = version;
    const participants = (data ?? []) as CallParticipant[];
    const self = participants.find((p) => p.user_id === me && p.status === "joined");
    if (!self?.joined_at) return;
    for (const other of participants) {
      if (s.closed || version !== s.participantSyncApplied) return;
      if (other.user_id === me) continue;
      // A ringing snapshot may have been taken before this person accepted,
      // even if their offer/ICE has already arrived. Only terminal states
      // prove an existing peer should be closed.
      if (other.status === "ringing") continue;
      if (other.status !== "joined") {
        const pc = s.peers.get(other.user_id);
        if (pc) { pc.close(); s.peers.delete(other.user_id); s.remote.delete(other.user_id); publishRemote(s); }
        continue;
      }
      if (!s.names.has(other.user_id)) {
        const p = await fetchProfile(other.user_id).catch(() => null);
        if (s.closed || version !== s.participantSyncApplied) return;
        if (p) s.names.set(other.user_id, p.display_name);
      }
      // Earlier joiner creates the offer. Stable ordering avoids offer glare,
      // including when two group members accept at nearly the same instant.
      const earlier = `${self.joined_at}:${me}` < `${other.joined_at}:${other.user_id}`;
      if (earlier && !s.peers.has(other.user_id) && !s.closed) {
        const pc = createPeer(s, other.user_id, true);
        s.offerers.add(other.user_id);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal(s, other.user_id, "offer", pc.localDescription?.toJSON() ?? offer);
        } catch (error) { console.warn("[Luma] call offer failed", error); }
      }
    }
  }, [createPeer, me, publishRemote, sendSignal]);

  const connectSession = useCallback(async (s: Session) => {
    if (!me) throw new Error("Sign in to call");
    const channel = supabase.channel(`luma:call:${s.call.id}:${me}:${crypto.randomUUID()}`);
    s.channel = channel;
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "call_signals", filter: `to_user=eq.${me}` }, (event) => { void handleSignal(s, event.new as CallSignal); })
      .on("postgres_changes", { event: "*", schema: "public", table: "call_participants", filter: `call_id=eq.${s.call.id}` }, () => { void syncParticipants(s); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "calls", filter: `id=eq.${s.call.id}` }, (event) => {
        const call = event.new as CallRecord;
        if (call.status === "ended" && sessionRef.current === s) { cleanup(); toast.push("Call ended", "info"); }
        else if (call.status === "active") setView((v) => v ? { ...v, call, phase: v.remote.length ? "active" : "connecting" } : v);
      });
    await waitForSubscription(channel);
    if (s.closed) throw new Error("Call ended");
    const { data } = await supabase.from("call_signals").select("*").eq("call_id", s.call.id).eq("to_user", me).order("created_at");
    for (const signal of (data ?? []) as CallSignal[]) void handleSignal(s, signal);
  }, [cleanup, handleSignal, me, syncParticipants, toast]);

  const makeSession = useCallback((call: CallRecord, stream: MediaStream, title: string): Session => {
    const s: Session = { call, local: stream, channel: null, peers: new Map(), remote: new Map(), names: new Map(), pendingIce: new Map(), seen: new Set(), chains: new Map(), screen: null, closed: false, timer: null, offerers: new Set(), restarting: new Set(), participantSyncVersion: 0, participantSyncApplied: 0 };
    sessionRef.current = s;
    setView({ call, title, phase: "calling", local: stream, remote: [], muted: false, cameraOff: call.kind !== "video", sharing: false });
    setBusy(true);
    return s;
  }, []);

  const startCall = useCallback(async (summary: ChatSummary, kind: "audio" | "video") => {
    if (!me || sessionRef.current || incomingRef.current || starting.current) { toast.push("You are already in a call", "info"); return; }
    if (!navigator.onLine) { toast.push("Connect to the internet to call", "error"); return; }
    if (summary.participants.length < 2 || summary.participants.length > 6) { toast.push("Calls support 2 to 6 chat members", "error"); return; }
    starting.current = true; setBusy(true);
    let stream: MediaStream | null = null;
    let s: Session | null = null;
    try {
      stream = await media(kind);
      const { data, error } = await supabase.rpc("start_luma_call", { cid: summary.chat.id, call_kind: kind });
      if (error) throw error;
      s = makeSession(data as CallRecord, stream, titleFor(summary, me));
      summary.participants.forEach((p) => s?.names.set(p.id, p.display_name));
      await connectSession(s);
      await syncParticipants(s);
      s.timer = window.setTimeout(() => {
        if (!s?.closed && s?.remote.size === 0) { toast.push("No answer", "info"); void leave(); }
      }, 45000);
    } catch (error) {
      if (s) { await supabase.rpc("leave_luma_call", { call_uuid: s.call.id }); cleanup(); }
      else { stream?.getTracks().forEach((t) => t.stop()); setBusy(false); }
      toast.push(describeError(error), "error");
    } finally { starting.current = false; }
  }, [me, toast, makeSession, connectSession, syncParticipants, leave, cleanup]);

  const accept = useCallback(async () => {
    const invite = incomingRef.current;
    if (!me || !invite || starting.current) return;
    starting.current = true; setBusy(true);
    let stream: MediaStream | null = null;
    let s: Session | null = null;
    try {
      stream = await media(invite.call.kind);
      s = makeSession(invite.call, stream, invite.caller?.display_name || "Incoming call");
      if (invite.caller) s.names.set(invite.caller.id, invite.caller.display_name);
      setInvitation(null);
      // Listen before responding so the first offer/ICE cannot be missed.
      await connectSession(s);
      const { error } = await supabase.rpc("respond_luma_call", { call_uuid: invite.call.id, accept_call: true });
      if (error) throw error;
      setView((v) => v ? { ...v, phase: "connecting" } : v);
      await syncParticipants(s);
    } catch (error) {
      if (s) { await supabase.rpc("leave_luma_call", { call_uuid: s.call.id }); cleanup(); }
      else { stream?.getTracks().forEach((t) => t.stop()); setBusy(false); }
      setInvitation(null); toast.push(describeError(error), "error");
    } finally { starting.current = false; }
  }, [me, makeSession, connectSession, syncParticipants, cleanup, setInvitation, toast]);
  const decline = useCallback(async () => {
    const invite = incomingRef.current;
    setInvitation(null);
    if (invite) await supabase.rpc("respond_luma_call", { call_uuid: invite.call.id, accept_call: false });
  }, [setInvitation]);

  useEffect(() => {
    if (!me) { cleanup(); setInvitation(null); return; }
    let alive = true;
    const checkInvite = async (row: CallParticipant) => {
      if (!alive || row.user_id !== me || row.status !== "ringing") return;
      const { data } = await supabase.from("calls").select("*").eq("id", row.call_id).maybeSingle();
      const call = data as CallRecord | null;
      if (!alive || !call || call.status === "ended" || Date.now() - Date.parse(call.created_at) > 45000) return;
      if (sessionRef.current || starting.current || (incomingRef.current && incomingRef.current.call.id !== call.id)) {
        await supabase.rpc("respond_luma_call", { call_uuid: call.id, accept_call: false }); return;
      }
      const caller = await fetchProfile(call.started_by).catch(() => null);
      if (alive && !sessionRef.current) setInvitation({ call, caller });
    };
    const channel = supabase.channel(`luma:incoming:${me}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "call_participants", filter: `user_id=eq.${me}` }, (event) => { void checkInvite(event.new as CallParticipant); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "call_participants", filter: `user_id=eq.${me}` }, (event) => {
        const row = event.new as CallParticipant;
        if (incomingRef.current?.call.id === row.call_id && row.status !== "ringing") setInvitation(null);
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void supabase.from("call_participants").select("*").eq("user_id", me).eq("status", "ringing").then(({ data }) => { for (const row of (data ?? []) as CallParticipant[]) void checkInvite(row); });
      });
    return () => { alive = false; void supabase.removeChannel(channel); cleanup(); setInvitation(null); };
  }, [me, cleanup, setInvitation]);

  useEffect(() => {
    if (!incoming) return;
    const remaining = Math.max(0, 45_000 - (Date.now() - Date.parse(incoming.call.created_at)));
    const timer = window.setTimeout(() => { if (incomingRef.current?.call.id === incoming.call.id) void decline(); }, remaining);
    return () => window.clearTimeout(timer);
  }, [incoming, decline]);

  const toggleMute = useCallback(() => {
    const s = sessionRef.current; if (!s) return;
    const next = !s.local.getAudioTracks()[0]?.enabled;
    s.local.getAudioTracks().forEach((t) => { t.enabled = next; });
    setView((v) => v ? { ...v, muted: !next } : v);
  }, []);
  const toggleCamera = useCallback(() => {
    const s = sessionRef.current; if (!s?.local.getVideoTracks().length) return;
    const next = !s.local.getVideoTracks()[0].enabled;
    s.local.getVideoTracks().forEach((t) => { t.enabled = next; });
    setView((v) => v ? { ...v, cameraOff: !next } : v);
  }, []);
  const stopShare = useCallback(async (s: Session) => {
    const old = s.screen; s.screen = null;
    const camera = s.local.getVideoTracks()[0] ?? null;
    const results = await Promise.allSettled([...s.peers.values()].map(async (pc) => {
      await videoTransceiver(pc)?.sender.replaceTrack(camera);
    }));
    old?.getTracks().forEach((t) => t.stop());
    if (results.some((result) => result.status === "rejected")) console.warn("[Luma] could not restore one video track");
    if (!s.closed) setView((v) => v ? { ...v, sharing: false } : v);
  }, []);
  const toggleShare = useCallback(async () => {
    const s = sessionRef.current; if (!s) return;
    if (s.screen) { await stopShare(s); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast.push("Screen sharing isn't supported on this device", "info"); return; }
    let screen: MediaStream | null = null;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (s.closed) { screen.getTracks().forEach((t) => t.stop()); return; }
      const track = screen.getVideoTracks()[0];
      if (!track) throw new Error("No screen video was selected.");
      s.screen = screen;
      track.onended = () => { void stopShare(s); };
      await Promise.all([...s.peers.values()].map(async (pc) => {
        await videoTransceiver(pc)?.sender.replaceTrack(track);
      }));
      setView((v) => v ? { ...v, sharing: true } : v);
    } catch (error) {
      if (screen && s.screen === screen) await stopShare(s);
      else screen?.getTracks().forEach((t) => t.stop());
      if ((error as { name?: string }).name !== "NotAllowedError") toast.push(describeError(error), "error");
    }
  }, [stopShare, toast]);

  const value = useMemo(() => ({ startCall, busy }), [startCall, busy]);
  return <Ctx.Provider value={value}>{children}<CallOverlay incoming={incoming} view={view} onAccept={() => void accept()} onDecline={() => void decline()} onEnd={() => void leave()} onMute={toggleMute} onCamera={toggleCamera} onShare={() => void toggleShare()} busy={busy} /></Ctx.Provider>;
}
export function useCalls() { const value = useContext(Ctx); if (!value) throw new Error("useCalls must be used inside CallProvider"); return value; }
export type { CallView, Incoming };
