import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Camera, CameraOff, Mic, MicOff, MonitorUp, Phone, PhoneOff, Video } from "lucide-react";
import { Avatar } from "./Avatar";
import type { CallView, Incoming } from "../context/CallContext";
import { hasOwnTurnCredentials } from "../lib/calls";

function StreamVideo({ stream, muted = false, className = "" }: { stream: MediaStream; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) { ref.current.srcObject = stream; void ref.current.play().catch(() => {}); } }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}
function RemoteTile({ stream, name }: { stream: MediaStream; name: string }) {
  const [hasVideo, setHasVideo] = useState(false);
  useEffect(() => {
    const update = () => setHasVideo(stream.getVideoTracks().some((track) => track.readyState === "live" && !track.muted));
    const bind = () => { for (const track of stream.getVideoTracks()) { track.addEventListener("mute", update); track.addEventListener("unmute", update); track.addEventListener("ended", update); } update(); };
    bind(); stream.addEventListener("addtrack", bind); stream.addEventListener("removetrack", update);
    return () => { stream.removeEventListener("addtrack", bind); stream.removeEventListener("removetrack", update); for (const track of stream.getVideoTracks()) { track.removeEventListener("mute", update); track.removeEventListener("unmute", update); track.removeEventListener("ended", update); } };
  }, [stream]);
  return <div className="relative grid min-h-0 place-items-center overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-violet-950 to-slate-900">
    <div className="absolute inset-0 grid place-items-center"><span className="grid h-20 w-20 place-items-center rounded-full bg-luma-gradient text-3xl font-semibold">{name.slice(0, 1).toUpperCase()}</span></div>
    <StreamVideo stream={stream} className={`relative h-full w-full object-cover ${hasVideo ? "opacity-100" : "opacity-0"}`} />
    <span className="absolute bottom-3 left-3 rounded-full bg-black/45 px-3 py-1 text-xs backdrop-blur">{name}</span>
  </div>;
}
function Control({ label, onClick, danger, active, children, disabled = false }: { label: string; onClick: () => void; danger?: boolean; active?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return <button onClick={onClick} disabled={disabled} aria-label={label} title={label} className={`flex min-w-[4rem] flex-col items-center gap-2 text-[11px] text-white/80 disabled:opacity-35`}>
    <span className={`grid h-14 w-14 place-items-center rounded-2xl transition-transform active:scale-95 ${danger ? "bg-rose-500 text-white" : active ? "bg-white text-slate-900" : "border border-white/15 bg-white/10 text-white hover:bg-white/20"}`}>{children}</span><span>{label}</span>
  </button>;
}
export function CallOverlay({ incoming, view, onAccept, onDecline, onEnd, onMute, onCamera, onShare, busy }: {
  incoming: Incoming | null; view: CallView | null; onAccept: () => void; onDecline: () => void; onEnd: () => void;
  onMute: () => void; onCamera: () => void; onShare: () => void; busy: boolean;
}) {
  if (!incoming && !view) return null;
  if (incoming && !view) return <div role="dialog" aria-modal="true" aria-label="Incoming call" className="fixed inset-0 z-[500] flex items-center justify-center bg-[#090716]/95 px-6 text-center text-white backdrop-blur-2xl">
    <motion.div initial={{ opacity: 0, y: 20, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="flex w-full max-w-md flex-col items-center">
      <p className="text-xs font-semibold uppercase tracking-[.24em] text-luma-300">Incoming {incoming.call.kind} call</p>
      <div className="relative mt-10"><div className="absolute -inset-5 animate-pulse rounded-full bg-luma-500/15 blur-xl" /><Avatar profile={incoming.caller} size={112} ring /></div>
      <h2 className="mt-7 text-3xl font-semibold tracking-tight">{incoming.caller?.display_name || "Someone on Luma"}</h2>
      <p className="mt-2 text-sm text-slate-400">{incoming.call.kind === "video" ? "wants to video chat" : "is calling you"}</p>
      <div className="mt-16 flex items-center justify-center gap-14">
        <Control label="Decline" onClick={onDecline} danger><PhoneOff className="h-6 w-6" /></Control>
        <button onClick={onAccept} disabled={busy} aria-label="Accept call" className="flex min-w-[4rem] flex-col items-center gap-2 text-[11px] text-white/80 disabled:opacity-50"><span className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-500 text-white shadow-[0_0_35px_rgba(16,185,129,.3)]"><Phone className="h-6 w-6" /></span>Accept</button>
      </div>
    </motion.div>
  </div>;
  if (!view) return null;
  return <div role="dialog" aria-modal="true" aria-label="Active call" className="fixed inset-0 z-[500] flex flex-col bg-[#090716] text-white">
    <header className="safe-top flex items-center justify-between gap-4 border-b border-white/[.08] px-5 py-4">
      <div><p className="text-[10px] font-semibold uppercase tracking-[.22em] text-luma-300">Luma {view.call.kind} call</p><h2 className="mt-1 text-lg font-semibold">{view.title}</h2></div>
      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${view.phase === "active" ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`} />{view.phase === "calling" ? "Calling…" : view.phase === "connecting" ? "Connecting…" : "Connected"}</span>
    </header>
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3 sm:p-6">
      {view.remote.length ? <div className={`grid h-full w-full max-w-6xl gap-3 ${view.remote.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {view.remote.map((remote) => <RemoteTile key={remote.userId} stream={remote.stream} name={remote.name} />)}
      </div> : <div className="flex flex-col items-center text-center"><div className="grid h-28 w-28 place-items-center rounded-full bg-luma-gradient text-4xl font-semibold shadow-glow">{view.title.slice(0, 1).toUpperCase()}</div><p className="mt-5 text-xl font-medium">{view.title}</p><p className="mt-2 text-sm text-slate-400">{view.phase === "calling" ? "Waiting for an answer…" : "Connecting…"}</p></div>}
      {view.call.kind === "video" && <div className="absolute right-5 top-5 h-32 w-24 overflow-hidden rounded-2xl border border-white/20 bg-slate-900 shadow-2xl sm:h-40 sm:w-32">
        {!view.cameraOff ? <StreamVideo stream={view.local} muted className="h-full w-full scale-x-[-1] object-cover" /> : <div className="grid h-full place-items-center"><CameraOff className="h-6 w-6 text-slate-500" /></div>}
        <span className="absolute bottom-2 left-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px]">You</span>
      </div>}
    </div>
    <footer className="safe-bottom flex flex-col items-center border-t border-white/[.08] bg-black/20 px-3 pt-4 pb-5">
      <div className="flex max-w-full items-start justify-center gap-2 sm:gap-5">
        <Control label={view.muted ? "Unmute" : "Mute"} onClick={onMute} active={view.muted}>{view.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</Control>
        <Control label={view.cameraOff ? "Camera on" : "Camera off"} onClick={onCamera} active={view.cameraOff} disabled={view.call.kind !== "video"}>{view.cameraOff ? <CameraOff className="h-5 w-5" /> : <Camera className="h-5 w-5" />}</Control>
        <Control label={view.sharing ? "Stop share" : "Share"} onClick={onShare} active={view.sharing}><MonitorUp className="h-5 w-5" /></Control>
        <Control label="End" onClick={onEnd} danger><PhoneOff className="h-5 w-5" /></Control>
      </div>
      {!hasOwnTurnCredentials && <p className="mt-4 max-w-lg text-center text-[10px] text-amber-200/70">Using public relay example credentials. Some networks may require a configured TURN service.</p>}
    </footer>
  </div>;
}
