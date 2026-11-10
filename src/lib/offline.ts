import { openDB, type DBSchema } from "idb";
import type { ChatSummary, MessageWithMeta, Profile } from "./types";

/** Everything is scoped by the signed-in user, including the durable outbox. */
export type OutboxEntry = {
  id: string;
  userId: string;
  chatId: string;
  body: string;
  replyTo: string | null;
  mentions: string[];
  expiresAt: string | null;
  createdAt: string;
  status: "queued" | "failed";
  attempts: number;
  nextAttemptAt: number;
  error?: string;
};

type MessageSnapshot = { key: string; userId: string; chatId: string; messages: MessageWithMeta[] };
interface LumaDB extends DBSchema {
  profiles: { key: string; value: Profile };
  chats: { key: string; value: { userId: string; chats: ChatSummary[] } };
  messages: { key: string; value: MessageSnapshot };
  outbox: { key: string; value: OutboxEntry; indexes: { "by-user": string } };
  keys: { key: string; value: { userId: string; privateKey: CryptoKey; publicKey: JsonWebKey } };
  peerKeys: { key: string; value: { key: string; publicKey: JsonWebKey } };
}

let dbPromise: ReturnType<typeof openDB<LumaDB>> | undefined;
export function offlineDB() {
  if (!dbPromise) {
    dbPromise = openDB<LumaDB>("luma-offline-v1", 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
        db.createObjectStore("profiles", { keyPath: "id" });
        db.createObjectStore("chats", { keyPath: "userId" });
        db.createObjectStore("messages", { keyPath: "key" });
        const outbox = db.createObjectStore("outbox", { keyPath: "id" });
        outbox.createIndex("by-user", "userId");
        db.createObjectStore("keys", { keyPath: "userId" });
      }
        if (oldVersion < 2) db.createObjectStore("peerKeys", { keyPath: "key" });
      },
    });
    // A blocked/private-mode failure should not poison all future attempts.
    dbPromise.catch(() => { dbPromise = undefined; });
  }
  return dbPromise;
}

const messageKey = (userId: string, chatId: string) => `${userId}:${chatId}`;
const notExpired = (m: MessageWithMeta) => !m.expires_at || new Date(m.expires_at).getTime() > Date.now();

export async function cacheProfile(profile: Profile) { await (await offlineDB()).put("profiles", profile); }
export async function cachedProfile(userId: string) { return (await offlineDB()).get("profiles", userId); }
export async function cacheChats(userId: string, chats: ChatSummary[]) {
  await (await offlineDB()).put("chats", { userId, chats });
}
export async function cachedChats(userId: string) {
  const chats = (await (await offlineDB()).get("chats", userId))?.chats ?? [];
  return chats.map((summary) => summary.lastMessage?.expires_at && Date.parse(summary.lastMessage.expires_at) <= Date.now()
    ? { ...summary, lastMessage: null, unreadCount: 0 } : summary);
}

export async function cacheMessages(userId: string, chatId: string, messages: MessageWithMeta[]) {
  // Pending entries live only in the outbox. Encrypted messages remain ciphertext.
  const keep = messages.filter((m) => !m.pending && !m.failed && notExpired(m)).slice(-150);
  await (await offlineDB()).put("messages", { key: messageKey(userId, chatId), userId, chatId, messages: keep });
}
export async function cachedMessages(userId: string, chatId: string) {
  const value = await (await offlineDB()).get("messages", messageKey(userId, chatId));
  return (value?.messages ?? []).filter(notExpired);
}
export async function listOutbox(userId: string) {
  return (await (await offlineDB()).getAllFromIndex("outbox", "by-user", userId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function putOutbox(entry: OutboxEntry) { await (await offlineDB()).put("outbox", entry); }
export async function removeOutbox(id: string) { await (await offlineDB()).delete("outbox", id); }

/** A successful server response should survive navigating away before Realtime catches up. */
export async function cacheSentMessage(userId: string, message: MessageWithMeta) {
  const db = await offlineDB();
  const key = messageKey(userId, message.chat_id);
  const tx = db.transaction("messages", "readwrite");
  const snapshot = await tx.store.get(key);
  const rows = (snapshot?.messages ?? []).filter((m) => m.id !== message.id && notExpired(m));
  rows.push(message);
  await tx.store.put({ key, userId, chatId: message.chat_id, messages: rows.slice(-150) });
  await tx.done;
}

export async function clearOfflineUser(userId: string) {
  const db = await offlineDB();
  const tx = db.transaction(["profiles", "chats", "messages", "outbox"], "readwrite");
  await Promise.all([
    tx.objectStore("profiles").delete(userId),
    tx.objectStore("chats").delete(userId),
    (async () => { for (const row of await tx.objectStore("messages").getAll()) if (row.userId === userId) await tx.objectStore("messages").delete(row.key); })(),
    (async () => { for (const row of await tx.objectStore("outbox").index("by-user").getAll(userId)) await tx.objectStore("outbox").delete(row.id); })(),
  ]);
  await tx.done;
  // Never silently erase a secret-chat private key: it cannot be recovered.
}
