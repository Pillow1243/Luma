import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Info, Loader2, MoreVertical, Search, Users } from "lucide-react";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { supabase } from "../lib/supabase";
import {
  deleteMessage,
  hydrateMessages,
  loadMessages,
  markRead,
  mediaUrl,
  sendMessage,
  setTyping,
  toggleReaction,
  uploadChatMedia,
} from "../lib/data";
import { relativeDay, shouldShowDayGroup } from "../lib/format";
import type { ChatSummary, Message, MessageWithMeta, Reaction } from "../lib/types";
import { useToast } from "../context/ToastContext";

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
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyTo, setReplyTo] = useState<MessageWithMeta | null>(null);
  const [uploading, setUploading] = useState<{ name: string; size: number } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [peerReadAt, setPeerReadAt] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | null>(null);

  /* ----------------------------- initial load ---------------------------- */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMessages([]);
    setReplyTo(null);
    loadMessages(chatId)
      .then((rows) => alive && setMessages(rows))
      .catch((err) => alive && toast.push(err.message ?? "Could not load messages", "error"))
      .finally(() => alive && setLoading(false));
    markRead(chatId, meId).catch(() => {});
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
      .select("user_id,last_read_at")
      .eq("chat_id", chatId)
      .neq("user_id", meId)
      .then(({ data }) => {
        if (!alive || !data?.length) return;
        const latest = data
          .map((r) => r.last_read_at as string)
          .sort()
          .pop();
        setPeerReadAt(latest ?? null);
      });
    return () => {
      alive = false;
    };
  }, [chatId, meId, messages.length]);

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
          const row = payload.new as Message;
          setMessages((prev) => prev.map((m) => (m.id === row.id ? { ...m, ...row } : m)));
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

  /* ----------------------- scroll & read management ---------------------- */
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
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
    if (nearBottom) {
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
      markRead(chatId, meId).catch(() => {});
    }
  }, [messages.length, chatId, meId]);

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
  async function handleSend(body: string) {
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
      reactions: [],
      pending: true,
      replyTo: replyTo ?? null,
    };
    setMessages((prev) => [...prev, optimistic]);
    const reply = replyTo?.id ?? null;
    setReplyTo(null);
    requestAnimationFrame(() => scrollToBottom());

    try {
      const saved = await sendMessage({ chatId, senderId: meId, body, replyTo: reply });
      const [hydrated] = await hydrateMessages([saved]);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? hydrated : m)));
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m))
      );
      toast.push(err instanceof Error ? err.message : "Message failed to send", "error");
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files).slice(0, 5);
    for (const file of list) {
      if (file.size > 20 * 1024 * 1024) {
        toast.push(`${file.name} is larger than 20 MB`, "error");
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
        // Reflect the upload immediately instead of waiting for realtime echo.
        mediaUrl(media.path).catch(() => {});
        const [hydrated] = await hydrateMessages([saved]);
        setMessages((prev) =>
          prev.some((m) => m.id === saved.id) ? prev : [...prev, hydrated]
        );
        setReplyTo(null);
      } catch (err) {
        toast.push(err instanceof Error ? err.message : "Upload failed", "error");
      } finally {
        setUploading(null);
      }
    }
  }

  async function handleReact(message: MessageWithMeta, emoji: string) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== message.id) return m;
        const mine = m.reactions.find((r) => r.user_id === meId && r.emoji === emoji);
        return {
          ...m,
          reactions: mine
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

  async function handleDelete(message: MessageWithMeta) {
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    try {
      await deleteMessage(message.id);
      toast.push("Message deleted", "success");
    } catch {
      toast.push("Only the sender can delete this", "error");
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

  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return messages;
    const t = searchTerm.toLowerCase();
    return messages.filter(
      (m) =>
        m.body?.toLowerCase().includes(t) || m.media_name?.toLowerCase().includes(t)
    );
  }, [messages, searchTerm]);

  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col">
      {/* ------------------------------- header ------------------------------ */}
      <header className="safe-top z-20 flex items-center gap-2 border-b border-white/[0.07] bg-luma-ink/60 px-2.5 py-2.5 backdrop-blur-2xl sm:px-4">
        <button onClick={onBack} className="btn-icon lg:hidden" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>

        <button onClick={onOpenInfo} className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 py-1 text-left transition-colors hover:bg-white/[0.05]">
          <Avatar
            profile={
              summary.chat.is_group
                ? null
                : summary.participants.find((p) => p.id !== meId)
            }
            label={summary.chat.is_group ? summary.chat.name ?? "Group" : undefined}
            group={summary.chat.is_group}
            size={40}
          />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold text-white">
              {summary.chat.is_group
                ? summary.chat.name || "Group chat"
                : summary.participants.find((p) => p.id !== meId)?.display_name ??
                  "Direct message"}
            </div>
            <div className="truncate text-[11.5px] text-slate-400">
              {summary.typing.length > 0 ? (
                <span className="text-luma-300">typing…</span>
              ) : summary.chat.is_group ? (
                `${summary.participants.length} members`
              ) : (
                "Tap for details"
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
                className="field py-2.5 pl-10 text-[13.5px]"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ----------------------------- messages ----------------------------- */}
      <div
        ref={scroller}
        className="relative flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyChat isGroup={summary.chat.is_group} name={summary.chat.name} searching={Boolean(searchTerm)} />
        ) : (
          <>
            {filtered.map((message, i) => {
              const prev = filtered[i - 1];
              const showDay = shouldShowDayGroup(message.created_at, prev?.created_at);
              const grouped =
                !showDay && prev?.sender_id === message.sender_id && !message.reply_to;
              const mine = message.sender_id === meId;
              const read = Boolean(
                peerReadAt && new Date(peerReadAt).getTime() >= new Date(message.created_at).getTime()
              );
              return (
                <div key={message.id}>
                  {showDay && (
                    <div className="my-4 flex items-center justify-center">
                      <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[10.5px] font-medium uppercase tracking-wider text-slate-400 backdrop-blur">
                        {relativeDay(message.created_at)}
                      </span>
                    </div>
                  )}
                  <MessageBubble
                    message={message}
                    mine={mine}
                    grouped={grouped}
                    showAvatar={!grouped}
                    read={read}
                    onReact={(emoji) => handleReact(message, emoji)}
                    onReply={() => setReplyTo(message)}
                    onDelete={() => handleDelete(message)}
                    onJumpTo={jumpTo}
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
      </div>

      <Composer
        onSend={handleSend}
        onTyping={onTyping}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        uploading={uploading}
        onFiles={handleFiles}
      />
    </section>
  );
}

function EmptyChat({
  isGroup,
  name,
  searching,
}: {
  isGroup: boolean;
  name?: string | null;
  searching?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 24 }}
        className="relative grid h-20 w-20 place-items-center rounded-[28px] bg-luma-gradient shadow-glow"
      >
        <Users className="h-8 w-8 text-white/90" />
        <span className="absolute inset-0 -z-10 animate-pulseRing rounded-[28px] bg-luma-500/30" />
      </motion.div>
      <h3 className="mt-5 text-[16px] font-semibold text-white">
        {searching ? "No matches" : isGroup ? `Welcome to ${name || "the group"}` : "Say hello 👋"}
      </h3>
      <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-slate-400">
        {searching
          ? "Try a different word."
          : "This is the beginning of your conversation. Messages are delivered in realtime and end-to-end on Supabase."}
      </p>
    </div>
  );
}

export { MoreVertical };
