import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { PrekeyBundle, SecretTransport } from "../src/lib/secret.ts";

Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const { cacheChats, cacheMessages, cachedChats, cachedMessages, listOutbox, putOutbox, removeOutbox, clearOfflineUser } = await import("../src/lib/offline.ts");
const {
  createMemoryKeyStore,
  ensureSecretIdentity,
  encryptSecretText,
  decryptSecretText,
  secretSecurityCode,
} = await import("../src/lib/secret.ts");

function createMockTransport(): SecretTransport {
  const bundles = new Map<string, PrekeyBundle>();
  const opks = new Map<string, Array<{ key_id: number; public_key: string }>>();
  return {
    async publishBundle(input) {
      // Infer user by matching existing or store per caller via closure in multi-user helper
      throw new Error(`Use user-scoped transport (${input.identityKey.slice(0, 6)})`);
    },
    async claimBundle(peerId) {
      const b = bundles.get(peerId);
      if (!b) return null;
      const pool = opks.get(peerId) ?? [];
      const opk = pool.shift();
      return { ...b, one_time_key_id: opk?.key_id ?? null, one_time_key: opk?.public_key ?? null };
    },
    async countOneTimeKeys() {
      return 0;
    },
    async fetchLegacyPublicKey(userId) {
      return bundles.get(userId)?.identity_key ?? null;
    },
  };
}

function makeNetwork() {
  const bundles = new Map<string, PrekeyBundle>();
  const opks = new Map<string, Array<{ key_id: number; public_key: string }>>();
  const forUser = (userId: string): SecretTransport => ({
    async publishBundle(input) {
      bundles.set(userId, {
        user_id: userId,
        identity_key: input.identityKey,
        signing_key: input.signingKey,
        signed_prekey_id: input.signedPrekeyId,
        signed_prekey: input.signedPrekey,
        signed_prekey_sig: input.signedPrekeySig,
      });
      const existing = opks.get(userId) ?? [];
      existing.push(...input.oneTimeKeys);
      opks.set(userId, existing);
      return existing.length;
    },
    async claimBundle(peerId) {
      const b = bundles.get(peerId);
      if (!b) return null;
      const pool = opks.get(peerId) ?? [];
      const opk = pool.shift();
      return {
        ...b,
        one_time_key_id: opk?.key_id ?? null,
        one_time_key: opk?.public_key ?? null,
      };
    },
    async countOneTimeKeys() {
      return (opks.get(userId) ?? []).length;
    },
    async fetchLegacyPublicKey(uid) {
      return bundles.get(uid)?.identity_key ?? null;
    },
  });
  return { bundles, opks, forUser };
}

test("IndexedDB isolates users, filters expired messages, and retains the outbox", async () => {
  const base = {
    chat_id: "chat",
    sender_id: "alice",
    reply_to: null,
    media_path: null,
    media_name: null,
    media_type: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    pinned_at: null,
    forwarded_from: null,
    mentions: [],
    media_duration: null,
    media_waveform: null,
    reactions: [],
  };
  const valid = { ...base, id: "one", body: "hello", expires_at: null };
  const expired = { ...base, id: "two", body: "gone", expires_at: "2000-01-01T00:00:00Z" };
  await cacheMessages("alice", "chat", [valid, expired]);
  assert.deepEqual(
    (await cachedMessages("alice", "chat")).map((m) => m.id),
    ["one"]
  );
  assert.deepEqual(await cachedMessages("bob", "chat"), []);
  await cacheChats("alice", [{ chat: { id: "chat" } } as any]);
  assert.equal((await cachedChats("alice")).length, 1);
  assert.equal((await cachedChats("bob")).length, 0);
  const entry = {
    id: "uuid-1",
    userId: "alice",
    chatId: "chat",
    body: "queued",
    replyTo: null,
    mentions: [],
    expiresAt: null,
    createdAt: new Date().toISOString(),
    status: "queued" as const,
    attempts: 0,
    nextAttemptAt: 0,
  };
  await putOutbox(entry);
  assert.deepEqual(
    (await listOutbox("alice")).map((e) => e.id),
    ["uuid-1"]
  );
  assert.deepEqual(await listOutbox("bob"), []);
  await removeOutbox(entry.id);
  assert.equal((await listOutbox("alice")).length, 0);
});

test("X3DH + Double Ratchet encrypts for recipient, binds AAD, and keeps identity non-extractable", async () => {
  void createMockTransport;
  const net = makeNetwork();
  const storeA = createMemoryKeyStore();
  const storeB = createMemoryKeyStore();

  const alice = await ensureSecretIdentity("alice", storeA, net.forUser("alice"));
  await ensureSecretIdentity("bob", storeB, net.forUser("bob"));

  assert.equal(alice.privateKey.extractable, false);
  const pubBundle = net.bundles.get("alice")!;
  assert.equal((pubBundle as unknown as { d?: unknown }).d, undefined);

  const codeA = await secretSecurityCode("alice", "bob", "chat-1", storeA, net.forUser("alice"));
  const codeB = await secretSecurityCode("bob", "alice", "chat-1", storeB, net.forUser("bob"));
  assert.equal(codeA, codeB);

  const ciphertext = await encryptSecretText("alice", "bob", "chat-1", "Private message 🎉", {
    store: storeA,
    transport: net.forUser("alice"),
  });
  assert.ok(ciphertext.startsWith("luma:e2ee:v2:"));
  assert.ok(!ciphertext.includes("Private message"));

  assert.equal(
    await decryptSecretText("bob", "alice", "chat-1", "alice", ciphertext, {
      store: storeB,
      transport: net.forUser("bob"),
    }),
    "Private message 🎉"
  );
  assert.equal(
    await decryptSecretText("alice", "bob", "chat-1", "alice", ciphertext, {
      store: storeA,
      transport: net.forUser("alice"),
    }),
    "Private message 🎉"
  );

  await assert.rejects(() =>
    decryptSecretText("bob", "alice", "another-chat", "alice", ciphertext, {
      store: storeB,
      transport: net.forUser("bob"),
    })
  );
  await assert.rejects(() =>
    decryptSecretText("bob", "charlie", "chat-1", "charlie", ciphertext, {
      store: storeB,
      transport: net.forUser("bob"),
    })
  );

  // Tamper ciphertext payload
  const raw = JSON.parse(
    Buffer.from(ciphertext.slice("luma:e2ee:v2:".length), "base64").toString("utf8")
  ) as { h: unknown; iv: string; ct: string };
  raw.ct = (raw.ct[0] === "A" ? "B" : "A") + raw.ct.slice(1);
  const tampered = "luma:e2ee:v2:" + Buffer.from(JSON.stringify(raw), "utf8").toString("base64");
  await assert.rejects(() =>
    decryptSecretText("bob", "alice", "chat-1", "alice", tampered, {
      store: storeB,
      transport: net.forUser("bob"),
    })
  );

  await clearOfflineUser("alice");
  assert.ok(await storeA.getIdentity("alice"), "sign-out offline cleanup preserves device secret keys");
});
