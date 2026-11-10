import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { chatAvatarProfile, chatTitle, loadChats } from "../lib/data";
import type { ChatSummary } from "../lib/types";

export function ForwardModal({
  open,
  onClose,
  meId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  meId: string;
  onPick: (target: ChatSummary) => Promise<void> | void;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [term, setTerm] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    loadChats(meId)
      .then((rows) => alive && setChats(rows))
      .catch(() => alive && setChats([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, meId]);

  useEffect(() => {
    if (!open) {
      setTerm("");
      setBusyId(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return chats;
    return chats.filter((c) => chatTitle(c, meId).toLowerCase().includes(t));
  }, [chats, term, meId]);

  async function pick(c: ChatSummary) {
    setBusyId(c.chat.id);
    try {
      await onPick(c);
      onClose();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Forward to…" subtitle="Choose a destination chat.">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search chats…"
          className="field py-2.5 pl-10 text-[13.5px]"
        />
      </div>
      <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1 no-scrollbar">
        {loading && (
          <div className="flex justify-center py-8 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <p className="py-8 text-center text-[13px] text-slate-500">No chats found.</p>
        )}
        {filtered.map((c) => {
          const avatar = chatAvatarProfile(c, meId);
          const busy = busyId === c.chat.id;
          return (
            <button
              key={c.chat.id}
              disabled={Boolean(busyId)}
              onClick={() => pick(c)}
              className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] disabled:opacity-60"
            >
              <Avatar
                profile={avatar}
                label={c.chat.name ?? chatTitle(c, meId)}
                group={c.chat.is_group || c.chat.kind === "channel"}
                size={40}
              />
              <span className="min-w-0 flex-1 truncate text-[14px] text-slate-200">
                {chatTitle(c, meId)}
              </span>
              {busy && <Loader2 className="h-4 w-4 animate-spin text-luma-300" />}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
