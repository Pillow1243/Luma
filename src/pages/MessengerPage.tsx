import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate, useParams } from "react-router-dom";
import { Archive, Bookmark, Loader2, MessageSquarePlus, Plus, Search, Star } from "lucide-react";
import { Aurora } from "../components/Aurora";
import { Avatar } from "../components/Avatar";
import { ChatInfoModal } from "../components/ChatInfoModal";
import { ChatListItem } from "../components/ChatListItem";
import { ChatWindow } from "../components/ChatWindow";
import { LumaMark, LumaWordmark } from "../components/LumaMark";
import { NotificationsBell } from "../components/NotificationsBell";
import { NewChatModal } from "../components/NewChatModal";
import { ProfileModal } from "../components/ProfileModal";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { supabase } from "../lib/supabase";
import { chatTitle, createSavedChat, loadChats } from "../lib/data";
import type { ChatSummary } from "../lib/types";

export default function MessengerPage() {
  const { user, profile } = useAuth();
  const { chatId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "direct" | "groups" | "channels" | "archived">("all");
  const [profileOpen, setProfileOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "chat">(chatId ? "chat" : "list");

  const meId = user?.id ?? "";
  const active = useMemo(
    () => chats.find((c) => c.chat.id === chatId) ?? null,
    [chats, chatId]
  );

  const refresh = useCallback(
    async (silent = false) => {
      if (!meId) return;
      if (!silent) setLoading(true);
      try {
        const rows = await loadChats(meId);
        setChats(rows);
      } catch (err) {
        if (!silent) toast.push(err instanceof Error ? err.message : "Could not load chats", "error");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [meId, toast]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* Keep the sidebar live: new messages, new chats, typing + read receipts. */
  useEffect(() => {
    if (!meId) return;
    const channel = supabase
      .channel("luma:sidebar")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () =>
        refresh(true)
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_participants" }, () =>
        refresh(true)
      )
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chats" }, () =>
        refresh(true)
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [meId, refresh]);

  /* On wide screens we always show the list; on phones, route drives the view. */
  useEffect(() => {
    setMobileView(chatId ? "chat" : "list");
  }, [chatId]);

  // Typing indicators expire client-side — re-render every few seconds.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 4000);
    return () => window.clearInterval(t);
  }, []);

  const isArchived = (c: ChatSummary) => Boolean(c.archivedAt);
  const tabChats = useMemo(() => {
    switch (tab) {
      case "direct":
        return chats.filter((c) => c.chat.kind === "direct" && !isArchived(c));
      case "groups":
        return chats.filter((c) => c.chat.kind === "group" && !isArchived(c));
      case "channels":
        return chats.filter((c) => c.chat.kind === "channel" && !isArchived(c));
      case "archived":
        return chats.filter(isArchived);
      default:
        return chats.filter((c) => !isArchived(c));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, tab]);
  const filteredChats = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const base = tabChats;
    if (!t) return base;
    return base.filter((c) => chatTitle(c, meId).toLowerCase().includes(t));
  }, [tabChats, filter, meId]);
  const tabUnread = useMemo(
    () => ({
      all: chats.filter((c) => !isArchived(c)).reduce((n, c) => n + c.unreadCount, 0),
      direct: chats.filter((c) => c.chat.kind === "direct" && !isArchived(c)).reduce((n, c) => n + c.unreadCount, 0),
      groups: chats.filter((c) => c.chat.kind === "group" && !isArchived(c)).reduce((n, c) => n + c.unreadCount, 0),
      channels: chats.filter((c) => c.chat.kind === "channel" && !isArchived(c)).reduce((n, c) => n + c.unreadCount, 0),
      archived: chats.filter(isArchived).reduce((n, c) => n + c.unreadCount, 0),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chats]
  );
  const savedChat = chats.find((c) => c.chat.kind === "saved") ?? null;

  const totalUnread = chats.reduce((n, c) => n + c.unreadCount, 0);

  async function openSaved() {
    try {
      if (savedChat) {
        openChat(savedChat.chat.id);
        return;
      }
      const id = await createSavedChat();
      await refresh();
      openChat(id);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not open Saved Messages", "error");
    }
  }

  function openChat(id: string) {
    navigate(`/chat/${id}`);
    setMobileView("chat");
  }

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      <Aurora />

      {/* -------------------------------- sidebar ------------------------------- */}
      <aside
        className={`${
          mobileView === "chat" ? "hidden" : "flex"
        } w-full shrink-0 flex-col border-r border-white/[0.07] bg-luma-ink/45 backdrop-blur-2xl lg:flex lg:w-[22.5rem]`}
      >
        <div className="safe-top px-3 pt-3">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setProfileOpen(true)} className="flex items-center gap-2.5 rounded-2xl py-1 pr-2 text-left">
              <LumaMark size={36} className="drop-shadow-[0_6px_18px_rgba(139,92,246,0.5)]" />
              <div className="hidden sm:block">
                <div className="text-[16px] font-semibold leading-none tracking-tight text-white">
                  Luma
                </div>
                <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-luma-300/60">
                  {totalUnread > 0 ? `${totalUnread} unread` : "all caught up"}
                </div>
              </div>
            </button>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => navigate("/starred")}
                className="btn-icon h-10 w-10"
                aria-label="Starred messages"
                title="Starred messages"
              >
                <Star className="h-[18px] w-[18px]" />
              </button>
              <button
                onClick={openSaved}
                className="btn-icon h-10 w-10"
                aria-label="Saved Messages"
                title="Saved Messages"
              >
                <Bookmark className="h-[18px] w-[18px]" />
              </button>
              <NotificationsBell />
              <button
                onClick={() => setNewChatOpen(true)}
                className="btn-primary h-10 px-3 text-[13px]"
                aria-label="New chat"
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New</span>
              </button>
              <button
                onClick={() => setProfileOpen(true)}
                className="transition-transform active:scale-95"
                aria-label="Profile"
              >
                <Avatar profile={profile} size={38} ring />
              </button>
            </div>
          </div>

          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search conversations"
              className="field py-2.5 pl-10 text-[13.5px]"
            />
          </div>

          <div className="mt-2 flex items-center gap-1 overflow-x-auto no-scrollbar" role="tablist" aria-label="Chat folders">
            {(
              [
                { id: "all", label: "All", icon: null },
                { id: "direct", label: "Personal", icon: null },
                { id: "groups", label: "Groups", icon: null },
                { id: "channels", label: "Channels", icon: null },
                { id: "archived", label: "Archived", icon: Archive },
              ] as const
            ).map((t) => {
              const count = tabUnread[t.id];
              const activeTab = tab === t.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab}
                  onClick={() => setTab(t.id)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                    activeTab
                      ? "bg-luma-500/25 text-luma-100 ring-1 ring-luma-400/40"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
                  }`}
                >
                  {t.icon ? <t.icon className="h-3.5 w-3.5" /> : null}
                  {t.label}
                  {count > 0 && (
                    <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-luma-500 px-1 text-[9.5px] font-bold text-white">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-2 flex-1 overflow-y-auto px-2 pb-3 pt-1 no-scrollbar">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filteredChats.length === 0 ? (
            <EmptySidebar
              onCreate={() => setNewChatOpen(true)}
              filtered={Boolean(filter) || tab !== "all"}
              tab={tab}
            />
          ) : (
            <div className="space-y-0.5">
              {tab === "all" && savedChat && (
                <ChatListItem
                  key={savedChat.chat.id}
                  summary={savedChat}
                  meId={meId}
                  active={savedChat.chat.id === chatId}
                  onClick={() => openChat(savedChat.chat.id)}
                />
              )}
              {filteredChats
                .filter((c) => tab !== "all" || c.chat.kind !== "saved")
                .map((c) => (
                  <ChatListItem
                    key={c.chat.id}
                    summary={c}
                    meId={meId}
                    active={c.chat.id === chatId}
                    onClick={() => openChat(c.chat.id)}
                  />
                ))}
            </div>
          )}
        </div>

        <div className="border-t border-white/[0.06] px-4 py-2.5 text-[10.5px] text-slate-600 safe-bottom">
          Luma v2.0 · Realtime via Supabase
        </div>
      </aside>

      {/* ------------------------------ main pane ------------------------------ */}
      <main
        className={`${
          mobileView === "list" ? "hidden" : "flex"
        } min-w-0 flex-1 flex-col lg:flex`}
      >
        <AnimatePresence mode="wait">
          {active ? (
            <motion.div
              key={active.chat.id}
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
              className="flex h-full min-h-0 flex-col"
            >
              <ChatWindow
                summary={active}
                meId={meId}
                onBack={() => {
                  setMobileView("list");
                  navigate("/");
                }}
                onOpenInfo={() => setInfoOpen(true)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="hidden h-full flex-col items-center justify-center px-8 text-center lg:flex"
            >
              <LumaMark size={92} className="drop-shadow-[0_24px_70px_rgba(139,92,246,0.55)]" />
              <h2 className="mt-6 text-[22px] font-semibold tracking-tight text-white">
                Your conversations, illuminated
              </h2>
              <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-slate-400">
                Pick a conversation on the left, or start a new one. Luma delivers
                messages instantly with read receipts, reactions and media.
              </p>
              <button onClick={() => setNewChatOpen(true)} className="btn-primary mt-6 px-5">
                <MessageSquarePlus className="h-4 w-4" />
                Start a conversation
              </button>
              <div className="mt-10 flex items-center gap-2 text-[11px] text-slate-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                Connected · realtime channels online
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* -------------------------------- modals ------------------------------- */}
      <NewChatModal
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        meId={meId}
        onCreated={(id) => openChat(id)}
      />
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <ChatInfoModal
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        summary={active}
        meId={meId}
      />
    </div>
  );
}

function EmptySidebar({ onCreate, filtered, tab }: { onCreate: () => void; filtered: boolean; tab: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.05]">
        <MessageSquarePlus className="h-6 w-6 text-luma-300" />
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-white">
        {tab === "archived" ? "Nothing archived" : filtered ? "No matches" : "No conversations yet"}
      </h3>
      <p className="mt-1 max-w-[15rem] text-[12.5px] leading-relaxed text-slate-500">
        {tab === "archived"
          ? "Archived chats are tucked away here. Long-press any chat header to archive it."
          : filtered
            ? "Try a different search term or folder."
            : "Start a direct message, a group or a channel to see it here."}
      </p>
      {!filtered && (
        <button onClick={onCreate} className="btn-ghost mt-4 px-4 py-2 text-[13px]">
          <Plus className="h-4 w-4" /> New conversation
        </button>
      )}
    </div>
  );
}

export { LumaWordmark };
