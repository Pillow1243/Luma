import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowDown,
  Hash,
  Info,
  Loader2,
  Pin,
  Search,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { Composer, type SendPayload } from "./Composer";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { ForwardModal } from "./ForwardModal";
import { ReportModal } from "./ReportModal";
import { supabase } from "../lib/supabase";
import {
  copyMediaToChat,
  deleteMessageForEveryone,
  deleteMessageForMe,
  editMessage,
  getMyParticipant,
  hydrateMessages,
  listPinnedMessages,
  listStarredIds,
  loadMessages,
  markRead,
  mediaUrl,
  profileHeartbeat,
  reportMessage,
  searchMessages,
  sendMessage,
  setMessagePinned,
  setTyping,
  starMessage,
  toggleReaction,
  unstarMessage,
  uploadChatMedia,
  validateUpload,
} from "../lib/data";
import { relativeDay, shouldShowDayGroup } from "../lib/format";
import type { ChatSummary, Message, MessageWithMeta, Reaction } from "../lib/types";
import { useToast } from "../context/ToastContext";
import { useTheme } from "../context/ThemeContext";

export function ChatWindow({
  summary,
  meId,
  onBack,
  onOpenInfo,
}: {
  summary: ChatSummary;
  meId: string;
  onBack: () => void;
  onOpenInfo: () => void;
}) {
  const toast = useToast();
  const chatId = summary.chat.id;
  const kind = summary.chat.kind;
  const isSaved = kind === "saved";
  const isChannel = kind === "channel";
  const canPost = !isChannel || summary.isAdmin;
  const [searchParams, setSearchParams] = useSearchParams();
  const { wallpaper } = useTheme();

  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [replyTo, setReplyTo] = useState<MessageWithMeta | null>(null);
  const [uploading, setUploading] = useState<{ name: string; size: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchFromMe, setSearchFromMe] = useState(false);
  const [searchMediaOnly, setSearchMediaOnly] = useState(false);
  const [peerReadAt, setPeerReadAt] = useState<string | null>(null);
  const [peerLastSeen, setPeerLastSeen] = useState<string | null>(null);
  const [peerShowsLastSeen, setPeerShowsLastSeen] = useState(true);
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<MessageWithMeta[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [forwardSource, setForwardSource] = useState<MessageWithMeta | null>(null);
  const [reportTarget, setReportTarget] = useState<MessageWithMeta | null>(null);
  const [unreadCutoff, setUnreadCutoff] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | null>(null);
  const prevScrollHeight = useRef(0);

  const peer = summary.participants.find((p) => p.id !== meId) ?? null;
  const unreadBelow = useMemo(() => {
    if (!unreadCutoff) return 0;
    return messages.filter(
      (m) => m.sender_id !== meId && m.created_at > unreadCutoff
    ).length;
  }, [messages, unreadCutoff, meId]);

  const pinnedLatest = pinned[0] ?? null;

  /* ----------------------------- initial load ---------------------------- */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMessages([]);
    setReplyTo(null);
    setHasMore(true);
    setPinned([]);
    setEditingId(null);
    setUnreadCutoff(null);

    getMyParticipant(chatId, meId)
      .then((me) => {
        if (alive) setUnreadCutoff(me?.last_read_at ?? null);
      })
      .catch(() => {});

    loadMessages(chatId, { limit: 80 })
      .then((rows) => {
        if (!alive) return;
        setMessages(rows);
        setHasMore(rows.length >= 80);
      })
      .catch((err) => alive && toast.push(err.message ?? "Could not load messages", "error"))
      .finally(() => alive && setLoading(false));

    markRead(chatId, meId).catch(() => {});
    profileHeartbeat(meId).catch(() => {});
    listPinnedMessages(chatId).then((rows) => alive && setPinned(rows)).catch(() => {});
    listStarredIds(meId)
      .then((ids) => alive && setStarredIds(new Set(ids)))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, meId]);

  /* ------------------------- read receipts (peer) ------------------------ */
  useEffect(() => {
    let alive = true;
    supabase
      .from("chat_participants")
      .select("user_id,last_read_at,last_seen_at")
      .eq("chat_id", chatId)
      .neq("user_id", meId)
      .then(({ data }) => {
        if (!alive || !data?.length) return;
        const latestRead = data.map((r) => r.last_read_at as string).sort().pop();
        const latestSeen = data.map((r) => r.last_seen_at as string).filter(Boolean).sort().pop();
        setPeerReadAt(latestRead ?? null);
        setPeerLastSeen(latestSeen ?? null);
      });
    // peer last-seen privacy lives on the profile row
    if (kind === "direct" && peer) {
      setPeerShowsLastSeen(peer.show_last_seen);
      if (peer.last_seen_at) setPeerLastSeen(peer.last_seen_at);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, meId, peer?.id]);

  /* ------------------------------- realtime ------------------------------ */
  useEffect(() => {
    const channel = supabase.channel(`chat:${chatId}`, {
      config: { presence: { key: meId } },
    });

    channel
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
        async (payload) => {
          const row = payload.new as Message;
          const [hydrated] = await hydrateMessages([row]);
          setMessages((prev) =>
            prev.some((m) => m.id === row.id) ? prev : [...prev, hydrated]
          );
          if (row.sender_id !== meId) {
            markRead(chatId, meId).catch(() => {});
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
        (payload) => {
          const row = payload.new as Message & { deleted_for?: string[] };
          // Deletion for me should remove it from my list.
          if (row.deleted_for?.includes(meId)) {
            setMessages((prev) => prev.filter((m) => m.id !== row.id));
            return;
          }
          setMessages((prev) =>
            prev.map((m) => (m.id === row.id ? { ...m, ...row } : m))
          );
          setPinned((prev) =>
            row.pinned_at
              ? prev.some((m) => m.id === row.id)
                ? prev.map((m) => (m.id === row.id ? { ...m, ...row } : m))
                : [{ ...row, reactions: [] }, ...prev]
              : prev.filter((m) => m.id !== row.id)
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "messages" },
        (payload) => {
          const old = payload.old as { id?: string };
          if (old?.id) setMessages((prev) => prev.filter((m) => m.id !== old.id));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_reactions" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Reaction;
          if (!row?.message_id) return;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== row.message_id) return m;
              if (payload.eventType === "DELETE") {
                return {
                  ...m,
                  reactions: m.reactions.filter(
                    (r) => !(r.user_id === row.user_id && r.emoji === row.emoji)
                  ),
                };
              }
              if (payload.eventType === "INSERT") {
                if (m.reactions.some((r) => r.user_id === row.user_id && r.emoji === row.emoji))
                  return m;
                return { ...m, reactions: [...m.reactions, row] };
              }
              return m;
            })
          );
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "chat_participants" },
        (payload) => {
          const row = payload.new as { user_id: string; last_read_at: string };
          if (row.user_id !== meId) setPeerReadAt(row.last_read_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [chatId, meId]);

  /* ------------------------- scroll management --------------------------- */
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  useEffect(() => {
    if (!loading) {
      requestAnimationFrame(() => scrollToBottom("auto"));
    }
  }, [loading, scrollToBottom]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Preserve position when prepending older messages.
    if (prevScrollHeight.current && el.scrollHeight !== prevScrollHeight.current) {
      el.scrollTop = el.scrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = 0;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (nearBottom) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
      markRead(chatId, meId).catch(() => {});
    }
  }, [messages.length, chatId, meId]);

  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const el = scroller.current;
    if (el) prevScrollHeight.current = el.scrollHeight;
    setLoadingOlder(true);
    try {
      const older = await loadMessages(chatId, { limit: 60, before: messages[0].created_at });
      setMessages((prev) => [...older, ...prev]);
      if (older.length < 60) setHasMore(false);
    } catch {
      prevScrollHeight.current = 0;
      toast.push("Could not load older messages", "error");
    } finally {
      setLoadingOlder(false);
    }
  }

  // Deep-link: /chat/x?jump=messageId
  useEffect(() => {
    const jump = searchParams.get("jump");
    if (jump && !loading) {
      requestAnimationFrame(() => {
        jumpTo(jump);
        searchParams.delete("jump");
        setSearchParams(searchParams, { replace: true });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, loading, messages.length]);

  /* -------------------------------- typing ------------------------------- */
  const onTyping = useCallback(
    (isTyping: boolean) => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      setTyping(chatId, meId, isTyping).catch(() => {});
      if (isTyping) {
        typingTimer.current = window.setTimeout(() => {
          setTyping(chatId, meId, false).catch(() => {});
        }, 5000);
      }
    },
    [chatId, meId]
  );

  /* -------------------------------- sending ------------------------------ */
  async function handleSend({ body, mentions }: SendPayload) {
    const tempId = `temp-${Date.now()}`;
    const optimistic: MessageWithMeta = {
      id: tempId,
      chat_id: chatId,
      sender_id: meId,
      body,
      reply_to: replyTo?.id ?? null,
      media_path: null,
      media_name: null,
      media_type: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      pinned_at: null,
      forwarded_from: null,
      expires_at: null,
      mentions,
      media_duration: null,
      media_waveform: null,
      reactions: [],
      pending: true,
      replyTo: replyTo ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    const reply = replyTo?.id ?? null;
    setReplyTo(null);
    requestAnimationFrame(() => scrollToBottom());

    try {
      const saved = await sendMessage({ chatId, senderId: meId, body, replyTo: reply, mentions });
      const [hydrated] = await hydrateMessages([saved]);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? hydrated : m)));
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m))
      );
      toast.push(err instanceof Error ? err.message : "Message failed to send", "error");
    }
  }

  async function handleVoice(blob: Blob, durationSec: number) {
    setUploading({ name: "Voice message", size: blob.size });
    try {
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type || "audio/webm" });
      const media = await uploadChatMedia(chatId, meId, file);
      const saved = await sendMessage({
        chatId,
        senderId: meId,
        media,
        mediaDuration: durationSec,
        replyTo: replyTo?.id ?? null,
      });
      const [hydrated] = await hydrateMessages([saved]);
      setMessages((prev) =>
        prev.some((m) => m.id === saved.id) ? prev : [...prev, hydrated]
      );
      setReplyTo(null);
      requestAnimationFrame(() => scrollToBottom());
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not send voice message", "error");
    } finally {
      setUploading(null);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files).slice(0, 5);
    for (const file of list) {
      const problem = validateUpload(file);
      if (problem) {
        toast.push(problem, "error");
        continue;
      }
      setUploading({ name: file.name, size: file.size });
      try {
        const media = await uploadChatMedia(chatId, meId, file);
        const saved = await sendMessage({
          chatId,
          senderId: meId,
          media,
          replyTo: replyTo?.id ?? null,
        });
        mediaUrl(media.path).catch(() => {});
        const [hydrated] = await hydrateMessages([saved]);
        setMessages((prev) =>
          prev.some((m) => m.id === saved.id) ? prev : [...prev, hydrated]
        );
        setReplyTo(null);
        requestAnimationFrame(() => scrollToBottom());
      } catch (err) {
        toast.push(err instanceof Error ? err.message : "Upload failed", "error");
      } finally {
        setUploading(null);
      }
    }
  }

  async function handleForwardTo(target: ChatSummary) {
    const src = forwardSource;
    if (!src) return;
    const targetId = target.chat.id;
    try {
      let media: { path: string; name: string; type: string } | null = null;
      if (src.media_path) {
        const copied = await copyMediaToChat(src.media_path, targetId, meId, src.media_name ?? undefined);
        media = { ...copied, type: src.media_type ?? copied.type };
      }
      await sendMessage({
        chatId: targetId,
        senderId: meId,
        body: src.body ?? undefined,
        media,
        forwardedFrom: src.forwarded_from ?? src.id,
        mediaDuration: src.media_duration ?? null,
        mediaWaveform: src.media_waveform ?? null,
      });
      toast.push("Forwarded", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Forward failed", "error");
      throw err;
    }
  }

  async function handleReact(message: MessageWithMeta, emoji: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== message.id) return m;
        const mineReaction = m.reactions.find((r) => r.user_id === meId && r.emoji === emoji);
        return {
          ...m,
          reactions: mineReaction
            ? m.reactions.filter((r) => !(r.user_id === meId && r.emoji === emoji))
            : [...m.reactions, { message_id: m.id, user_id: meId, emoji, created_at: new Date().toISOString() }],
        };
      })
    );
    try {
      await toggleReaction(message.id, meId, emoji);
    } catch {
      /* realtime will reconcile */
    }
  }

  async function handleDeleteEveryone(message: MessageWithMeta) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === message.id ? { ...m, body: null, media_path: null, media_name: null, media_type: null, deleted_at: new Date().toISOString() } : m
      )
    );
    try {
      await deleteMessageForEveryone(message.id);
      toast.push("Message deleted for everyone", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Only the sender or an admin can delete this", "error");
    }
  }

  async function handleDeleteMe(message: MessageWithMeta) {
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    try {
      await deleteMessageForMe(message.id);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not delete", "error");
    }
  }

  function startEdit(message: MessageWithMeta) {
    if (!message.body || message.deleted_at) return;
    setEditingId(message.id);
    setEditDraft(message.body);
  }

  async function saveEdit() {
    const id = editingId;
    if (!id) return;
    const body = editDraft.trim();
    if (!body) {
      toast.push("Message cannot be empty", "error");
      return;
    }
    try {
      const updated = await editMessage(id, body);
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updated } : m))
      );
      setEditingId(null);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not edit message", "error");
    }
  }

  async function handleTogglePin(message: MessageWithMeta) {
    const pin = !message.pinned_at;
    try {
      await setMessagePinned(message.id, pin);
      toast.push(pin ? "Pinned" : "Unpinned", "success");
      const rows = await listPinnedMessages(chatId);
      setPinned(rows);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Only group admins can pin here", "error");
    }
  }

  async function handleToggleStar(message: MessageWithMeta) {
    const isStarred = starredIds.has(message.id);
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (isStarred) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
    try {
      if (isStarred) await unstarMessage(meId, message.id);
      else await starMessage(meId, message.id);
    } catch {
      setStarredIds((prev) => {
        const next = new Set(prev);
        if (isStarred) next.add(message.id);
        else next.delete(message.id);
        return next;
      });
      toast.push("Could not update Starred", "error");
    }
  }

  async function handleReport(reason: string, details: string) {
    if (!reportTarget) return;
    try {
      await reportMessage({ chatId, messageId: reportTarget.id, reporter: meId, reason, details });
      toast.push("Report sent to the chat admins", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not send report", "error");
    }
  }

  function jumpTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate(
      [
        { boxShadow: "0 0 0 0 rgba(139,92,246,0.85)" },
        { boxShadow: "0 0 0 8px rgba(139,92,246,0)" },
      ],
      { duration: 1200, easing: "ease-out" }
    );
  }

  /* ------------------------------ searching ------------------------------ */
  const [serverResults, setServerResults] = useState<MessageWithMeta[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const t = searchTerm.trim();
    if (!searchOpen || (!t && !searchMediaOnly)) {
      setServerResults(null);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(() => {
      searchMessages({
        term: t,
        chatId,
        mediaOnly: searchMediaOnly,
        senderId: searchFromMe ? meId : null,
      })
        .then((rows) => setServerResults(rows))
        .catch(() => setServerResults([]))
        .finally(() => setSearching(false));
    }, 220);
    return () => window.clearTimeout(handle);
  }, [searchTerm, searchMediaOnly, searchFromMe, searchOpen, chatId, meId]);

  const filtered = useMemo(() => {
    if (serverResults) return serverResults.slice().reverse();
    return messages;
  }, [messages, serverResults]);

  const canModerate = summary.isAdmin;

  const headerSubtitle = summary.typing.length > 0
    ? "typing…"
    : isChannel
      ? `${summary.participants.length} subscriber${summary.participants.length === 1 ? "" : "s"}`
      : kind === "saved"
        ? "Your private space"
        : summary.chat.is_group
          ? `${summary.participants.length} members`
          : peerLastSeen && peerShowsLastSeen
            ? `Last seen ${new Date(peerLastSeen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
            : "Direct message";

  const unreadInsertBefore = useMemo(() => {
    if (!unreadCutoff) return null;
    const first = filtered.find(
      (m) => m.sender_id !== meId && m.created_at > unreadCutoff
    );
    return first?.id ?? null;
  }, [filtered, unreadCutoff, meId]);

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      {/* ------------------------------- header ------------------------------ */}
      <header className="safe-top z-20 flex items-center gap-2 border-b border-white/[0.07] bg-luma-ink/60 px-2.5 py-2.5 backdrop-blur-2xl sm:px-4">
        <button onClick={onBack} className="btn-icon lg:hidden" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>

        <button onClick={onOpenInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 py-1 text-left transition-colors hover:bg-white/[0.05]">
          <Avatar
            profile={isChannel || summary.chat.is_group || isSaved ? null : peer}
            label={isSaved ? "Saved Messages" : isChannel ? summary.chat.name ?? "Channel" : summary.chat.name ?? undefined}
            group={summary.chat.is_group || isChannel}
            saved={isSaved}
            chatAvatarPath={summary.chat.avatar_path}
            size={40}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-white">
              {isChannel && <Hash className="h-4 w-4 shrink-0 text-luma-300" />}
              <span className="truncate">
                {isSaved
                  ? "Saved Messages"
                  : isChannel
                    ? summary.chat.name || "Channel"
                    : summary.chat.is_group
                      ? summary.chat.name || "Group chat"
                      : peer?.display_name ?? "Direct message"}
              </span>
            </div>
            <div className="truncate text-[11.5px] text-slate-400">
              {summary.typing.length > 0 ? (
                <span className="text-luma-300">typing…</span>
              ) : (
                headerSubtitle
              )}
            </div>
          </div>
        </button>

        <button
          onClick={() => setSearchOpen((v) => !v)}
          className="btn-icon h-10 w-10"
          aria-label="Search messages"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>
        <button onClick={onOpenInfo} className="btn-icon h-10 w-10" aria-label="Chat info">
          <Info className="h-[18px] w-[18px]" />
        </button>
      </header>

      {/* pinned bar */}
      {pinnedLatest && (
        <button
          onClick={() => jumpTo(pinnedLatest.id)}
          className="z-10 flex items-center gap-2 border-b border-luma-400/20 bg-luma-500/[0.13] px-4 py-1.5 text-left backdrop-blur-xl transition-colors hover:bg-luma-500/[0.2]"
        >
          <Pin className="h-3.5 w-3.5 shrink-0 fill-luma-300 text-luma-300" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-luma-100">
            <span className="font-semibold">Pinned:</span>{" "}
            {pinnedLatest.body || (pinnedLatest.media_path ? "📎 Attachment" : "Message")}
          </span>
          {pinned.length > 1 && (
            <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] text-luma-100">
              +{pinned.length - 1}
            </span>
          )}
        </button>
      )}

      <AnimatePresence>
        {searchOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden border-b border-white/[0.06] bg-luma-ink/40 px-3 backdrop-blur-xl"
          >
            <div className="relative py-2">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                autoFocus
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search in this conversation…"
                className="field py-2.5 pl-10 pr-10 text-[13.5px]"
              />
              {(searchTerm || searchMediaOnly) && (
                <button
                  onClick={() => {
                    setSearchTerm("");
                    setSearchMediaOnly(false);
                    setSearchFromMe(false);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-500 hover:bg-white/10 hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 pb-2">
              <button
                onClick={() => setSearchFromMe((v) => !v)}
                className={`chip transition-colors ${searchFromMe ? "border-luma-400/60 bg-luma-500/25 text-luma-100" : ""}`}
              >
                From me
              </button>
              <button
                onClick={() => setSearchMediaOnly((v) => !v)}
                className={`chip transition-colors ${searchMediaOnly ? "border-luma-400/60 bg-luma-500/25 text-luma-100" : ""}`}
              >
                Media only
              </button>
              {searching && <Loader2 className="ml-auto h-4 w-4 animate-spin text-slate-500" />}
              {serverResults && !searching && (
                <span className="ml-auto text-[11px] text-slate-500">{serverResults.length} result{serverResults.length === 1 ? "" : "s"}</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ----------------------------- messages ----------------------------- */}
      <div
        ref={scroller}
        className={`wallpaper ${wallpaper === "stars" ? "wallpaper-stars" : ""} ${wallpaper === "aurora" ? "wallpaper-aurora" : ""} relative flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6`}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyChat kind={kind} name={summary.chat.name} searching={Boolean(searchTerm || searchMediaOnly)} />
        ) : (
          <>
            {hasMore && !serverResults && (
              <div className="mb-3 flex justify-center">
                <button onClick={loadOlder} disabled={loadingOlder} className="btn-ghost px-4 py-1.5 text-[12px]">
                  {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Load older messages"}
                </button>
              </div>
            )}
            {filtered.map((message, i) => {
              const prev = filtered[i - 1];
              const showDay = shouldShowDayGroup(message.created_at, prev?.created_at);
              const grouped =
                !showDay && prev?.sender_id === message.sender_id && !message.reply_to;
              const mine = message.sender_id === meId;
              const read = Boolean(
                peerReadAt && new Date(peerReadAt).getTime() >= new Date(message.created_at).getTime()
              );
              const showUnreadHere = unreadInsertBefore === message.id;
              return (
                <div key={message.id}>
                  {showDay && (
                    <div className="my-4 flex items-center justify-center">
                      <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[10.5px] font-medium uppercase tracking-wider text-slate-400 backdrop-blur">
                        {relativeDay(message.created_at)}
                      </span>
                    </div>
                  )}
                  {showUnreadHere && (
                    <div className="my-3 flex items-center gap-3" aria-label="Unread messages below">
                      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-luma-400/60 to-transparent" />
                      <span className="rounded-full border border-luma-400/40 bg-luma-500/20 px-3 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-luma-200">
                        Unread
                      </span>
                      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-luma-400/60 to-transparent" />
                    </div>
                  )}
                  <MessageBubble
                    message={message}
                    mine={mine}
                    grouped={grouped}
                    showAvatar={!grouped}
                    read={read}
                    starred={starredIds.has(message.id)}
                    canModerate={canModerate}
                    searchQuery={searchTerm.trim() || undefined}
                    editing={editingId === message.id}
                    editDraft={editDraft}
                    onEditDraftChange={setEditDraft}
                    onEditSave={saveEdit}
                    onEditCancel={() => setEditingId(null)}
                    onReact={(emoji) => handleReact(message, emoji)}
                    onReply={() => setReplyTo(message)}
                    onEdit={() => startEdit(message)}
                    onDeleteMe={() => handleDeleteMe(message)}
                    onDeleteEveryone={() => handleDeleteEveryone(message)}
                    onForward={() => setForwardSource(message)}
                    onTogglePin={() => handleTogglePin(message)}
                    onToggleStar={() => handleToggleStar(message)}
                    onJumpTo={jumpTo}
                    onReport={() => setReportTarget(message)}
                  />
                </div>
              );
            })}
            <AnimatePresence>
              {summary.typing.length > 0 && (
                <TypingBubble names={summary.typing.map((p) => p.display_name)} />
              )}
            </AnimatePresence>
            <div ref={bottomRef} className="h-1" />
          </>
        )}

        {/* jump to latest when unread pile up */}
        {unreadBelow > 0 && (
          <button
            onClick={() => {
              scrollToBottom();
              setUnreadCutoff(new Date().toISOString());
            }}
            className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-luma-400/40 bg-luma-panel/90 px-4 py-2 text-[12px] font-medium text-luma-100 shadow-glow backdrop-blur-xl"
          >
            <ArrowDown className="h-4 w-4" /> {unreadBelow} unread
          </button>
        )}
      </div>

      {canPost ? (
        <Composer
          chatId={chatId}
          meId={meId}
          participants={summary.participants}
          onSend={handleSend}
          onTyping={onTyping}
          onVoice={handleVoice}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          uploading={uploading}
          onFiles={handleFiles}
          placeholder={isChannel ? "Broadcast to subscribers…" : isSaved ? "Write to yourself…" : "Message…"}
        />
      ) : (
        <div className="border-t border-white/[0.07] bg-luma-ink/55 px-4 py-4 text-center backdrop-blur-2xl">
          <p className="text-[12px] text-slate-500">
            Only channel admins can post. You are subscribed — new posts appear here.
          </p>
        </div>
      )}

      <ForwardModal
        open={Boolean(forwardSource)}
        onClose={() => setForwardSource(null)}
        meId={meId}
        onPick={handleForwardTo}
      />
      <ReportModal
        open={Boolean(reportTarget)}
        onClose={() => setReportTarget(null)}
        title={reportTarget ? `Report message in this ${isChannel ? "channel" : summary.chat.is_group ? "group" : "conversation"}` : ""}
        onSubmit={handleReport}
      />
    </section>
  );
}

function EmptyChat({
  kind,
  name,
  searching,
}: {
  kind: string;
  name?: string | null;
  searching?: boolean;
}) {
  const title = searching
    ? "No matches"
    : kind === "saved"
      ? "Your private space"
      : kind === "channel"
        ? `Welcome to ${name || "the channel"}`
        : kind === "group"
          ? `Welcome to ${name || "the group"}`
          : "Say hello 👋";
  const body = searching
    ? "Try a different word or filter."
    : kind === "saved"
      ? "Forward things here, stash links, jot quick notes — everything stays private to you."
      : kind === "channel"
        ? "Broadcasts from this channel appear here."
        : "This is the beginning of your conversation. Messages are stored securely and delivered in real time.";
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 24 }}
        className="relative grid h-20 w-20 place-items-center rounded-[28px] bg-luma-gradient shadow-glow"
      >
        {kind === "saved" ? (
          <Pin className="h-8 w-8 rotate-45 text-white/90" />
        ) : kind === "channel" ? (
          <Hash className="h-8 w-8 text-white/90" />
        ) : (
          <Users className="h-8 w-8 text-white/90" />
        )}
      </motion.div>
      <h3 className="mt-5 text-[16px] font-semibold text-white">{title}</h3>
      <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}
