import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import type { ChatSummary } from "../lib/types";
import { relativeDay } from "../lib/format";
import { Users } from "lucide-react";

export function ChatInfoModal({
  open,
  onClose,
  summary,
  meId,
}: {
  open: boolean;
  onClose: () => void;
  summary: ChatSummary | null;
  meId: string;
}) {
  if (!summary) return null;
  const isGroup = summary.chat.is_group;
  const other = summary.participants.find((p) => p.id !== meId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isGroup ? summary.chat.name || "Group chat" : other?.display_name ?? "Conversation"}
      subtitle={isGroup ? `${summary.participants.length} members` : "Direct message"}
    >
      <div className="flex flex-col items-center">
        <Avatar
          profile={isGroup ? null : other}
          label={summary.chat.name ?? "Group"}
          group={isGroup}
          size={84}
          ring
        />
        <p className="mt-3 text-[12.5px] text-slate-500">
          Created {relativeDay(summary.chat.created_at).toLowerCase()}
        </p>
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-slate-500">
          <Users className="h-3.5 w-3.5" /> Members
        </div>
        <div className="space-y-1">
          {summary.participants.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-white/[0.05]"
            >
              <Avatar profile={p} size={38} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] text-slate-200">{p.display_name}</div>
                <div className="text-[11.5px] text-slate-500">
                  {p.id === meId ? "You" : "Member"}
                </div>
              </div>
              {summary.typing.some((t) => t.id === p.id) && (
                <span className="chip text-luma-200">typing…</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-3 text-[12px] leading-relaxed text-slate-400">
        Messages in this conversation are protected by row-level security — only members
        can read them. Media is served through short-lived signed URLs.
      </div>
    </Modal>
  );
}
