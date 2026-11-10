import { Loader2, WifiOff } from "lucide-react";
import { useOffline } from "../context/OfflineContext";

export function ConnectionBanner() {
  const { connection, outbox } = useOffline();
  if (connection === "online") return null;
  const waiting = outbox.filter((item) => item.status === "queued").length;
  return (
    <div role="status" aria-live="polite" className="z-30 flex min-h-9 items-center justify-center gap-2 border-b border-amber-400/20 bg-amber-950/90 px-3 py-2 text-center text-[12px] text-amber-100">
      {connection === "offline" ? <WifiOff className="h-4 w-4 shrink-0" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
      <span>{connection === "offline" ? "Connection lost · Reading saved conversations" : "Reconnecting…"}{waiting ? ` · ${waiting} message${waiting === 1 ? "" : "s"} queued` : ""}</span>
    </div>
  );
}
