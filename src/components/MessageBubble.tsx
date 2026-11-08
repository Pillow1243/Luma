import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  CornerUpLeft,
  Download,
  File as FileIcon,
  Play,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { mediaUrl } from "../lib/data";
import {
  bytes,
  isAudio,
  isImage,
  isVideo,
  timeOfDay,
} from "../lib/format";
import type { MessageWithMeta, Profile } from "../lib/types";
import { Avatar } from "./Avatar";

const QUICK_REACTIONS = ["❤️", "😂", "🔥", "👍", "😮", "🙏"];

export function MessageBubble({
  message,
  mine,
  grouped,
  showAvatar,
  read,
  onReact,
  onReply,
  onDelete,
  onJumpTo,
}: {
  message: MessageWithMeta;
  mine: boolean;
  grouped: boolean;
  showAvatar: boolean;
  read: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onDelete: () => void;
  onJumpTo: (id: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const groupedReactions = message.reactions.reduce<Record<string, number>>((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
    return acc;
  }, {});

  const hasMedia = Boolean(message.media_path);

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.6 }}
      className={`group/msg relative flex w-full gap-2 ${mine ? "flex-row-reverse" : "flex-row"} ${
        grouped ? "mt-0.5" : "mt-3"
      }`}
      onMouseEnter={() => {
        if (closeTimer.current) window.clearTimeout(closeTimer.current);
        setActionsOpen(true);
      }}
      onMouseLeave={() => {
        closeTimer.current = window.setTimeout(() => {
          setActionsOpen(false);
          setPickerOpen(false);
        }, 220);
      }}
    >
      {/* avatar gutter */}
      <div className="w-8 shrink-0 self-end">
        {showAvatar && !mine ? (
          <Avatar profile={message.sender} size={32} />
        ) : (
          <div className="h-8 w-8" />
        )}
      </div>

      <div className={`flex min-w-0 max-w-[min(78%,34rem)] flex-col ${mine ? "items-end" : "items-start"}`}>
        {!grouped && !mine && (
          <div className="mb-1 ml-1 text-[11.5px] font-medium text-luma-300/80">
            {message.sender?.display_name ?? "Unknown"}
          </div>
        )}

        {/* reply preview */}
        {message.replyTo && (
          <button
            onClick={() => message.reply_to && onJumpTo(message.reply_to)}
            className={`mb-1 flex max-w-full items-center gap-2 rounded-xl border-l-2 border-luma-400/70 bg-white/[0.05] px-2.5 py-1.5 text-left text-[11.5px] text-slate-400 transition-colors hover:bg-white/[0.09] ${
              mine ? "rounded-r-xl" : ""
            }`}
          >
            <CornerUpLeft className="h-3 w-3 shrink-0 text-luma-300" />
            <span className="truncate">
              {message.replyTo.body?.slice(0, 90) || "Attachment"}
            </span>
          </button>
        )}

        <div className={`flex items-end gap-1.5 ${mine ? "flex-row-reverse" : ""}`}>
          <div
            id={`msg-${message.id}`}
            className={`relative overflow-hidden px-3.5 py-2.5 text-[14.5px] leading-[1.5] transition-shadow ${
              mine
                ? "rounded-[20px] rounded-br-[7px] bg-luma-gradient text-white shadow-bubble"
                : "rounded-[20px] rounded-bl-[7px] border border-white/10 bg-white/[0.065] text-slate-100 backdrop-blur-xl"
            } ${message.failed ? "opacity-60 ring-1 ring-rose-400/60" : ""}`}
          >
            {/* media */}
            {hasMedia && (
              <div className="mb-1.5 -mx-1 overflow-hidden rounded-2xl">
                <MediaBlock message={message} />
              </div>
            )}

            {message.body && (
              <p className="message-text whitespace-pre-wrap break-words">{message.body}</p>
            )}

            <div
              className={`mt-1 flex items-center justify-end gap-1 text-[10.5px] ${
                mine ? "text-white/70" : "text-slate-500"
              }`}
            >
              <span>{timeOfDay(message.created_at)}</span>
              {mine &&
                (message.pending ? (
                  <span className="h-2.5 w-2.5 animate-spin rounded-full border border-white/40 border-t-transparent" />
                ) : message.failed ? (
                  <span className="text-rose-200">!</span>
                ) : read ? (
                  <CheckCheck className="h-3.5 w-3.5 text-cyan-200" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                ))}
            </div>

            <span className="pointer-events-none absolute inset-0 bg-luma-sheen opacity-60" />
          </div>

          {/* hover actions */}
          <AnimatePresence>
            {actionsOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                className="mb-0.5 flex items-center gap-0.5 rounded-full border border-white/10 bg-luma-panel/80 p-1 backdrop-blur-xl"
              >
                <IconAction label="React" onClick={() => setPickerOpen((v) => !v)}>
                  <SmilePlus className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction label="Reply" onClick={onReply}>
                  <CornerUpLeft className="h-3.5 w-3.5" />
                </IconAction>
                {mine && (
                  <IconAction label="Delete" onClick={onDelete} danger>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconAction>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* reactions */}
        {Object.keys(groupedReactions).length > 0 && (
          <div className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}>
            {Object.entries(groupedReactions).map(([emoji, count]) => {
              const mineReacted = message.reactions.some(
                (r) => r.emoji === emoji
              );
              return (
                <motion.button
                  key={emoji}
                  layout
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  onClick={() => onReact(emoji)}
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition-colors ${
                    mineReacted
                      ? "border-luma-400/60 bg-luma-500/25 text-luma-100"
                      : "border-white/10 bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]"
                  }`}
                >
                  <span className="text-[12px] leading-none">{emoji}</span>
                  {count > 1 && <span>{count}</span>}
                </motion.button>
              );
            })}
          </div>
        )}

        {/* emoji picker */}
        <AnimatePresence>
          {pickerOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.96 }}
              className="glass-strong mt-2 flex gap-1 rounded-2xl p-1.5"
              onMouseLeave={() => setPickerOpen(false)}
            >
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    onReact(e);
                    setPickerOpen(false);
                  }}
                  className="grid h-8 w-8 place-items-center rounded-xl text-[16px] transition-transform hover:scale-125 hover:bg-white/10"
                >
                  {e}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function IconAction({
  children,
  onClick,
  label,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`grid h-7 w-7 place-items-center rounded-full text-slate-300 transition-colors hover:bg-white/10 ${
        danger ? "hover:text-rose-300" : "hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function MediaBlock({ message }: { message: MessageWithMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    mediaUrl(message.media_path).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [message.media_path]);

  if (failed) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-black/20 px-3 py-2 text-[12px] text-slate-400">
        <FileIcon className="h-4 w-4" /> Attachment unavailable
      </div>
    );
  }

  if (!url) {
    return <div className="h-36 w-52 animate-pulse rounded-xl bg-white/10" />;
  }

  if (isImage(message.media_type, message.media_name)) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={message.media_name ?? "image"}
          className="max-h-72 w-full max-w-xs cursor-zoom-in object-cover transition-transform duration-300 hover:scale-[1.01]"
          loading="lazy"
        />
      </a>
    );
  }

  if (isVideo(message.media_type, message.media_name)) {
    return (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        className="max-h-72 w-full max-w-xs"
      />
    );
  }

  if (isAudio(message.media_type, message.media_name)) {
    return (
      <div className="flex w-56 items-center gap-2 rounded-xl bg-black/20 px-2 py-1.5">
        <Play className="h-4 w-4 shrink-0 text-luma-200" />
        <audio src={url} controls className="h-8 w-full" />
      </div>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      download={message.media_name ?? undefined}
      className="flex w-60 items-center gap-2.5 rounded-xl bg-black/25 px-3 py-2.5 transition-colors hover:bg-black/35"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10">
        <FileIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-slate-100">
          {message.media_name ?? "File"}
        </span>
        <span className="block text-[11px] text-slate-400">Tap to download</span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-slate-400" />
    </a>
  );
}

export function TypingBubble({ names }: { names: string[] }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      className="mt-3 flex items-end gap-2"
    >
      <div className="w-8" />
      <div className="flex items-center gap-2 rounded-[20px] rounded-bl-[7px] border border-white/10 bg-white/[0.065] px-3.5 py-3 backdrop-blur-xl">
        <span className="flex items-center gap-1 text-luma-300">
          <i className="dot" />
          <i className="dot" />
          <i className="dot" />
        </span>
        <span className="text-[11.5px] text-slate-400">
          {names.slice(0, 2).join(", ")} {names.length > 1 ? "are" : "is"} typing
        </span>
      </div>
    </motion.div>
  );
}

export type { Profile };
