import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { sendMessage } from "../lib/data";
import { cacheSentMessage, listOutbox, putOutbox, removeOutbox, type OutboxEntry } from "../lib/offline";
import { useAuth } from "./AuthContext";
import type { MessageWithMeta } from "../lib/types";

export type ConnectionState = "online" | "offline" | "reconnecting";
type OfflineCtx = {
  connection: ConnectionState;
  outbox: OutboxEntry[];
  enqueue: (input: { chatId: string; body: string; replyTo?: string | null; mentions?: string[]; expiresAt?: string | null }) => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
};
const Ctx = createContext<OfflineCtx | null>(null);

function isPermanent(error: unknown) {
  const code = (error as { code?: string })?.code ?? "";
  // Network errors and transient server errors stay queued; RLS/constraint/validation errors need attention.
  return /^(22|23|28|42|P0001)/.test(code);
}
function messageFor(error: unknown) {
  return (error as { message?: string })?.message || "Could not send message";
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const { user, profile } = useAuth();
  const userId = user?.id;
  const [connection, setConnection] = useState<ConnectionState>(navigator.onLine ? "reconnecting" : "offline");
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const flushing = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const refresh = useCallback(async () => {
    if (!userId) { setOutbox([]); return; }
    try { setOutbox(await listOutbox(userId)); } catch (error) { console.warn("[Luma] outbox unavailable", error); }
  }, [userId]);
  const announce = useCallback(() => {
    window.dispatchEvent(new Event("luma:outbox-change"));
    channelRef.current?.postMessage("changed");
  }, []);

  useEffect(() => {
    if (!userId) { setOutbox([]); return; }
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("luma:outbox-change", onChange);
    if ("BroadcastChannel" in window) {
      const bc = new BroadcastChannel(`luma-outbox:${userId}`);
      channelRef.current = bc;
      bc.onmessage = onChange;
    }
    return () => { window.removeEventListener("luma:outbox-change", onChange); channelRef.current?.close(); channelRef.current = null; };
  }, [userId, refresh]);

  useEffect(() => {
    const offline = () => setConnection("offline");
    const online = () => setConnection("reconnecting");
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (!userId) { setConnection(navigator.onLine ? "online" : "offline"); return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); }; }
    const channel = supabase.channel(`luma:connection:${userId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` }, () => {})
      .subscribe((status) => {
        if (!navigator.onLine) setConnection("offline");
        else if (status === "SUBSCRIBED") setConnection("online");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setConnection("reconnecting");
      });
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); void supabase.removeChannel(channel); };
  }, [userId]);

  const flush = useCallback(async () => {
    if (!userId || !navigator.onLine || flushing.current) return;
    flushing.current = true;
    const run = async () => {
      const entries = await listOutbox(userId);
      const blockedChats = new Set<string>();
      for (const entry of entries) {
        if (!navigator.onLine) break;
        if (blockedChats.has(entry.chatId)) continue;
        if (entry.status === "failed" || entry.nextAttemptAt > Date.now()) { blockedChats.add(entry.chatId); continue; }
        if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
          await putOutbox({ ...entry, status: "failed", error: "This message expired before it could be sent." });
          announce();
          blockedChats.add(entry.chatId);
          continue;
        }
        try {
          const sent = await sendMessage({ chatId: entry.chatId, senderId: userId, id: entry.id, body: entry.body, replyTo: entry.replyTo, mentions: entry.mentions, expiresAt: entry.expiresAt });
          const message: MessageWithMeta = { ...sent, sender: profile ?? undefined, reactions: [] };
          await cacheSentMessage(userId, message).catch(() => {});
          await removeOutbox(entry.id);
          window.dispatchEvent(new CustomEvent("luma:outbox-sent", { detail: message }));
          announce();
        } catch (error) {
          const attempts = entry.attempts + 1;
          await putOutbox({ ...entry, status: isPermanent(error) ? "failed" : "queued", error: messageFor(error), attempts, nextAttemptAt: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) });
          announce();
          // Preserve ordering within the chat until its first failure is resolved.
          blockedChats.add(entry.chatId);
          if (!isPermanent(error)) break;
        }
      }
    };
    try {
      if (navigator.locks) {
        await navigator.locks.request(`luma-outbox:${userId}`, { ifAvailable: true }, async (lock) => { if (lock) await run(); });
      } else await run(); // UUID idempotency also protects older browsers / multiple tabs.
    } catch (error) { console.warn("[Luma] outbox retry failed", error); }
    finally { flushing.current = false; void refresh(); }
  }, [userId, profile, announce, refresh]);

  useEffect(() => {
    if (!userId) return;
    void flush();
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    window.addEventListener("luma:outbox-change", onOnline);
    const timer = window.setInterval(() => void flush(), 5000);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("luma:outbox-change", onOnline); window.clearInterval(timer); };
  }, [userId, flush]);

  const enqueue = useCallback<OfflineCtx["enqueue"]>(async (input) => {
    if (!userId) throw new Error("Sign in to send a message");
    const entry: OutboxEntry = { id: crypto.randomUUID(), userId, chatId: input.chatId, body: input.body, replyTo: input.replyTo ?? null, mentions: input.mentions ?? [], expiresAt: input.expiresAt ?? null, createdAt: new Date().toISOString(), status: "queued", attempts: 0, nextAttemptAt: 0 };
    // Persist before clearing the composer. Failure leaves the user's draft intact.
    await putOutbox(entry);
    announce();
    void flush();
  }, [userId, announce, flush]);
  const retry = useCallback(async (id: string) => {
    if (!userId) return;
    const entry = (await listOutbox(userId)).find((item) => item.id === id);
    if (!entry) return;
    await putOutbox({ ...entry, status: "queued", attempts: 0, nextAttemptAt: 0, error: undefined });
    announce(); void flush();
  }, [userId, announce, flush]);
  const discard = useCallback(async (id: string) => {
    if (!userId || !(await listOutbox(userId)).some((item) => item.id === id)) return;
    await removeOutbox(id); announce();
  }, [userId, announce]);
  const value = useMemo(() => ({ connection, outbox, enqueue, retry, discard }), [connection, outbox, enqueue, retry, discard]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useOffline() {
  const value = useContext(Ctx);
  if (!value) throw new Error("useOffline must be used inside OfflineProvider");
  return value;
}
