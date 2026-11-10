import { motion } from "framer-motion";
import { useRef, useState } from "react";
import { Archive, BellOff, Hash, VolumeX } from "lucide-react";
import { Avatar } from "./Avatar";
import { chatAvatarProfile, chatTitle } from "../lib/data";
import { previewOf, shortStamp } from "../lib/format";
import type { ChatSummary } from "../lib/types";

export function ChatListItem({
  summary,
  meId,
  active,
  onClick,
  onArchive,
}: {
  summary: ChatSummary;
  meId: string;
  active: boolean;
  onClick: () => void;
  onArchive?: (archived: boolean) => void;
}) {
  const [swipeX, setSwipeX] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const swipeOffset = useRef(0);
  const suppressClick = useRef(false);
  const { chat } = summary;
  const isSaved = chat.kind === "saved";
  const isChannel = chat.kind === "channel";
  const isGroup = chat.is_group || isChannel;
  const title = isSaved ? "Saved Messages" : chatTitle(summary, meId);
  const avatarProfile = isSaved || isChannel ? null : chatAvatarProfile(summary, meId);
  const typing = summary.typing.length > 0;
  const unread = summary.unreadCount > 0;
  const muted = Boolean(summary.mutedUntil && new Date(summary.mutedUntil) > new Date());
  const archived = Boolean(summary.archivedAt);
  const last = summary.lastMessage;
  const preview = typing
    ? "typing…"
    : last
      ? previewOf(last.body, Boolean(last.media_path), last.media_name)
      : "No messages yet";

  return (
    <motion.button
      layout="position"
      onClick={() => { if (!suppressClick.current) onClick(); }}
      style={{ x: swipeX, touchAction: "pan-y" }}
      onTouchStart={(event) => { const t = event.touches[0]; touchStart.current = { x: t.clientX, y: t.clientY }; swipeOffset.current = 0; }}
      onTouchMove={(event) => {
        if (!touchStart.current || !onArchive) return;
        const t = event.touches[0]; const dx = t.clientX - touchStart.current.x; const dy = t.clientY - touchStart.current.y;
        if (dx < 0 && -dx > Math.abs(dy) * 1.3) { swipeOffset.current = Math.max(dx, -100); setSwipeX(swipeOffset.current); }
      }}
      onTouchEnd={() => {
        if (swipeOffset.current < -70 && onArchive) { suppressClick.current = true; onArchive(!archived); navigator.vibrate?.(10); window.setTimeout(() => { suppressClick.current = false; }, 400); }
        touchStart.current = null; swipeOffset.current = 0; setSwipeX(0);
      }}
      onTouchCancel={() => { touchStart.current = null; swipeOffset.current = 0; setSwipeX(0); }}
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

      <div className="relative">
        <Avatar
          profile={avatarProfile}
          label={isSaved ? "Saved" : chat.name ?? title}
          group={isGroup}
          saved={isSaved}
          chatAvatarPath={isGroup ? chat.avatar_path : null}
          size={48}
          online={typing}
        />
        {isChannel && (
          <span className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border-2 border-luma-ink bg-luma-500 text-white">
            <Hash className="h-3 w-3" strokeWidth={2.5} />
          </span>
        )}
      </div>

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
            {muted && <BellOff className="h-3 w-3 text-slate-500" aria-label="Muted" />}
            {archived && <Archive className="h-3 w-3 text-slate-500" aria-label="Archived" />}
            {unread ? (
              <span
                className={`grid h-[19px] min-w-[19px] place-items-center rounded-full px-1.5 text-[10.5px] font-bold text-white shadow-bubble ${
                  muted ? "bg-slate-600" : "bg-luma-gradient"
                }`}
              >
                {summary.unreadCount > 99 ? "99+" : summary.unreadCount}
              </span>
            ) : muted ? (
              <VolumeX className="sr-only" />
            ) : null}
          </div>
        </div>
      </div>
    </motion.button>
  );
}
