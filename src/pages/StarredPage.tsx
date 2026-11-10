import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Loader2, Star } from "lucide-react";
import { Aurora } from "../components/Aurora";
import { Avatar } from "../components/Avatar";
import { loadStarredMessages } from "../lib/data";
import { shortStamp } from "../lib/format";
import type { MessageWithMeta } from "../lib/types";
import { useAuth } from "../context/AuthContext";

export default function StarredPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const meId = user?.id ?? "";
  const [rows, setRows] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!meId) return;
    let alive = true;
    loadStarredMessages(meId)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [meId]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <Aurora />
      <header className="safe-top z-10 flex items-center gap-2 border-b border-white/[0.07] bg-luma-ink/60 px-3 py-2.5 backdrop-blur-2xl">
        <button onClick={() => navigate("/")} className="btn-icon h-10 w-10" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Star className="h-5 w-5 fill-amber-300 text-amber-300" />
        <h1 className="text-[16px] font-semibold text-white">Starred messages</h1>
      </header>

      <main className="z-10 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-2xl space-y-2">
          {loading ? (
            <div className="flex justify-center py-16 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] px-6 py-14 text-center">
              <Star className="mx-auto h-8 w-8 text-slate-600" />
              <h2 className="mt-4 text-[15px] font-semibold text-white">Nothing starred yet</h2>
              <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-slate-500">
                Star any message from its context menu and it will wait for you here —
                synced across your devices.
              </p>
            </div>
          ) : (
            rows.map((m) => (
              <button
                key={m.id}
                onClick={() => navigate(`/chat/${m.chat_id}?jump=${m.id}`)}
                className="flex w-full items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.08]"
              >
                <Avatar profile={m.sender ?? null} label="?" size={38} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-[13px] font-semibold text-luma-200">
                      {m.sender?.display_name ?? "Unknown"}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-slate-500">
                      {shortStamp(m.created_at)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-slate-300">
                    {m.body || (m.media_path ? "📎 Attachment" : "Message")}
                  </span>
                </span>
                <Star className="mt-1 h-4 w-4 shrink-0 fill-amber-300 text-amber-300" />
              </button>
            ))
          )}
        </div>
      </main>
    </div>
  );
}
