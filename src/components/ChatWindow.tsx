import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowDown,
  Hash,
  Info,
  Loader2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pin,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
  Video,
  Search,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { Confetti } from "./Confetti";
import { Composer, type SendPayload } from "./Composer";
import { MessageBubble, TypingBubble } from "./MessageBubble";
import { ForwardModal } from "./ForwardModal";
import { Modal } from "./Modal";
import { CreatePollModal } from "./Poll";
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
  triggerPushNotification,
  unstarMessage,
  uploadChatMedia,
  validateUpload,
} from "../lib/data";
import { previewOf, relativeDay, shouldShowDayGroup } from "../lib/format";
import type { CallRecord, ChatSummary, Message, MessageWithMeta, Reaction } from "../lib/types";
import { useToast } from "../context/ToastContext";
import { useTheme } from "../context/ThemeContext";
import { useOffline } from "../context/OfflineContext";
import { useAuth } from "../context/AuthContext";
import { useCalls } from "../context/CallContext";
import { useI18n } from "../lib/i18n";
import { cacheMessages, cachedMessages } from "../lib/offline";
import { listCalls } from "../lib/calls";
import {
  encryptSecretMediaFile,
  encryptSecretText,
  getSecretChatInfo,
  isSecretBody,
  trustPeerKey,
} from "../lib/secret";

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
  const { connection, outbox, enqueue, retry, discard } = useOffline();
  const { profile } = useAuth();
  const { startCall, busy: callBusy } = useCalls();
  const { lang, t } = useI18n();
  const chatId = summary.chat.id;
  const kind = summary.chat.kind;
  const isSaved = kind === "saved";
  const isChannel = kind === "channel";
  const canPost = !isChannel || summary.isAdmin;
  const [searchParams, setSearchParams] = useSearchParams();
  const { wallpaper } = useTheme();

  const [secretMode, setSecretMode] = useState(() => {
    try {
      return localStorage.getItem(`luma-secret:${meId}:${chatId}`) === "on";
    } catch {
      return false;
    }
  });
  const [secretInfo, setSecretInfo] = useState<{
    code: string;
    emojis: string[];
    peerPublicKey: string | null;
    keyChanged: boolean;
    verified: boolean;
  } | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [pinsModalOpen, setPinsModalOpen] = useState(false);
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [callHistory, setCallHistory] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [replyTo, setReplyTo] = useState<MessageWithMeta | null>(null);
  const [uploading, setUploading] = useState<{ name: string; size: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
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
  const typingTimer = useRef<number | null>(null);
  const prevScrollHeight = useRef(0);
  const changes = useRef<{ sequence: number; byId: Map<string, number> }>({
    sequence: 0,
    byId: new Map(),
  });
  const markChanged = useCallback((id: string) => {
    changes.current.byId.set(id, ++changes.current.sequence);
  }, []);
  const mergeFetched = useCallback((rows: MessageWithMeta[], startedAt: number) => {
    setMessages((previous) => {
      const before = new Map(previous.map((m) => [m.id, m]));
      const fetchedIds = new Set(rows.map((m) => m.id));
      const merged: MessageWithMeta[] = [];
      for (const row of rows) {
        if ((changes.current.byId.get(row.id) ?? 0) > startedAt) {
          const latest = before.get(row.id);
          if (latest) merged.push(latest);
        } else merged.push(row);
      }
      for (const row of previous)
        if (!fetchedIds.has(row.id) && (changes.current.byId.get(row.id) ?? 0) > startedAt)
          merged.push(row);
      return merged.sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }, []);
  const confettiTimer = useRef<number | null>(null);
  const [confetti, setConfetti] = useState(0);
  const celebrate = useCallback(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    setConfetti((n) => n + 1);
    if (confettiTimer.current) window.clearTimeout(confettiTimer.current);
    confettiTimer.current = window.setTimeout(() => setConfetti(0), 3000);
  }, []);
  useEffect(
    () => () => {
      if (confettiTimer.current) window.clearTimeout(confettiTimer.current);
    },
    []
  );

  const peer = summary.participants.find((p) => p.id !== meId) ?? null;
  const unreadBelow = useMemo(() => {
    if (!unreadCutoff) return 0;
    return messages.filter((m) => m.sender_id !== meId && m.created_at > unreadCutoff).length;
  }, [messages, unreadCutoff, meId]);

  const pinnedLatest = pinned[0] ?? null;

  /* ----------------------------- Ctrl/Cmd+K ------------------------------ */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  /* ----------------------------- initial load ---------------------------- */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMessages([]);
    changes.current = { sequence: 0, byId: new Map() };
    setReplyTo(null);
    setHasMore(true);
    setPinned([]);
    try {
      setSecretMode(localStorage.getItem(`luma-secret:${meId}:${chatId}`) === "on");
    } catch {
      setSecretMode(false);
    }
    setEditingId(null);
    setUnreadCutoff(null);
    setScrolledUp(false);

    getMyParticipant(chatId, meId)
      .then((me) => {
        if (alive) setUnreadCutoff(me?.last_read_at ?? null);
      })
      .catch(() => {});

    (async () => {
      const beforeCache = changes.current.sequence;
      const cached = await cachedMessages(meId, chatId).catch(() => []);
      if (!alive) return;
      if (cached.length || !navigator.onLine) {
        mergeFetched(cached, beforeCache);
        setLoading(false);
      }
      if (!navigator.onLine) {
        setHasMore(false);
        return;
      }
      try {
        const beforeFetch = changes.current.sequence;
        const rows = await loadMessages(chatId, { limit: 80 });
        if (!alive) return;
        mergeFetched(rows, beforeFetch);
        setHasMore(rows.length >= 80);
      } catch (err) {
        if (alive && !cached.length && navigator.onLine)
          toast.push((err as Error).message ?? "Could not load messages", "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();

    markRead(chatId, meId).catch(() => {});
    profileHeartbeat(meId).catch(() => {});
    listPinnedMessages(chatId)
      .then((rows) => alive && setPinned(rows))
      .catch(() => {});
    listStarredIds(meId)
      .then((ids) => alive && setStarredIds(new Set(ids)))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, meId]);

  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setMessages((prev) => {
          const now = Date.now();
          const kept = prev.filter((m) => !m.expires_at || Date.parse(m.expires_at) > now);
          return kept.length === prev.length ? prev : kept;
        }),
      15_000
    );
    return () => window.clearInterval(timer);
  }, [chatId]);

  useEffect(() => {
    if (connection !== "online") return;
    let alive = true;
    const beforeFetch = changes.current.sequence;
    loadMessages(chatId, { limit: 80 })
      .then((rows) => {
        if (alive) mergeFetched(rows, beforeFetch);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connection, chatId, mergeFetched]);

  useEffect(() => {
    if (!loading) void cacheMessages(meId, chatId, messages).catch(() => {});
  }, [meId, chatId, messages, loading]);

  useEffect(() => {
    const sent = (event: Event) => {
      const row = (event as CustomEvent<MessageWithMeta>).detail;
      if (row.chat_id !== chatId) return;
      markChanged(row.id);
      setMessages((prev) =>
        prev.some((m) => m.id === row.id) ? prev.map((m) => (m.id === row.id ? row : m)) : [...prev, row]
      );
    };
    window.addEventListener("luma:outbox-sent", sent);
    return () => window.removeEventListener("luma:outbox-sent", sent);
  }, [chatId, markChanged]);

  const allMessages = useMemo(() => {
    const ids = new Set(messages.map((m) => m.id));
    const pending: MessageWithMeta[] = outbox
      .filter((item) => item.chatId === chatId && !ids.has(item.id))
      .map((item) => ({
        id: item.id,
        chat_id: chatId,
        sender_id: meId,
        body: item.body,
        reply_to: item.replyTo,
        media_path: null,
        media_name: null,
        media_type: null,
        created_at: item.createdAt,
        edited_at: null,
        deleted_at: null,
        pinned_at: null,
        forwarded_from: null,
        expires_at: item.expiresAt,
        mentions: item.mentions,
        media_duration: null,
        media_waveform: null,
        sender: profile ?? undefined,
        reactions: [],
        pending: item.status === "queued",
        failed: item.status === "failed",
        failureReason: item.error,
        replyTo: messages.find((m) => m.id === item.replyTo) ?? null,
      }));
    return [...messages, ...pending].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [messages, outbox, chatId, meId, profile]);

  useEffect(() => {
    let alive = true;
    const refreshCalls = () => {
      if (navigator.onLine)
        void listCalls(chatId)
          .then((rows) => {
            if (alive) setCallHistory(rows);
          })
          .catch(() => {});
    };
    refreshCalls();
    const channel = supabase
      .channel(`luma:call-history:${chatId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "calls", filter: `chat_id=eq.${chatId}` },
        refreshCalls
      )
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [chatId, connection]);

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
    if (kind === "direct" && peer) {
      setPeerShowsLastSeen(peer.show_last_seen);
      setPeerLastSeen(peer.show_last_seen ? peer.last_seen_at : null);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, meId, peer?.id, peer?.show_last_seen, peer?.last_seen_at]);

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
          markChanged(row.id);
          const [hydrated] = await hydrateMessages([row]);
          setMessages((prev) =>
            prev.some((m) => m.id === row.id) ? prev : [...prev, hydrated]
          );
          if (row.sender_id !== meId) {
            if (row.body?.trim() === "🎉") celebrate();
            markRead(chatId, meId).catch(() => {});
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
        (payload) => {
          const row = payload.new as Message & { deleted_for?: string[] };
          markChanged(row.id);
          if (row.deleted_for?.includes(meId)) {
            setMessages((prev) => prev.filter((m) => m.id !== row.id));
            return;
          }
          setMessages((prev) => prev.map((m) => (m.id === row.id ? { ...m, ...row } : m)));
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
          if (old?.id) {
            markChanged(old.id);
            setMessages((prev) => prev.filter((m) => m.id !== old.id));
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_reactions" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Reaction;
          if (!row?.message_id) return;
          markChanged(row.message_id);
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
        { event: "UPDATE", schema: "public", table: "chat_participants", filter: `chat_id=eq.${chatId}` },
        (payload) => {
          const row = payload.new as { user_id: string; last_read_at: string };
          if (row.user_id !== meId) setPeerReadAt(row.last_read_at);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [chatId, meId, celebrate, markChanged]);

  /* ------------------------------ searching ------------------------------ */
  const [serverResults, setServerResults] = useState<MessageWithMeta[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = searchTerm.trim();
    if (!searchOpen || (!q && !searchMediaOnly)) {
      setServerResults(null);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(() => {
      searchMessages({
        term: q,
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
    return allMessages;
  }, [allMessages, serverResults]);

  const timeline = useMemo(() => {
    const items: (
      | { type: "message"; at: string; message: MessageWithMeta }
      | { type: "call"; at: string; call: CallRecord }
    )[] = filtered.map((message) => ({ type: "message" as const, at: message.created_at, message }));
    if (!serverResults && !searchTerm && !searchMediaOnly) {
      items.push(...callHistory.map((call) => ({ type: "call" as const, at: call.created_at, call })));
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [filtered, callHistory, serverResults, searchTerm, searchMediaOnly]);

  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 86,
    overscan: 10,
    getItemKey: (idx) => {
      const item = timeline[idx];
      return item.type === "call" ? `call-${item.call.id}` : item.message.id;
    },
  });

  /* ------------------------- scroll management --------------------------- */
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (timeline.length > 0) {
        virtualizer.scrollToIndex(timeline.length - 1, { align: "end", behavior });
      }
      const el = scroller.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior });
      }
    },
    [timeline.length, virtualizer]
  );

  useEffect(() => {
    if (!loading && timeline.length > 0) {
      requestAnimationFrame(() => scrollToBottom("auto"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, chatId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevScrollHeight.current && el.scrollHeight !== prevScrollHeight.current) {
      el.scrollTop = el.scrollHeight - prevScrollHeight.current;
      prevScrollHeight.current = 0;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 260;
    if (nearBottom && timeline.length > 0) {
      requestAnimationFrame(() => scrollToBottom("auto"));
      markRead(chatId, meId).catch(() => {});
    }
  }, [timeline.length, chatId, meId, scrollToBottom]);

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

  const jumpTo = useCallback(
    (id: string) => {
      const idx = timeline.findIndex((item) => item.type === "message" && item.message.id === id);
      if (idx >= 0) {
        virtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
      }
      window.setTimeout(() => {
        const el = document.getElementById(`msg-${id}`);
        el?.animate(
          [
            { boxShadow: "0 0 0 0 rgba(139,92,246,0.85)" },
            { boxShadow: "0 0 0 8px rgba(139,92,246,0)" },
          ],
          { duration: 1200, easing: "ease-out" }
        );
      }, 140);
    },
    [timeline, virtualizer]
  );

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
  }, [searchParams, loading, timeline.length]);

  /* -------------------------------- typing ------------------------------- */
  const onTyping = useCallback(
    (isTyping: boolean) => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      if (secretMode || !navigator.onLine) return;
      setTyping(chatId, meId, isTyping).catch(() => {});
      if (isTyping) {
        typingTimer.current = window.setTimeout(() => {
          setTyping(chatId, meId, false).catch(() => {});
        }, 5000);
      }
    },
    [chatId, meId, secretMode]
  );

  /* -------------------------------- sending ------------------------------ */
  async function handleSend({ body, mentions }: SendPayload): Promise<boolean> {
    try {
      let outgoing = body;
      let expiresAt: string | null = null;
      if (secretMode) {
        if (!peer || kind !== "direct")
          throw new Error("Secret mode is available in direct chats only.");
        const expMs = Date.now() + 24 * 60 * 60 * 1000;
        outgoing = await encryptSecretText(meId, peer.id, chatId, body, { expiresAt: expMs });
        expiresAt = new Date(expMs).toISOString();
      } else if (body.length > 5000) {
        throw new Error("Messages are limited to 5000 characters.");
      }
      await enqueue({
        chatId,
        body: outgoing,
        replyTo: replyTo?.id ?? null,
        mentions: secretMode ? [] : mentions,
        expiresAt,
      });
      void triggerPushNotification(
        chatId,
        profile?.display_name ?? "Luma",
        secretMode ? "🔒 Encrypted message" : previewOf(body, false)
      );
      if (body.trim() === "🎉") celebrate();
      setReplyTo(null);
      requestAnimationFrame(() => scrollToBottom());
      return true;
    } catch (err) {
      toast.push(
        (err as Error).message || "Could not save the message on this device",
        "error"
      );
      return false;
    }
  }

  async function toggleSecret() {
    if (!peer || kind !== "direct") return;
    if (secretMode) {
      localStorage.removeItem(`luma-secret:${meId}:${chatId}`);
      setSecretMode(false);
      return;
    }
    try {
      const info = await getSecretChatInfo(meId, peer.id, chatId);
      localStorage.setItem(`luma-secret:${meId}:${chatId}`, "on");
      setSecretMode(true);
      if (info.keyChanged) {
        setSecretInfo(info);
        toast.push(t("keyChangedWarning"), "error");
      } else {
        toast.push("Secret mode on (X3DH + Double Ratchet). Verify your safety number.", "success");
      }
    } catch (error) {
      toast.push((error as Error).message || "Could not enable secret mode", "error");
    }
  }

  async function verifySecret() {
    if (!peer) return;
    try {
      setSecretInfo(await getSecretChatInfo(meId, peer.id, chatId));
    } catch (error) {
      toast.push((error as Error).message || "Could not load the safety number", "error");
    }
  }

  async function handleVoice(blob: Blob, durationSec: number, waveform: number[]) {
    setUploading({ name: "Voice message", size: blob.size });
    try {
      const rawFile = new File([blob], `voice-${Date.now()}.webm`, {
        type: blob.type || "audio/webm",
      });
      let saved: Message;
      if (secretMode && peer && kind === "direct") {
        const expMs = Date.now() + 24 * 60 * 60 * 1000;
        const { encryptedBlob, mediaKey, mediaIv } = await encryptSecretMediaFile(rawFile);
        const encFile = new File([encryptedBlob], `secret-voice-${Date.now()}.enc`, {
          type: "application/octet-stream",
        });
        const media = await uploadChatMedia(chatId, meId, encFile);
        const body = await encryptSecretText(meId, peer.id, chatId, "", {
          expiresAt: expMs,
          media: {
            key: mediaKey,
            iv: mediaIv,
            name: rawFile.name,
            type: rawFile.type,
            size: rawFile.size,
          },
        });
        saved = await sendMessage({
          chatId,
          senderId: meId,
          body,
          media,
          mediaDuration: durationSec,
          mediaWaveform: waveform,
          replyTo: replyTo?.id ?? null,
          expiresAt: new Date(expMs).toISOString(),
        });
      } else {
        const media = await uploadChatMedia(chatId, meId, rawFile);
        saved = await sendMessage({
          chatId,
          senderId: meId,
          media,
          mediaDuration: durationSec,
          mediaWaveform: waveform,
          replyTo: replyTo?.id ?? null,
        });
      }
      const [hydrated] = await hydrateMessages([saved]);
      setMessages((prev) =>
        prev.some((m) => m.id === saved.id) ? prev : [...prev, hydrated]
      );
      setReplyTo(null);
      requestAnimationFrame(() => scrollToBottom());
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : "Could not send voice message",
        "error"
      );
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
        let saved: Message;
        if (secretMode && peer && kind === "direct") {
          const expMs = Date.now() + 24 * 60 * 60 * 1000;
          const { encryptedBlob, mediaKey, mediaIv } = await encryptSecretMediaFile(file);
          const encFile = new File([encryptedBlob], `${Date.now()}.enc`, {
            type: "application/octet-stream",
          });
          const media = await uploadChatMedia(chatId, meId, encFile);
          const body = await encryptSecretText(meId, peer.id, chatId, "", {
            expiresAt: expMs,
            media: {
              key: mediaKey,
              iv: mediaIv,
              name: file.name,
              type: file.type || "application/octet-stream",
              size: file.size,
            },
          });
          saved = await sendMessage({
            chatId,
            senderId: meId,
            body,
            media,
            replyTo: replyTo?.id ?? null,
            expiresAt: new Date(expMs).toISOString(),
          });
        } else {
          const media = await uploadChatMedia(chatId, meId, file);
          saved = await sendMessage({
            chatId,
            senderId: meId,
            media,
            replyTo: replyTo?.id ?? null,
          });
          mediaUrl(media.path).catch(() => {});
        }
        const [hydrated] = await hydrateMessages([saved]);
        setMessages((prev) =>
          prev.some((m) => m.id === saved.id) ? prev : [...prev, hydrated]
        );
        void triggerPushNotification(
          chatId,
          profile?.display_name ?? "Luma",
          secretMode ? "🔒 Encrypted attachment" : `📎 ${file.name}`
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
        const copied = await copyMediaToChat(
          src.media_path,
          targetId,
          meId,
          src.media_name ?? undefined
        );
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
            : [
                ...m.reactions,
                {
                  message_id: m.id,
                  user_id: meId,
                  emoji,
                  created_at: new Date().toISOString(),
                },
              ],
        };
      })
    );
    try {
      await toggleReaction(message.id, meId, emoji);
    } catch {
      /* realtime reconciles */
    }
  }

  async function handleDeleteEveryone(message: MessageWithMeta) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === message.id
          ? {
              ...m,
              body: null,
              media_path: null,
              media_name: null,
              media_type: null,
              deleted_at: new Date().toISOString(),
            }
          : m
      )
    );
    try {
      await deleteMessageForEveryone(message.id, message.media_path);
      toast.push("Message deleted for everyone", "success");
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : "Only the sender or an admin can delete this",
        "error"
      );
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
    if (!message.body || message.deleted_at || isSecretBody(message.body)) return;
    setEditingId(message.id);
    setEditDraft(message.body);
  }

  function editLastMine() {
    const last = [...messages]
      .reverse()
      .find(
        (m) =>
          m.sender_id === meId &&
          !m.deleted_at &&
          m.body &&
          !isSecretBody(m.body) &&
          !m.body.startsWith("luma:") &&
          !m.body.startsWith("📊 Poll:")
      );
    if (last) startEdit(last);
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
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updated } : m)));
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
      await reportMessage({
        chatId,
        messageId: reportTarget.id,
        reporter: meId,
        reason,
        details,
      });
      toast.push("Report sent to the chat admins", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not send report", "error");
    }
  }

  const canModerate = summary.isAdmin;
  const peerOnline = Boolean(
    peerShowsLastSeen && peerLastSeen && Date.now() - Date.parse(peerLastSeen) < 120_000
  );

  const headerSubtitle =
    summary.typing.length > 0
      ? t("typing")
      : isChannel
        ? `${summary.participants.length} subscriber${summary.participants.length === 1 ? "" : "s"}`
        : kind === "saved"
          ? "Your private space"
          : summary.chat.is_group
            ? `${summary.participants.length} members`
            : peerOnline
              ? t("online")
              : !peerShowsLastSeen
                ? t("lastSeenHidden")
                : peerLastSeen
                  ? `Last seen ${new Date(peerLastSeen).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "Direct message";

  const unreadInsertBefore = useMemo(() => {
    if (!unreadCutoff) return null;
    const first = filtered.find((m) => m.sender_id !== meId && m.created_at > unreadCutoff);
    return first?.id ?? null;
  }, [filtered, unreadCutoff, meId]);

  return (
    <section
      className="relative flex h-full min-w-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!canPost || connection !== "online") return;
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (canPost && connection === "online" && e.dataTransfer?.files?.length) {
          void handleFiles(e.dataTransfer.files);
        }
      }}
    >
      {confetti > 0 && <Confetti key={confetti} />}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 grid place-items-center bg-luma-ink/75 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-luma-400 bg-luma-500/15 px-10 py-8 text-center">
            <UploadCloud className="h-10 w-10 text-luma-300" />
            <div className="text-[15px] font-semibold text-white">
              {secretMode ? "Drop files to encrypt & send" : "Drop files to attach"}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------- header ------------------------------ */}
      <header className="safe-top z-20 flex items-center gap-1 border-b border-white/[0.07] bg-luma-ink/60 px-2.5 py-2.5 backdrop-blur-2xl sm:px-4">
        <button onClick={onBack} className="btn-icon lg:hidden" aria-label="Back">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </button>

        <button
          onClick={onOpenInfo}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-1 py-1 text-start transition-colors hover:bg-white/[0.05]"
        >
          <Avatar
            profile={isChannel || summary.chat.is_group || isSaved ? null : peer}
            label={
              isSaved
                ? t("savedMessages")
                : isChannel
                  ? summary.chat.name ?? "Channel"
                  : summary.chat.name ?? undefined
            }
            group={summary.chat.is_group || isChannel}
            saved={isSaved}
            chatAvatarPath={summary.chat.avatar_path}
            online={peerOnline}
            size={40}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-white">
              {isChannel && <Hash className="h-4 w-4 shrink-0 text-luma-300" />}
              <span className="truncate">
                {isSaved
                  ? t("savedMessages")
                  : isChannel
                    ? summary.chat.name || "Channel"
                    : summary.chat.is_group
                      ? summary.chat.name || "Group chat"
                      : peer?.display_name ?? "Direct message"}
              </span>
            </div>
            <div className="truncate text-[11.5px] text-slate-400">
              {summary.typing.length > 0 ? (
                <span className="text-luma-300">{t("typing")}</span>
              ) : peerOnline ? (
                <span className="text-emerald-300">{headerSubtitle}</span>
              ) : (
                headerSubtitle
              )}
            </div>
          </div>
        </button>

        {kind === "direct" && (
          <button
            onClick={() => void toggleSecret()}
            className={`btn-icon h-10 w-10 ${secretMode ? "text-emerald-300" : ""}`}
            aria-label={secretMode ? "Turn secret text off" : "Turn secret text on"}
            title={secretMode ? "Secret mode on" : "Enable secret mode"}
          >
            {secretMode ? <Lock className="h-[18px] w-[18px]" /> : <LockOpen className="h-[18px] w-[18px]" />}
          </button>
        )}
        {(kind === "direct" || kind === "group") && (
          <>
            <button
              onClick={() => void startCall(summary, "audio")}
              disabled={callBusy}
              className="btn-icon h-10 w-10 disabled:opacity-40"
              aria-label="Start audio call"
              title="Audio call"
            >
              <Phone className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={() => void startCall(summary, "video")}
              disabled={callBusy}
              className="btn-icon h-10 w-10 disabled:opacity-40"
              aria-label="Start video call"
              title="Video call"
            >
              <Video className="h-[18px] w-[18px]" />
            </button>
          </>
        )}
        <button
          onClick={() => setSearchOpen((v) => !v)}
          className="btn-icon hidden h-10 w-10 sm:grid"
          aria-label="Search messages"
          title="Search (Ctrl+K)"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={onOpenInfo}
          className="btn-icon hidden h-10 w-10 sm:grid"
          aria-label="Chat info"
        >
          <Info className="h-[18px] w-[18px]" />
        </button>
        <div className="relative sm:hidden">
          <button
            onClick={() => setHeaderMenuOpen((v) => !v)}
            className="btn-icon h-9 w-9"
            aria-label="More chat options"
            aria-expanded={headerMenuOpen}
          >
            <MoreHorizontal className="h-[18px] w-[18px]" />
          </button>
          {headerMenuOpen && (
            <div className="absolute end-0 top-11 z-50 w-44 rounded-2xl border border-white/10 bg-luma-panel p-1.5 shadow-2xl">
              <button
                onClick={() => {
                  setHeaderMenuOpen(false);
                  setSearchOpen((v) => !v);
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-start text-xs text-slate-200 hover:bg-white/10"
              >
                <Search className="h-4 w-4" /> Search messages
              </button>
              <button
                onClick={() => {
                  setHeaderMenuOpen(false);
                  onOpenInfo();
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-start text-xs text-slate-200 hover:bg-white/10"
              >
                <Info className="h-4 w-4" /> Chat info
              </button>
            </div>
          )}
        </div>
      </header>

      {secretMode && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 border-b border-emerald-400/15 bg-emerald-500/[.08] px-3 py-2 text-center text-[11px] text-emerald-200">
          <Lock className="h-3 w-3" /> {t("secretModeOn")} · 24h TTL ·{" "}
          <button onClick={() => void verifySecret()} className="font-semibold underline underline-offset-2">
            {t("safetyCode")}
          </button>
        </div>
      )}

      {/* pinned bar */}
      {pinnedLatest && (
        <div className="z-10 flex items-center gap-2 border-b border-luma-400/20 bg-luma-500/[0.13] px-4 py-1.5 backdrop-blur-xl">
          <button
            onClick={() => jumpTo(pinnedLatest.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-start transition-opacity hover:opacity-85"
          >
            <Pin className="h-3.5 w-3.5 shrink-0 fill-luma-300 text-luma-300" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-luma-100">
              <span className="font-semibold">Pinned:</span>{" "}
              {isSecretBody(pinnedLatest.body)
                ? "🔒 Encrypted message"
                : pinnedLatest.body || (pinnedLatest.media_path ? "📎 Attachment" : "Message")}
            </span>
          </button>
          {pinned.length > 1 && (
            <button
              onClick={() => setPinsModalOpen(true)}
              className="shrink-0 rounded-full bg-white/15 px-2.5 py-0.5 text-[10.5px] font-medium text-luma-100 hover:bg-white/25"
            >
              All ({pinned.length})
            </button>
          )}
        </div>
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
              <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                autoFocus
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search in this conversation…"
                className="field py-2.5 pe-10 ps-10 text-[13.5px]"
              />
              {(searchTerm || searchMediaOnly) && (
                <button
                  onClick={() => {
                    setSearchTerm("");
                    setSearchMediaOnly(false);
                    setSearchFromMe(false);
                  }}
                  className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-500 hover:bg-white/10 hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 pb-2">
              <button
                onClick={() => setSearchFromMe((v) => !v)}
                className={`chip transition-colors ${
                  searchFromMe ? "border-luma-400/60 bg-luma-500/25 text-luma-100" : ""
                }`}
              >
                From me
              </button>
              <button
                onClick={() => setSearchMediaOnly((v) => !v)}
                className={`chip transition-colors ${
                  searchMediaOnly ? "border-luma-400/60 bg-luma-500/25 text-luma-100" : ""
                }`}
              >
                Media only
              </button>
              {searching && <Loader2 className="ms-auto h-4 w-4 animate-spin text-slate-500" />}
              {serverResults && !searching && (
                <span className="ms-auto text-[11px] text-slate-500">
                  {serverResults.length} result{serverResults.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ----------------------------- virtualized timeline ----------------- */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrolledUp(el.scrollHeight - el.scrollTop - el.clientHeight > 320);
        }}
        className={`wallpaper ${wallpaper === "stars" ? "wallpaper-stars" : ""} ${
          wallpaper === "aurora" ? "wallpaper-aurora" : ""
        } relative flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6`}
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : timeline.length === 0 ? (
          <EmptyChat
            kind={kind}
            name={summary.chat.name}
            searching={Boolean(searchTerm || searchMediaOnly)}
          />
        ) : (
          <>
            {hasMore && !serverResults && (
              <div className="mb-3 flex justify-center">
                <button
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="btn-ghost px-4 py-1.5 text-[12px]"
                >
                  {loadingOlder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Load older messages"}
                </button>
              </div>
            )}

            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((vRow) => {
                const i = vRow.index;
                const item = timeline[i];
                const previous = timeline[i - 1];
                const showDay = shouldShowDayGroup(item.at, previous?.at);

                return (
                  <div
                    key={vRow.key}
                    data-index={i}
                    ref={virtualizer.measureElement}
                    className="absolute start-0 top-0 w-full"
                    style={{ transform: `translateY(${vRow.start}px)` }}
                  >
                    {item.type === "call" ? (
                      (() => {
                        const call = item.call;
                        const outgoing = call.started_by === meId;
                        const duration =
                          call.answered_at && call.ended_at
                            ? Math.max(
                                0,
                                Math.round(
                                  (Date.parse(call.ended_at) - Date.parse(call.answered_at)) / 1000
                                )
                              )
                            : null;
                        const label =
                          call.status !== "ended"
                            ? "Ongoing"
                            : !call.answered_at
                              ? outgoing
                                ? "Unanswered"
                                : "Missed"
                              : outgoing
                                ? "Outgoing"
                                : "Incoming";
                        return (
                          <div>
                            {showDay && (
                              <div className="my-4 flex justify-center">
                                <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[10.5px] uppercase tracking-wider text-slate-400">
                                  {relativeDay(item.at, lang)}
                                </span>
                              </div>
                            )}
                            <div className="my-3 flex justify-center">
                              <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-[11px] text-slate-300">
                                {outgoing ? (
                                  <PhoneOutgoing className="h-3.5 w-3.5 text-luma-300" />
                                ) : (
                                  <PhoneIncoming className="h-3.5 w-3.5 text-luma-300" />
                                )}
                                {label} {call.kind} call
                                {duration != null
                                  ? ` · ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`
                                  : ""}
                              </span>
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      (() => {
                        const message = item.message;
                        const prev = previous?.type === "message" ? previous.message : undefined;
                        const grouped =
                          !showDay && prev?.sender_id === message.sender_id && !message.reply_to;
                        const mine = message.sender_id === meId;
                        const read = Boolean(
                          peerReadAt &&
                            new Date(peerReadAt).getTime() >= new Date(message.created_at).getTime()
                        );
                        const showUnreadHere = unreadInsertBefore === message.id;
                        return (
                          <div>
                            {showDay && (
                              <div className="my-4 flex items-center justify-center">
                                <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[10.5px] font-medium uppercase tracking-wider text-slate-400 backdrop-blur">
                                  {relativeDay(message.created_at, lang)}
                                </span>
                              </div>
                            )}
                            {showUnreadHere && (
                              <div
                                className="my-3 flex items-center gap-3"
                                aria-label="Unread messages below"
                              >
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
                              onRetry={() => void retry(message.id)}
                              onDiscard={() => void discard(message.id)}
                              meId={meId}
                              peerId={kind === "direct" ? peer?.id : null}
                            />
                          </div>
                        );
                      })()
                    )}
                  </div>
                );
              })}
            </div>

            <AnimatePresence>
              {summary.typing.length > 0 && (
                <TypingBubble names={summary.typing.map((p) => p.display_name)} />
              )}
            </AnimatePresence>
          </>
        )}

        {(unreadBelow > 0 || scrolledUp) && (
          <button
            onClick={() => {
              scrollToBottom();
              setUnreadCutoff(new Date().toISOString());
            }}
            className="sticky bottom-3 z-10 mx-auto flex items-center gap-2 rounded-full border border-luma-400/40 bg-luma-panel/90 px-4 py-2 text-[12px] font-medium text-luma-100 shadow-glow backdrop-blur-xl"
            aria-label="Scroll to latest"
          >
            <ArrowDown className="h-4 w-4" />
            {unreadBelow > 0 ? `${unreadBelow} unread` : "Latest"}
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
          onEditLast={editLastMine}
          uploading={uploading}
          onFiles={handleFiles}
          canUpload={connection === "online"}
          secret={secretMode}
          onCreatePoll={() => setPollOpen(true)}
          placeholder={
            secretMode
              ? t("secretMessagePlaceholder")
              : isChannel
                ? "Broadcast to subscribers…"
                : isSaved
                  ? "Write to yourself…"
                  : t("typeMessage")
          }
        />
      ) : (
        <div className="border-t border-white/[0.07] bg-luma-ink/55 px-4 py-4 text-center backdrop-blur-2xl">
          <p className="text-[12px] text-slate-500">
            Only channel admins can post. You are subscribed — new posts appear here.
          </p>
        </div>
      )}

      <CreatePollModal
        open={pollOpen}
        onClose={() => setPollOpen(false)}
        chatId={chatId}
        onCreated={() => {
          void loadMessages(chatId, { limit: 80 }).then(setMessages).catch(() => {});
        }}
      />

      {/* Safety Number + Emoji Verification Modal */}
      <Modal
        open={secretInfo !== null}
        onClose={() => setSecretInfo(null)}
        title={t("safetyCode")}
        subtitle="Compare this fingerprint or emoji sequence with your contact over an independent channel."
      >
        {secretInfo && (
          <div className="space-y-4">
            {secretInfo.keyChanged && (
              <div className="flex items-start gap-2.5 rounded-2xl border border-rose-400/35 bg-rose-500/15 p-3.5 text-[12.5px] text-rose-100">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
                <div>{t("keyChangedWarning")}</div>
              </div>
            )}
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-5 text-center">
              <div className="mb-3 flex justify-center gap-2 text-2xl">
                {secretInfo.emojis.map((em, idx) => (
                  <span key={idx}>{em}</span>
                ))}
              </div>
              <div className="font-mono text-base font-semibold tracking-wider text-emerald-100">
                {secretInfo.code}
              </div>
            </div>
            {peer && secretInfo.peerPublicKey && (
              <button
                onClick={async () => {
                  await trustPeerKey(meId, peer.id, secretInfo.peerPublicKey!, true);
                  setSecretInfo({ ...secretInfo, keyChanged: false, verified: true });
                  toast.push("Safety number marked verified", "success");
                }}
                className={`btn w-full py-2.5 text-[13px] ${
                  secretInfo.verified && !secretInfo.keyChanged
                    ? "border border-emerald-400/35 bg-emerald-500/15 text-emerald-200"
                    : "btn-primary"
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                {secretInfo.verified && !secretInfo.keyChanged
                  ? t("verified")
                  : t("verifySafetyCode")}
              </button>
            )}
            <p className="text-[11.5px] leading-relaxed text-slate-400">
              Secret mode uses P-256 X3DH prekeys, Double Ratchet forward secrecy, and client-side
              AES-256-GCM attachment encryption. Keys stay on this browser/device and have not
              undergone a formal third-party audit; clearing browser storage removes local access.
            </p>
          </div>
        )}
      </Modal>

      {/* Pinned messages list modal */}
      <Modal
        open={pinsModalOpen}
        onClose={() => setPinsModalOpen(false)}
        title={t("pinnedMessages")}
        subtitle={`${pinned.length} pinned`}
      >
        <div className="max-h-[55vh] space-y-2 overflow-y-auto no-scrollbar">
          {pinned.map((pm) => (
            <div
              key={pm.id}
              className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-3"
            >
              <button
                onClick={() => {
                  setPinsModalOpen(false);
                  jumpTo(pm.id);
                }}
                className="min-w-0 flex-1 text-start"
              >
                <div className="text-[11.5px] font-medium text-luma-300">
                  {pm.sender?.display_name ?? "Member"}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[13px] text-slate-200">
                  {isSecretBody(pm.body)
                    ? "🔒 Encrypted message"
                    : pm.body || (pm.media_path ? `📎 ${pm.media_name ?? "Attachment"}` : "Message")}
                </div>
              </button>
              {canModerate && (
                <button
                  onClick={() => void handleTogglePin(pm)}
                  className="rounded-lg px-2 py-1 text-[11px] text-slate-400 hover:bg-white/10 hover:text-white"
                >
                  Unpin
                </button>
              )}
            </div>
          ))}
        </div>
      </Modal>

      <ForwardModal
        open={Boolean(forwardSource)}
        onClose={() => setForwardSource(null)}
        meId={meId}
        onPick={handleForwardTo}
      />
      <ReportModal
        open={Boolean(reportTarget)}
        onClose={() => setReportTarget(null)}
        title={
          reportTarget
            ? `Report message in this ${
                isChannel ? "channel" : summary.chat.is_group ? "group" : "conversation"
              }`
            : ""
        }
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
