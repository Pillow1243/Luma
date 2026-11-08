import { motion } from "framer-motion";
import { BellOff, Pin } from "lucide-react";
import { Avatar } from "./Avatar";
import { chatAvatarProfile, chatTitle } from "../lib/data";
import { previewOf, shortStamp } from "../lib/format";
import type { ChatSummary } from "../lib/types";

export function ChatListItem({
  summary,
  meId,
  active,
  onClick,
}: {
  summary: ChatSummary;
  meId: string;
  active: boolean;
  onClick: () => void;
}) {
  const title = chatTitle(summary, meId);
  const avatarProfile = chatAvatarProfile(summary, meId);
  const otherPart = summary.participants.find(
    (p) => p.id !== meId && summary.chat.is_group
  );
  const typing = summary.typing.length > 0;
  const unread = summary.unreadCount > 0;
  const last = summary.lastMessage;
  const preview = typing
    ? "typing…"
    : last
    ? previewOf(last.body, Boolean(last.media_path), last.media_name)
    : "Say hello 👋";

  return (
    <motion.button
      layout="position"
      onClick={onClick}
      whileTap={{ scale: 0.985 }}
      className={`relative flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-colors ${
        active ? "bg-white/[0.09]" : "hover:bg-white/[0.05]"
      }`}
    >
      {active && (
        <motion.span
          layoutId="chat-active"
          className="absolute inset-0 -z-10 rounded-2xl border border-luma-400/25 bg-luma-500/[0.13]"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        />
      )}

      <Avatar
        profile={avatarProfile ?? otherPart}
        label={summary.chat.is_group ? summary.chat.name ?? "Group" : title}
        group={summary.chat.is_group}
        size={48}
        online={typing}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-[14.5px] ${
              unread ? "font-semibold text-white" : "font-medium text-slate-200"
            }`}
          >
            {title}
          </span>
          <span
            className={`shrink-0 text-[11px] ${
              unread ? "font-semibold text-luma-300" : "text-slate-500"
            }`}
          >
            {last ? shortStamp(last.created_at) : ""}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span
            className={`truncate text-[12.5px] ${
              typing ? "text-luma-300" : unread ? "text-slate-300" : "text-slate-500"
            }`}
          >
            {last?.sender_id === meId && !typing && last ? "You: " : ""}
            {preview}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {summary.chat.is_group && (
              <Pin className="h-3 w-3 text-slate-600" strokeWidth={2} />
            )}
            {unread ? (
              <span className="grid h-[19px] min-w-[19px] place-items-center rounded-full bg-luma-gradient px-1.5 text-[10.5px] font-bold text-white shadow-bubble">
                {summary.unreadCount > 99 ? "99+" : summary.unreadCount}
              </span>
            ) : last ? (
              <BellOff className="hidden h-3 w-3 text-slate-700" />
            ) : null}
          </div>
        </div>
      </div>
    </motion.button>
  );
}
