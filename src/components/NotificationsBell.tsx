import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { AtSign, Bell, CheckCheck, Megaphone, UserCheck, UserX, Info } from "lucide-react";
import {
  fetchNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from "../lib/data";
import { supabase } from "../lib/supabase";
import { shortStamp } from "../lib/format";
import type { LumaNotification } from "../lib/types";
import { useAuth } from "../context/AuthContext";

const ICONS: Record<LumaNotification["kind"], typeof AtSign> = {
  mention: AtSign,
  join_approved: UserCheck,
  join_rejected: UserX,
  system: Megaphone,
};

export function NotificationsBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const meId = user?.id ?? "";
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LumaNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!meId) return;
    const [list, count] = await Promise.all([
      fetchNotifications(meId, 30).catch(() => [] as LumaNotification[]),
      unreadNotificationCount(meId).catch(() => 0),
    ]);
    setItems(list);
    setUnread(count);
  }, [meId]);

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel("luma:notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${meId}` },
        () => refresh()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meId]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  async function markAll() {
    await markNotificationsRead().catch(() => {});
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-icon h-10 w-10"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-luma-ink bg-luma-gradient px-1 text-[9.5px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            className="glass-panel absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-2.5">
              <span className="text-[12px] font-semibold uppercase tracking-wider text-slate-400">
                Notifications
              </span>
              <button
                onClick={markAll}
                className="flex items-center gap-1.5 text-[11px] text-luma-300 hover:text-luma-200"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto py-1 no-scrollbar">
              {items.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <Info className="mx-auto h-5 w-5 text-slate-600" />
                  <p className="mt-2 text-[12.5px] text-slate-500">
                    Nothing yet — mentions and approvals will show up here.
                  </p>
                </div>
              ) : (
                items.map((n) => {
                  const Icon = ICONS[n.kind] ?? Megaphone;
                  const isUnread = !n.read_at;
                  return (
                    <button
                      key={n.id}
                      onClick={() => {
                        setOpen(false);
                        if (n.chat_id) navigate(`/chat/${n.chat_id}`);
                      }}
                      className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.06] ${
                        isUnread ? "bg-luma-500/[0.07]" : ""
                      }`}
                    >
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-luma-500/15 text-luma-300">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] leading-snug text-slate-200">
                          {n.body}
                        </span>
                        <span className="mt-1 block text-[10.5px] text-slate-500">
                          {shortStamp(n.created_at)}
                        </span>
                      </span>
                      {isUnread && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-luma-400" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
