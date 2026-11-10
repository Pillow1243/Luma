import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { PrekeyBundle, SecretTransport } from "../src/lib/secret.ts";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const {
  createMemoryKeyStore,
  decryptSecretMediaBlob,
  decryptSecretText,
  encryptSecretMediaFile,
  encryptSecretText,
  ensureSecretIdentity,
  getSecretChatInfo,
  trustPeerKey,
} = await import("../src/lib/secret.ts");

function makeTestNetwork() {
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

test("Double Ratchet handles multi-turn conversation and out-of-order message delivery", async () => {
  const net = makeTestNetwork();
  const aliceStore = createMemoryKeyStore();
  const bobStore = createMemoryKeyStore();
  const aliceNet = net.forUser("alice");
  const bobNet = net.forUser("bob");

  await ensureSecretIdentity("alice", aliceStore, aliceNet);
  await ensureSecretIdentity("bob", bobStore, bobNet);

  // Alice sends 3 messages; Bob receives #3 first, then #1, then #2
  const m1 = await encryptSecretText("alice", "bob", "c1", "msg-1", { store: aliceStore, transport: aliceNet });
  const m2 = await encryptSecretText("alice", "bob", "c1", "msg-2", { store: aliceStore, transport: aliceNet });
  const m3 = await encryptSecretText("alice", "bob", "c1", "msg-3", { store: aliceStore, transport: aliceNet });

  assert.equal(await decryptSecretText("bob", "alice", "c1", "alice", m3, { store: bobStore, transport: bobNet }), "msg-3");
  assert.equal(await decryptSecretText("bob", "alice", "c1", "alice", m1, { store: bobStore, transport: bobNet }), "msg-1");
  assert.equal(await decryptSecretText("bob", "alice", "c1", "alice", m2, { store: bobStore, transport: bobNet }), "msg-2");

  // Bob replies -> triggers DH ratchet step on Alice
  const r1 = await encryptSecretText("bob", "alice", "c1", "reply-1", { store: bobStore, transport: bobNet });
  assert.equal(await decryptSecretText("alice", "bob", "c1", "bob", r1, { store: aliceStore, transport: aliceNet }), "reply-1");

  // Alice replies -> triggers second DH ratchet step on Bob
  const m4 = await encryptSecretText("alice", "bob", "c1", "msg-4", { store: aliceStore, transport: aliceNet });
  assert.equal(await decryptSecretText("bob", "alice", "c1", "alice", m4, { store: bobStore, transport: bobNet }), "msg-4");
});

test("Simultaneous first-message initiation converges without message loss", async () => {
  const net = makeTestNetwork();
  const aliceStore = createMemoryKeyStore();
  const bobStore = createMemoryKeyStore();
  const aliceNet = net.forUser("alice");
  const bobNet = net.forUser("bob");

  await ensureSecretIdentity("alice", aliceStore, aliceNet);
  await ensureSecretIdentity("bob", bobStore, bobNet);

  const aInit = await encryptSecretText("alice", "bob", "c-race", "hello bob", { store: aliceStore, transport: aliceNet });
  const bInit = await encryptSecretText("bob", "alice", "c-race", "hello alice", { store: bobStore, transport: bobNet });

  assert.equal(await decryptSecretText("bob", "alice", "c-race", "alice", aInit, { store: bobStore, transport: bobNet }), "hello bob");
  assert.equal(await decryptSecretText("alice", "bob", "c-race", "bob", bInit, { store: aliceStore, transport: aliceNet }), "hello alice");

  // Follow-up from both converges cleanly
  const aNext = await encryptSecretText("alice", "bob", "c-race", "converged-a", { store: aliceStore, transport: aliceNet });
  assert.equal(await decryptSecretText("bob", "alice", "c-race", "alice", aNext, { store: bobStore, transport: bobNet }), "converged-a");
});

test("Changed peer identity key is flagged and blocks encryption until explicitly verified", async () => {
  const net = makeTestNetwork();
  const aliceStore = createMemoryKeyStore();
  const bobStore1 = createMemoryKeyStore();
  const bobStore2 = createMemoryKeyStore();
  const aliceNet = net.forUser("alice");
  const bobNet = net.forUser("bob");

  await ensureSecretIdentity("alice", aliceStore, aliceNet);
  await ensureSecretIdentity("bob", bobStore1, bobNet);

  const initialInfo = await getSecretChatInfo("alice", "bob", "c-pin", aliceStore, aliceNet);
  assert.equal(initialInfo.keyChanged, false);

  // Bob reinstalls on a new device -> rotates identity key
  await ensureSecretIdentity("bob", bobStore2, bobNet);
  const changedInfo = await getSecretChatInfo("alice", "bob", "c-pin", aliceStore, aliceNet);
  assert.equal(changedInfo.keyChanged, true);

  await assert.rejects(
    () => encryptSecretText("alice", "bob", "c-pin", "blocked", { store: aliceStore, transport: aliceNet }),
    /KEY_CHANGED/
  );

  // User verifies new safety number -> encryption resumes
  await trustPeerKey("alice", "bob", changedInfo.peerPublicKey!, true, aliceStore);
  const afterTrust = await getSecretChatInfo("alice", "bob", "c-pin", aliceStore, aliceNet);
  assert.equal(afterTrust.keyChanged, false);
  assert.equal(afterTrust.verified, true);
});

test("Encrypted attachment helper encrypts and decrypts binary media faithfully", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 42, 99, 255]);
  const blob = new Blob([bytes], { type: "image/png" });
  const { encryptedBlob, mediaKey, mediaIv } = await encryptSecretMediaFile(blob);
  const cipherBytes = new Uint8Array(await encryptedBlob.arrayBuffer());
  assert.notDeepEqual(cipherBytes.slice(0, bytes.length), bytes);

  const decrypted = await decryptSecretMediaBlob(encryptedBlob, mediaKey, mediaIv, "image/png");
  assert.equal(decrypted.type, "image/png");
  assert.deepEqual(new Uint8Array(await decrypted.arrayBuffer()), bytes);
});
