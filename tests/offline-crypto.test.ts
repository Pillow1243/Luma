import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { supabase } = await import("../src/lib/supabase.ts");
const database = new Map<string, JsonWebKey>();
// Mock only the public-key table; the crypto itself is real Web Crypto.
(supabase as any).from = (table: string) => {
  assert.equal(table, "user_public_keys");
  return {
    select: () => ({ eq: (_column: string, userId: string) => ({ maybeSingle: async () => ({ data: database.has(userId) ? { public_key: database.get(userId) } : null, error: null }) }) }),
    insert: async (value: { user_id: string; public_key: JsonWebKey }) => {
      if (database.has(value.user_id)) return { error: { code: "23505" } };
      database.set(value.user_id, value.public_key); return { error: null };
    },
  };
};
const { cacheChats, cacheMessages, cachedChats, cachedMessages, listOutbox, putOutbox, removeOutbox, clearOfflineUser, offlineDB } = await import("../src/lib/offline.ts");
const { ensureSecretIdentity, encryptSecretText, decryptSecretText, secretSecurityCode } = await import("../src/lib/secret.ts");

test("IndexedDB isolates users, filters expired messages, and retains the outbox", async () => {
  const base = { chat_id: "chat", sender_id: "alice", reply_to: null, media_path: null, media_name: null, media_type: null, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, pinned_at: null, forwarded_from: null, mentions: [], media_duration: null, media_waveform: null, reactions: [] };
  const valid = { ...base, id: "one", body: "hello", expires_at: null };
  const expired = { ...base, id: "two", body: "gone", expires_at: "2000-01-01T00:00:00Z" };
  await cacheMessages("alice", "chat", [valid, expired]);
  assert.deepEqual((await cachedMessages("alice", "chat")).map((m) => m.id), ["one"]);
  assert.deepEqual(await cachedMessages("bob", "chat"), []);
  await cacheChats("alice", [{ chat: { id: "chat" } } as any]);
  assert.equal((await cachedChats("alice")).length, 1);
  assert.equal((await cachedChats("bob")).length, 0);
  const entry = { id: "uuid-1", userId: "alice", chatId: "chat", body: "queued", replyTo: null, mentions: [], expiresAt: null, createdAt: new Date().toISOString(), status: "queued" as const, attempts: 0, nextAttemptAt: 0 };
  await putOutbox(entry);
  assert.deepEqual((await listOutbox("alice")).map((e) => e.id), ["uuid-1"]);
  assert.deepEqual(await listOutbox("bob"), []);
  await removeOutbox(entry.id);
  assert.equal((await listOutbox("alice")).length, 0);
});

test("ECDH/HKDF/AES-GCM encrypts for both participants and binds sender and chat", async () => {
  const alice = await ensureSecretIdentity("alice");
  await ensureSecretIdentity("bob");
  assert.equal(alice.privateKey.extractable, false);
  assert.equal((database.get("alice") as any).d, undefined, "private key must never be published");
  const codeA = await secretSecurityCode("alice", "bob", "chat-1");
  const codeB = await secretSecurityCode("bob", "alice", "chat-1");
  assert.equal(codeA, codeB);
  const ciphertext = await encryptSecretText("alice", "bob", "chat-1", "Private message 🎉");
  assert.ok(ciphertext.startsWith("luma:e2ee:v1:"));
  assert.ok(!ciphertext.includes("Private message"));
  assert.equal(await decryptSecretText("bob", "alice", "chat-1", "alice", ciphertext), "Private message 🎉");
  assert.equal(await decryptSecretText("alice", "bob", "chat-1", "alice", ciphertext), "Private message 🎉");
  await assert.rejects(() => decryptSecretText("bob", "alice", "another-chat", "alice", ciphertext));
  await assert.rejects(() => decryptSecretText("bob", "alice", "chat-1", "bob", ciphertext));
  const chunks = ciphertext.split(":");
  const cipher = chunks[chunks.length - 1];
  chunks[chunks.length - 1] = (cipher[0] === "A" ? "B" : "A") + cipher.slice(1);
  await assert.rejects(() => decryptSecretText("bob", "alice", "chat-1", "alice", chunks.join(":")));
  (navigator as any).onLine = false;
  const queuedCiphertext = await encryptSecretText("alice", "bob", "chat-1", "offline secret");
  assert.equal(await decryptSecretText("bob", "alice", "chat-1", "alice", queuedCiphertext), "offline secret");
  (navigator as any).onLine = true;
  await clearOfflineUser("alice");
  assert.ok(await (await offlineDB()).get("keys", "alice"), "sign-out cleanup must not destroy an unrecoverable key");
});
