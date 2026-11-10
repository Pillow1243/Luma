import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCheck,
  CornerUpLeft,
  Copy,
  Download,
  File as FileIcon,
  Forward,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Flag,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { mediaUrl } from "../lib/data";
import { decryptSecretText, isSecretBody } from "../lib/secret";
import {
  bytes,
  isAudio,
  isImage,
  isVideo,
  timeOfDay,
} from "../lib/format";
import type { MessageWithMeta, Profile } from "../lib/types";
import { Avatar } from "./Avatar";
import { PollBlock } from "./Poll";
import { GIF_PREFIX, STICKER_PREFIX } from "./StickerPicker";

const QUICK_REACTIONS = ["❤️", "😂", "🔥", "👍", "😮", "🙏", "👏", "💜"];
const EXTENDED_REACTIONS = [
  "😀","😁","😄","🤣","😅","😊","😍","😘","😜","🤔","🙄","😴","🤯","🥳","😭","😤",
  "🙃","🫡","🤝","👀","💯","🚀","✨","🎉","🌙","⚡","🖤","💔","🌹","☕","🍕","🎧",
];

export function MessageBubble({
  message,
  mine,
  grouped,
  showAvatar,
  read,
  starred,
  canModerate,
  searchQuery,
  editing,
  editDraft,
  onEditDraftChange,
  onEditSave,
  onEditCancel,
  onReact,
  onReply,
  onEdit,
  onDeleteMe,
  onDeleteEveryone,
  onForward,
  onTogglePin,
  onToggleStar,
  onJumpTo,
  onReport,
  onRetry,
  onDiscard,
  meId,
  peerId,
}: {
  message: MessageWithMeta;
  mine: boolean;
  grouped: boolean;
  showAvatar: boolean;
  read: boolean;
  starred: boolean;
  canModerate: boolean;
  searchQuery?: string;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDeleteMe: () => void;
  onDeleteEveryone: () => void;
  onForward: () => void;
  onTogglePin: () => void;
  onToggleStar: () => void;
  onJumpTo: (id: string) => void;
  onReport: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  meId?: string;
  peerId?: string | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<"me" | "everyone" | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const swipeOffset = useRef(0);
  const [swipeX, setSwipeX] = useState(0);

  const groupedReactions = message.reactions.reduce<Record<string, number>>((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
    return acc;
  }, {});

  const hasMedia = Boolean(message.media_path);
  const deleted = Boolean(message.deleted_at);
  const secret = isSecretBody(message.body);
  const sticker = message.body?.startsWith(STICKER_PREFIX) ? message.body.slice(STICKER_PREFIX.length) : null;
  const gifId = message.body?.startsWith(GIF_PREFIX) ? message.body.slice(GIF_PREFIX.length) : null;
  const gif = gifId && /^[a-zA-Z0-9]{1,40}$/.test(gifId) ? gifId : null;
  const poll = Boolean(message.body?.startsWith("📊 Poll: "));

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const copyText = () => {
    if (message.body) navigator.clipboard?.writeText(message.body).catch(() => {});
    setMenuOpen(false);
  };

  return (
    <motion.div
      layout="position"
      style={{ x: swipeX, touchAction: "pan-y" }}
      onTouchStart={(event) => {
        if (message.pending || message.failed || deleted || (event.target as Element).closest("button,a,textarea,audio,video")) return;
        const t = event.touches[0]; touchStart.current = { x: t.clientX, y: t.clientY }; swipeOffset.current = 0;
      }}
      onTouchMove={(event) => {
        if (!touchStart.current) return;
        const t = event.touches[0]; const dx = t.clientX - touchStart.current.x; const dy = t.clientY - touchStart.current.y;
        if (dx > 0 && dx > Math.abs(dy) * 1.3) { swipeOffset.current = Math.min(dx, 90); setSwipeX(swipeOffset.current); }
      }}
      onTouchEnd={() => {
        if (swipeOffset.current > 65) { onReply(); navigator.vibrate?.(10); }
        touchStart.current = null; swipeOffset.current = 0; setSwipeX(0);
      }}
      onTouchCancel={() => { touchStart.current = null; swipeOffset.current = 0; setSwipeX(0); }}
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.6 }}
      className={`group/msg relative flex w-full gap-2 ${mine ? "flex-row-reverse" : "flex-row"} ${
        grouped ? "mt-0.5" : "mt-3"
      }`}
    >
      {/* avatar gutter */}
      <div className="w-8 shrink-0 self-end">
        {showAvatar && !mine ? (
          <Avatar profile={message.sender} size={32} />
        ) : (
          <div className="h-8 w-8" />
        )}
      </div>

      <div className={`flex min-w-0 max-w-[min(82%,34rem)] flex-col ${mine ? "items-end" : "items-start"}`}>
        {!grouped && !mine && (
          <div className="mb-1 ml-1 flex items-center gap-1.5 text-[11.5px] font-medium text-luma-300/80">
            {message.sender?.display_name ?? "Unknown"}
            {message.sender?.username && (
              <span className="text-slate-500">@{message.sender.username}</span>
            )}
          </div>
        )}

        {/* forwarded label */}
        {message.forwarded_from && !deleted && (
          <div className={`mb-1 flex items-center gap-1 text-[10.5px] text-slate-500 ${mine ? "mr-1" : "ml-1"}`}>
            <Forward className="h-3 w-3" /> Forwarded message
          </div>
        )}

        {/* reply preview */}
        {message.replyTo && !deleted && (
          <button
            onClick={() => message.reply_to && onJumpTo(message.reply_to)}
            className={`mb-1 flex max-w-full items-center gap-2 rounded-xl border-l-2 border-luma-400/70 bg-white/[0.05] px-2.5 py-1.5 text-left text-[11.5px] text-slate-400 transition-colors hover:bg-white/[0.09]`}
          >
            <CornerUpLeft className="h-3 w-3 shrink-0 text-luma-300" />
            <span className="truncate">
              <span className="font-medium text-luma-200/90">
                {message.replyTo.sender?.display_name ?? "message"}: 
              </span>
              {isSecretBody(message.replyTo.body) ? "🔒 Encrypted message" : message.replyTo.body?.slice(0, 90) || (message.replyTo.media_path ? "📎 Attachment" : "Message")}
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
            {message.pinned_at && !deleted && (
              <div className={`mb-1 flex items-center gap-1 text-[10px] font-medium ${mine ? "text-white/80" : "text-luma-300/90"}`}>
                <Pin className="h-3 w-3 fill-current" /> Pinned
              </div>
            )}

            {/* media */}
            {hasMedia && !deleted && (
              <div className="mb-1.5 -mx-1 overflow-hidden rounded-2xl">
                <MediaBlock message={message} />
              </div>
            )}

            {editing ? (
              <div className="flex items-center gap-2 py-0.5">
                <textarea
                  autoFocus
                  value={editDraft}
                  onChange={(e) => onEditDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      onEditSave();
                    }
                    if (e.key === "Escape") onEditCancel();
                  }}
                  rows={Math.min(4, Math.max(1, editDraft.split("\n").length))}
                  className="w-full resize-none rounded-lg bg-black/25 p-2 text-[14px] text-white outline-none ring-1 ring-white/20"
                />
                <button onClick={onEditSave} className="rounded-lg bg-white/15 p-1.5 hover:bg-white/25" aria-label="Save edit">
                  <Check className="h-4 w-4" />
                </button>
                <button onClick={onEditCancel} className="rounded-lg bg-white/10 p-1.5 hover:bg-white/20" aria-label="Cancel edit">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : deleted ? (
              <p className={`italic ${mine ? "text-white/70" : "text-slate-500"}`}>
                This message was deleted
              </p>
            ) : (
              message.body && (secret
                ? <SecretText body={message.body} meId={meId} peerId={peerId} chatId={message.chat_id} senderId={message.sender_id} mine={mine} />
                : sticker ? <span className="block py-1 text-center text-6xl" role="img" aria-label="Sticker">{sticker}</span>
                : gif ? <img src={`https://media.giphy.com/media/${gif}/giphy.gif`} alt="GIF from GIPHY" className="max-h-60 w-full max-w-xs rounded-xl" loading="lazy" />
                : poll && meId ? <PollBlock messageId={message.id} fallback={message.body} meId={meId} />
                : <RichText body={message.body} mine={mine} searchQuery={searchQuery} />)

            )}

            <div
              className={`mt-1 flex items-center justify-end gap-1 text-[10.5px] ${
                mine ? "text-white/70" : "text-slate-500"
              }`}
            >
              {secret && <Lock className="h-3 w-3" aria-label="Encrypted text" />}
              {message.pending && <span>Sending…</span>}
              {message.failed && <span>Not sent</span>}
              {message.edited_at && !deleted && <span className="italic">edited</span>}
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

          {/* Pending messages are not server rows yet. */}
          {message.failed ? <div className="flex flex-col gap-1 text-[11px]">
            <button className="text-luma-200 underline" onClick={onRetry}>Retry</button>
            <button className="text-slate-400 underline" onClick={onDiscard}>Discard</button>
          </div> : !message.pending && <div className="relative mb-0.5" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="grid h-8 w-8 place-items-center rounded-full text-slate-400 opacity-60 transition-all hover:bg-white/10 hover:text-white hover:opacity-100 focus:opacity-100 group-hover/msg:opacity-100"
              aria-label="Message actions"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.97 }}
                  className={`absolute bottom-9 z-30 w-52 overflow-hidden rounded-2xl border border-white/10 bg-luma-panel/95 py-1.5 shadow-2xl backdrop-blur-2xl ${
                    mine ? "right-0" : "left-0"
                  }`}
                >
                  {!deleted && (
                    <>
                      <MenuItem icon={<CornerUpLeft className="h-4 w-4" />} label="Reply" onClick={() => { setMenuOpen(false); onReply(); }} />
                      {message.body && !secret && !sticker && !gif && !poll && (
                        <MenuItem icon={<Copy className="h-4 w-4" />} label="Copy text" onClick={copyText} />
                      )}
                      {mine && !secret && !sticker && !gif && !poll && (
                        <MenuItem icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={() => { setMenuOpen(false); onEdit(); }} />
                      )}
                      {!secret && <MenuItem icon={<Forward className="h-4 w-4" />} label="Forward" onClick={() => { setMenuOpen(false); onForward(); }} />}
                      <MenuItem
                        icon={<Star className={`h-4 w-4 ${starred ? "fill-amber-300 text-amber-300" : ""}`} />}
                        label={starred ? "Unstar" : "Save to Starred"}
                        onClick={() => { setMenuOpen(false); onToggleStar(); }}
                      />
                      <MenuItem
                        icon={<Pin className="h-4 w-4" />}
                        label={message.pinned_at ? "Unpin" : "Pin"}
                        onClick={() => { setMenuOpen(false); onTogglePin(); }}
                      />
                      <MenuItem icon={<SmilePlusIcon />} label="React" onClick={() => { setMenuOpen(false); setPickerOpen(true); }} />
                    </>
                  )}
                  {!mine && !deleted && (
                    <MenuItem icon={<Flag className="h-4 w-4" />} label="Report" onClick={() => { setMenuOpen(false); onReport(); }} />
                  )}
                  {!deleted && (
                    <>
                      <div className="my-1 h-px bg-white/[0.07]" />
                      <MenuItem icon={<Trash2 className="h-4 w-4" />} label="Delete for me" danger onClick={() => { setMenuOpen(false); setConfirmId("me"); }} />
                      {(mine || canModerate) && (
                        <MenuItem icon={<Trash2 className="h-4 w-4" />} label="Delete for everyone" danger onClick={() => { setMenuOpen(false); setConfirmId("everyone"); }} />
                      )}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* inline delete confirm */}
            <AnimatePresence>
              {confirmId && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  className={`absolute bottom-9 z-40 w-64 rounded-2xl border border-rose-400/25 bg-luma-panel/95 p-3 shadow-2xl backdrop-blur-2xl ${
                    mine ? "right-0" : "left-0"
                  }`}
                >
                  <p className="text-[12.5px] font-medium text-slate-200">
                    {confirmId === "everyone" ? "Delete for everyone?" : "Delete for you?"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {confirmId === "everyone"
                      ? "Everyone in this chat will see a tombstone."
                      : "Only you will stop seeing this message."}
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <button onClick={() => setConfirmId(null)} className="rounded-lg px-2.5 py-1.5 text-[12px] text-slate-400 hover:bg-white/5">
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        const which = confirmId;
                        setConfirmId(null);
                        if (which === "everyone") onDeleteEveryone();
                        else onDeleteMe();
                      }}
                      className="rounded-lg bg-rose-500/80 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-rose-500"
                    >
                      Delete
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>}
        </div>

        {message.failed && message.failureReason && <p className="mt-1 max-w-xs text-[10.5px] text-rose-300">{message.failureReason}</p>}

        {/* reactions */}
        {Object.keys(groupedReactions).length > 0 && (
          <div className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}>
            {Object.entries(groupedReactions).map(([emoji, count]) => {
              const mineReacted = message.reactions.some((r) => r.emoji === emoji);
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

        {/* starred marker */}
        {starred && (
          <div className={`mt-0.5 ${mine ? "mr-1" : "ml-1"}`}>
            <Star className="h-3 w-3 fill-amber-300/80 text-amber-300/80" />
          </div>
        )}

        {/* emoji picker */}
        <AnimatePresence>
          {pickerOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.96 }}
              className="glass-strong z-20 mt-2 grid grid-cols-8 gap-1 rounded-2xl p-2"
            >
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    onReact(e);
                    setPickerOpen(false);
                  }}
                  className="grid h-9 w-9 place-items-center rounded-xl text-[18px] transition-transform hover:scale-125 hover:bg-white/10"
                >
                  {e}
                </button>
              ))}
              <div className="col-span-8 my-0.5 h-px bg-white/[0.08]" />
              {EXTENDED_REACTIONS.map((e) => (
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

function SecretText({ body, meId, peerId, chatId, senderId, mine }: { body: string; meId?: string; peerId?: string | null; chatId: string; senderId: string; mine: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    setText(null); setUnavailable(false);
    if (!meId || !peerId) { setUnavailable(true); return; }
    decryptSecretText(meId, peerId, chatId, senderId, body)
      .then((value) => { if (alive) setText(value); })
      .catch(() => { if (alive) setUnavailable(true); });
    return () => { alive = false; };
  }, [body, meId, peerId, chatId, senderId]);
  if (text !== null) return <RichText body={text} mine={mine} />;
  return <span className="italic opacity-75">{unavailable ? "Encrypted message unavailable on this device" : "Decrypting…"}</span>;
}

function SmilePlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="10" cy="10" r="8" />
      <line x1="7.5" y1="9" x2="7.51" y2="9" />
      <line x1="12.5" y1="9" x2="12.51" y2="9" />
      <path d="M8.5 13a3.5 3.5 0 0 0 3 1.8c.83 0 1.6-.3 2.2-.8" />
      <path d="M19 16l2 4h-4l2-4z" strokeWidth="1.6" />
    </svg>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-[13px] transition-colors ${
        danger ? "text-rose-300 hover:bg-rose-500/10" : "text-slate-200 hover:bg-white/[0.07]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/* ------------------------------ rich text -------------------------------- */

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;
const CODE_BLOCK_RE = /```([\s\S]*?)```/g;

function RichText({ body, mine, searchQuery }: { body: string; mine: boolean; searchQuery?: string }) {
  // Split into code-block and normal segments first.
  const segments: { code: boolean; text: string }[] = [];
  let last = 0;
  for (const m of body.matchAll(CODE_BLOCK_RE)) {
    if (m.index! > last) segments.push({ code: false, text: body.slice(last, m.index) });
    segments.push({ code: true, text: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < body.length) segments.push({ code: false, text: body.slice(last) });

  return (
    <div className="message-text whitespace-pre-wrap break-words">
      {segments.map((seg, i) =>
        seg.code ? (
          <pre
            key={i}
            className={`my-1.5 overflow-x-auto rounded-xl p-2.5 font-mono text-[12px] leading-relaxed ${
              mine ? "bg-black/30 text-violet-50" : "bg-black/40 text-emerald-100"
            }`}
          >
            {seg.text.replace(/^\n/, "")}
          </pre>
        ) : (
          <span key={i}>{renderInline(seg.text, mine, searchQuery)}</span>
        )
      )}
    </div>
  );
}

function renderInline(text: string, mine: boolean, searchQuery?: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const parts = text.split(URL_RE);
  parts.forEach((part, i) => {
    if (URL_RE.test(part)) {
      URL_RE.lastIndex = 0;
      out.push(
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noreferrer noopener"
          className={`break-all underline underline-offset-2 ${
            mine ? "text-cyan-100 hover:text-white" : "text-luma-300 hover:text-luma-200"
          }`}
        >
          {part}
        </a>
      );
      return;
    }
    URL_RE.lastIndex = 0;
    // Inline code `like this`
    const inlineParts = part.split(/`([^`\n]+)`/g);
    inlineParts.forEach((ip, j) => {
      if (j % 2 === 1) {
        out.push(
          <code
            key={`${i}-${j}`}
            className={`rounded-md px-1.5 py-0.5 font-mono text-[12px] ${
              mine ? "bg-black/30 text-violet-50" : "bg-black/40 text-amber-100"
            }`}
          >
            {ip}
          </code>
        );
        return;
      }
      // Mentions + search highlight
      out.push(<Highlighted key={`${i}-${j}`} text={ip} mine={mine} query={searchQuery} />);
    });
  });
  return out;
}

const MENTION_RE = /(^|\s)(@[a-z0-9_]{3,32})/gi;

function Highlighted({ text, mine, query }: { text: string; mine: boolean; query?: string }) {
  const q = query?.trim();
  // First pass: mentions.
  const chunks: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) chunks.push(...highlightQuery(text.slice(last, start), q, mine, key)), (key += 100);
    chunks.push(
      <span
        key={`m-${key++}`}
        className={`rounded-md px-0.5 font-semibold ${mine ? "bg-white/15 text-cyan-100" : "bg-luma-500/20 text-luma-200"}`}
      >
        {m[2]}
      </span>
    );
    last = start + m[2].length;
  }
  if (last < text.length) chunks.push(...highlightQuery(text.slice(last), q, mine, key));
  return <>{chunks}</>;
}

function highlightQuery(text: string, q: string | undefined, mine: boolean, baseKey: number): React.ReactNode[] {
  if (!q) return [text];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (true) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={`h-${baseKey}-${k++}`} className={`rounded-sm ${mine ? "bg-amber-200/90 text-black" : "bg-amber-300/85 text-black"}`}>
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  return out;
}

/* ------------------------------- media ----------------------------------- */

function MediaBlock({ message }: { message: MessageWithMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(false);

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
      <>
        <button onClick={() => setLightbox(true)} className="block" aria-label="Open image">
          <img
            src={url}
            alt={message.media_name ?? "image"}
            className="max-h-72 w-full max-w-xs cursor-zoom-in rounded-xl object-cover"
            loading="lazy"
          />
        </button>
        {lightbox && createPortal(
          <div className="fixed inset-0 z-[600] grid place-items-center bg-black/90 p-4 backdrop-blur-sm" onClick={() => setLightbox(false)} role="dialog" aria-modal="true" aria-label="Image viewer">
            <button onClick={() => setLightbox(false)} className="absolute right-5 top-5 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white" aria-label="Close image"><X className="h-5 w-5" /></button>
            <motion.img src={url} alt={message.media_name ?? "image"} className="max-h-[88vh] max-w-full rounded-2xl object-contain" style={{ touchAction: "none" }}
              drag="y" dragConstraints={{ top: 0, bottom: 0 }} dragElastic={0.4}
              onDragEnd={(_, info) => { if (info.offset.y > 100 || info.velocity.y > 700) setLightbox(false); }}
              onClick={(event) => event.stopPropagation()} />
            <a href={url} download={message.media_name ?? undefined} className="absolute bottom-6 right-6 flex items-center gap-2 rounded-2xl bg-white/10 px-4 py-2 text-sm text-white ring-1 ring-white/20 hover:bg-white/20" onClick={(event) => event.stopPropagation()}><Download className="h-4 w-4" /> Download</a>
          </div>, document.body
        )}
      </>
    );
  }

  if (isVideo(message.media_type, message.media_name)) {
    return (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        className="max-h-72 w-full max-w-xs rounded-xl"
      />
    );
  }

  if (isAudio(message.media_type, message.media_name)) {
    const dur = message.media_duration;
    return (
      <div className="flex w-64 items-center gap-2.5 rounded-2xl border border-white/10 bg-black/30 px-3 py-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-luma-500/40">
          <Play className="h-4 w-4 text-luma-100" />
        </span>
        <div className="min-w-0 flex-1">
          <audio src={url} controls className="h-8 w-full" preload="metadata" />
          <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500">
            <span className="truncate">{message.media_name ?? "Voice message"}</span>
            {dur != null && <span>{formatDuration(dur)}</span>}
          </div>
        </div>
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
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/10">
        <FileIcon className="h-5 w-5" />
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

function formatDuration(total: number): string {
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ------------------------------ typing bubble ---------------------------- */

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
