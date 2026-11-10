import { supabase } from "./supabase";

export const SECRET_PREFIX_V1 = "luma:e2ee:v1:";
export const SECRET_PREFIX_V2 = "luma:e2ee:v2:";
const MAX_SKIP = 40;
const MAX_STORED_SKIPPED = 80;
const TARGET_OPK_POOL = 20;
const MIN_OPK_POOL = 8;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Narrow Uint8Array<ArrayBufferLike> to BufferSource for strict TS 5.6+ Web Crypto DOM types. */
const bs = (u: Uint8Array): Uint8Array<ArrayBuffer> =>
  (u.buffer instanceof ArrayBuffer && u.byteOffset === 0 && u.byteLength === u.buffer.byteLength
    ? u
    : new Uint8Array(u)) as Uint8Array<ArrayBuffer>;

export const to64 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
};

export const from64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

/* ------------------------------------------------------------------ types */

export interface PrekeyBundle {
  user_id: string;
  identity_key: string;
  signing_key: string;
  signed_prekey_id: number;
  signed_prekey: string;
  signed_prekey_sig: string;
  one_time_key_id?: number | null;
  one_time_key?: string | null;
}

export interface SecretMediaPayload {
  key: string;
  iv: string;
  name: string;
  type: string;
  size: number;
}

export interface SecretEnvelopePayload {
  t: "text" | "media";
  text?: string;
  media?: SecretMediaPayload;
}

interface StoredIdentity {
  userId: string;
  publicKey: string;
  privateKey: CryptoKey;
  signingPublicKey: string;
  signingPrivateKey: CryptoKey;
  signedPrekeyId: number;
  signedPrekeyPublic: string;
  signedPrekeyPrivate: CryptoKey;
  signedPrekeySig: string;
  nextOpkId: number;
}

interface StoredOpk {
  id: string; // `${userId}:${keyId}`
  userId: string;
  keyId: number;
  publicKey: string;
  privateKey: CryptoKey;
}

interface X3dhInitHeader {
  ik: string;
  ek: string;
  spkId: number;
  opkId?: number | null;
}

interface RatchetHeader {
  v: 2;
  sid: string;
  dh: string;
  n: number;
  pn: number;
  x3dh?: X3dhInitHeader;
}

interface StoredRatchetSession {
  id: string; // `${userId}:${chatId}:${sid}`
  userId: string;
  chatId: string;
  peerId: string;
  sid: string;
  rk: string; // base64
  dhSendPub: string;
  dhSendPriv: CryptoKey;
  dhRecvPub: string | null;
  ckSend: string | null;
  ckRecv: string | null;
  ns: number;
  nr: number;
  pn: number;
  pendingX3dh: X3dhInitHeader | null;
  skipped: Record<string, string>; // `${dh}:${n}` -> base64 mk
  updatedAt: number;
}

interface ActiveSessionPointer {
  id: string; // `${userId}:${chatId}`
  sid: string;
}

interface PeerPin {
  id: string; // `${userId}:${peerId}`
  publicKey: string;
  verified?: boolean;
  verifiedAt?: number;
}

interface CachedPlaintext {
  id: string; // `${userId}:${key}`
  payload: string;
  expiresAt?: number;
}

/* --------------------------------------------------------------- storage */

export interface SecretKeyStore {
  getIdentity(userId: string): Promise<StoredIdentity | undefined>;
  putIdentity(val: StoredIdentity): Promise<void>;
  getOpk(userId: string, keyId: number): Promise<StoredOpk | undefined>;
  putOpks(items: StoredOpk[]): Promise<void>;
  deleteOpk(userId: string, keyId: number): Promise<void>;
  getSession(userId: string, chatId: string, sid: string): Promise<StoredRatchetSession | undefined>;
  putSession(session: StoredRatchetSession): Promise<void>;
  getActiveSid(userId: string, chatId: string): Promise<string | undefined>;
  setActiveSid(userId: string, chatId: string, sid: string): Promise<void>;
  getPin(userId: string, peerId: string): Promise<PeerPin | undefined>;
  putPin(pin: PeerPin): Promise<void>;
  getCachedPlaintext(userId: string, key: string): Promise<string | undefined>;
  putCachedPlaintext(userId: string, key: string, payload: string, expiresAt?: number): Promise<void>;
  clearUser(userId: string): Promise<void>;
}

const DB_NAME = "luma-secret-v2";
const LEGACY_DB_NAME = "luma-secret";

function openV2Db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["identities", "opks", "sessions", "active", "pins", "cache"]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, val: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDel(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function readLegacyV1Identity(userId: string): Promise<{ publicKey: string; privateKey: CryptoKey } | undefined> {
  try {
    if (typeof indexedDB === "undefined") return undefined;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("identityKeys")) {
          req.result.createObjectStore("identityKeys", { keyPath: "userId" });
        }
        if (!req.result.objectStoreNames.contains("peerPins")) {
          req.result.createObjectStore("peerPins", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rec = await idbGet<{ publicKey: string; privateKey: CryptoKey }>(db, "identityKeys", userId);
    db.close();
    return rec;
  } catch {
    return undefined;
  }
}

export function createIndexedDbKeyStore(): SecretKeyStore {
  return {
    async getIdentity(userId) {
      const db = await openV2Db();
      try {
        return await idbGet<StoredIdentity & { id: string }>(db, "identities", userId);
      } finally {
        db.close();
      }
    },
    async putIdentity(val) {
      const db = await openV2Db();
      try {
        await idbPut(db, "identities", { ...val, id: val.userId });
      } finally {
        db.close();
      }
    },
    async getOpk(userId, keyId) {
      const db = await openV2Db();
      try {
        return await idbGet<StoredOpk>(db, "opks", `${userId}:${keyId}`);
      } finally {
        db.close();
      }
    },
    async putOpks(items) {
      if (!items.length) return;
      const db = await openV2Db();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("opks", "readwrite");
          const st = tx.objectStore("opks");
          for (const item of items) st.put(item);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    async deleteOpk(userId, keyId) {
      const db = await openV2Db();
      try {
        await idbDel(db, "opks", `${userId}:${keyId}`);
      } finally {
        db.close();
      }
    },
    async getSession(userId, chatId, sid) {
      const db = await openV2Db();
      try {
        return await idbGet<StoredRatchetSession>(db, "sessions", `${userId}:${chatId}:${sid}`);
      } finally {
        db.close();
      }
    },
    async putSession(session) {
      const db = await openV2Db();
      try {
        await idbPut(db, "sessions", session);
      } finally {
        db.close();
      }
    },
    async getActiveSid(userId, chatId) {
      const db = await openV2Db();
      try {
        const row = await idbGet<ActiveSessionPointer>(db, "active", `${userId}:${chatId}`);
        return row?.sid;
      } finally {
        db.close();
      }
    },
    async setActiveSid(userId, chatId, sid) {
      const db = await openV2Db();
      try {
        await idbPut(db, "active", { id: `${userId}:${chatId}`, sid });
      } finally {
        db.close();
      }
    },
    async getPin(userId, peerId) {
      const db = await openV2Db();
      try {
        return await idbGet<PeerPin>(db, "pins", `${userId}:${peerId}`);
      } finally {
        db.close();
      }
    },
    async putPin(pin) {
      const db = await openV2Db();
      try {
        await idbPut(db, "pins", pin);
      } finally {
        db.close();
      }
    },
    async getCachedPlaintext(userId, key) {
      const db = await openV2Db();
      try {
        const rec = await idbGet<CachedPlaintext>(db, "cache", `${userId}:${key}`);
        if (!rec) return undefined;
        if (rec.expiresAt && rec.expiresAt <= Date.now()) {
          await idbDel(db, "cache", `${userId}:${key}`);
          return undefined;
        }
        return rec.payload;
      } finally {
        db.close();
      }
    },
    async putCachedPlaintext(userId, key, payload, expiresAt) {
      const db = await openV2Db();
      try {
        await idbPut(db, "cache", { id: `${userId}:${key}`, payload, expiresAt });
      } finally {
        db.close();
      }
    },
    async clearUser(userId) {
      const db = await openV2Db();
      try {
        for (const storeName of ["identities", "opks", "sessions", "active", "pins", "cache"]) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(storeName, "readwrite");
            const st = tx.objectStore(storeName);
            const req = st.openCursor();
            req.onsuccess = () => {
              const cur = req.result;
              if (!cur) return;
              if (String(cur.key) === userId || String(cur.key).startsWith(`${userId}:`)) {
                cur.delete();
              }
              cur.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
      } finally {
        db.close();
      }
    },
  };
}

export function createMemoryKeyStore(): SecretKeyStore {
  const identities = new Map<string, StoredIdentity>();
  const opks = new Map<string, StoredOpk>();
  const sessions = new Map<string, StoredRatchetSession>();
  const active = new Map<string, string>();
  const pins = new Map<string, PeerPin>();
  const cache = new Map<string, CachedPlaintext>();
  return {
    getIdentity: async (u) => identities.get(u),
    putIdentity: async (v) => { identities.set(v.userId, v); },
    getOpk: async (u, k) => opks.get(`${u}:${k}`),
    putOpks: async (items) => { for (const i of items) opks.set(i.id, i); },
    deleteOpk: async (u, k) => { opks.delete(`${u}:${k}`); },
    getSession: async (u, c, s) => sessions.get(`${u}:${c}:${s}`),
    putSession: async (s) => { sessions.set(s.id, s); },
    getActiveSid: async (u, c) => active.get(`${u}:${c}`),
    setActiveSid: async (u, c, sid) => { active.set(`${u}:${c}`, sid); },
    getPin: async (u, p) => pins.get(`${u}:${p}`),
    putPin: async (p) => { pins.set(p.id, p); },
    getCachedPlaintext: async (u, k) => {
      const r = cache.get(`${u}:${k}`);
      if (!r) return undefined;
      if (r.expiresAt && r.expiresAt <= Date.now()) { cache.delete(`${u}:${k}`); return undefined; }
      return r.payload;
    },
    putCachedPlaintext: async (u, k, payload, expiresAt) => {
      cache.set(`${u}:${k}`, { id: `${u}:${k}`, payload, expiresAt });
    },
    clearUser: async (u) => {
      identities.delete(u);
      for (const m of [opks, sessions, active, pins, cache] as Map<string, unknown>[]) {
        for (const k of m.keys()) if (k.startsWith(`${u}:`)) m.delete(k);
      }
    },
  };
}

const defaultStore: SecretKeyStore =
  typeof indexedDB !== "undefined" ? createIndexedDbKeyStore() : createMemoryKeyStore();

export interface SecretTransport {
  publishBundle(input: {
    identityKey: string;
    signingKey: string;
    signedPrekeyId: number;
    signedPrekey: string;
    signedPrekeySig: string;
    oneTimeKeys: Array<{ key_id: number; public_key: string }>;
  }): Promise<number>;
  claimBundle(peerId: string): Promise<PrekeyBundle | null>;
  countOneTimeKeys(): Promise<number>;
  fetchLegacyPublicKey(userId: string): Promise<JsonWebKey | string | null>;
  fetchIdentityKey?(userId: string): Promise<string | null>;
}

const defaultTransport: SecretTransport = {
  async publishBundle(input) {
    const { data, error } = await supabase.rpc("publish_prekey_bundle", {
      p_identity_key: input.identityKey,
      p_signing_key: input.signingKey,
      p_signed_prekey_id: input.signedPrekeyId,
      p_signed_prekey: input.signedPrekey,
      p_signed_prekey_sig: input.signedPrekeySig,
      p_one_time_keys: input.oneTimeKeys,
    });
    if (error) throw error;
    return Number(data ?? 0);
  },
  async claimBundle(peerId) {
    const { data, error } = await supabase.rpc("claim_prekey_bundle", { target_user: peerId });
    if (error) throw error;
    return (data as PrekeyBundle | null) ?? null;
  },
  async countOneTimeKeys() {
    const { data, error } = await supabase.rpc("count_one_time_prekeys");
    if (error) return 0;
    return Number(data ?? 0);
  },
  async fetchLegacyPublicKey(userId) {
    const { data, error } = await supabase
      .from("user_public_keys")
      .select("public_key")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data?.public_key as JsonWebKey | string | null) ?? null;
  },
  async fetchIdentityKey(userId) {
    const { data, error } = await supabase
      .from("user_prekey_bundles")
      .select("identity_key")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data?.identity_key as string | null) ?? null;
  },
};

/* ----------------------------------------------------------- crypto core */

async function genEcdh(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return { publicKey: to64(new Uint8Array(spki)), privateKey: pair.privateKey };
}

async function importEcdhPub(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    bs(from64(b64)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function ecdhBits(priv: CryptoKey, pubB64: string): Promise<Uint8Array> {
  const pub = await importEcdhPub(pubB64);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  return new Uint8Array(bits);
}

async function kdfRoot(rk: Uint8Array, dhOut: Uint8Array): Promise<{ rootKey: Uint8Array; chainKey: Uint8Array }> {
  const ikm = await crypto.subtle.importKey("raw", bs(dhOut), "HKDF", false, ["deriveBits"]);
  const out = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: bs(rk),
        info: bs(enc.encode("LumaRatchetRKv2")),
      },
      ikm,
      512
    )
  );
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32, 64) };
}

async function kdfChain(ck: Uint8Array): Promise<{ nextChainKey: Uint8Array; messageKey: Uint8Array }> {
  const key = await crypto.subtle.importKey("raw", bs(ck), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mk = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([0x01])));
  const nextCk = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([0x02])));
  return { messageKey: mk, nextChainKey: nextCk };
}

async function aesGcmEncrypt(mk: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", bs(mk), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad) }, key, bs(plaintext))
  );
  return { iv: to64(iv), ct: to64(ct) };
}

async function aesGcmDecrypt(mk: Uint8Array, ivB64: string, ctB64: string, aad: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bs(mk), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(from64(ivB64)), additionalData: bs(aad) },
    key,
    bs(from64(ctB64))
  );
  return new Uint8Array(pt);
}

function buildAad(chatId: string, senderId: string, recipientId: string, hdr: RatchetHeader): Uint8Array {
  return enc.encode(
    JSON.stringify({
      v: 2,
      sid: hdr.sid,
      chatId,
      senderId,
      recipientId,
      dh: hdr.dh,
      n: hdr.n,
      pn: hdr.pn,
    })
  );
}

async function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(`luma-ratchet:${chatId}`, fn);
  }
  return fn();
}

/* ----------------------------------------------------------- public API */

export async function ensureSecretIdentity(
  userId: string,
  store: SecretKeyStore = defaultStore,
  transport: SecretTransport = defaultTransport
): Promise<StoredIdentity> {
  let id = await store.getIdentity(userId);
  let needsPublish = false;

  if (!id) {
    // Reuse legacy v1 identity ECDH key if present on this device so v1 messages still decrypt
    const legacy = await readLegacyV1Identity(userId);
    const ik = legacy ?? (await genEcdh());
    const signPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"]
    );
    const signingPublicKey = to64(new Uint8Array(await crypto.subtle.exportKey("spki", signPair.publicKey)));
    const spk = await genEcdh();
    const spkSig = to64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          signPair.privateKey,
          bs(from64(spk.publicKey))
        )
      )
    );

    id = {
      userId,
      publicKey: ik.publicKey,
      privateKey: ik.privateKey,
      signingPublicKey,
      signingPrivateKey: signPair.privateKey,
      signedPrekeyId: 1,
      signedPrekeyPublic: spk.publicKey,
      signedPrekeyPrivate: spk.privateKey,
      signedPrekeySig: spkSig,
      nextOpkId: 1,
    };
    await store.putIdentity(id);
    needsPublish = true;
  }

  const remoteCount = await transport.countOneTimeKeys().catch(() => TARGET_OPK_POOL);
  if (needsPublish || remoteCount < MIN_OPK_POOL) {
    const batchCount = needsPublish ? TARGET_OPK_POOL : TARGET_OPK_POOL - remoteCount;
    const newOpks: StoredOpk[] = [];
    const startId = id.nextOpkId;
    for (let i = 0; i < batchCount; i++) {
      const pair = await genEcdh();
      const keyId = startId + i;
      newOpks.push({
        id: `${userId}:${keyId}`,
        userId,
        keyId,
        publicKey: pair.publicKey,
        privateKey: pair.privateKey,
      });
    }
    id = { ...id, nextOpkId: startId + batchCount };
    await store.putOpks(newOpks);
    await store.putIdentity(id);

    await transport.publishBundle({
      identityKey: id.publicKey,
      signingKey: id.signingPublicKey,
      signedPrekeyId: id.signedPrekeyId,
      signedPrekey: id.signedPrekeyPublic,
      signedPrekeySig: id.signedPrekeySig,
      oneTimeKeys: newOpks.map((k) => ({ key_id: k.keyId, public_key: k.publicKey })),
    });
  }

  return id;
}

export async function safetyCode(
  userA: string,
  pubA: string,
  userB: string,
  pubB: string
): Promise<string> {
  const ordered = [
    [userA, pubA],
    [userB, pubB],
  ]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([u, k]) => `${u}:${k}`)
    .join("|");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bs(enc.encode(ordered))));
  return (
    Array.from(digest.slice(0, 16), (v) => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
      .match(/.{4}/g)
      ?.join(" ") ?? ""
  );
}

const SAFETY_EMOJI = [
  "🔐", "🌙", "🦊", "🛰️", "🔮", "🌿", "⚡", "🧭",
  "💎", "🦉", "🔥", "🌊", "❄️", "🍀", "🦄", "🛡️",
];

export async function safetyEmojis(code: string): Promise<string[]> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bs(enc.encode(code))));
  return Array.from({ length: 6 }, (_, i) => SAFETY_EMOJI[digest[i] % SAFETY_EMOJI.length]);
}

export async function inspectPeerPin(
  myId: string,
  peerId: string,
  store: SecretKeyStore = defaultStore,
  transport: SecretTransport = defaultTransport
): Promise<{
  publicKey: string | null;
  keyChanged: boolean;
  verified: boolean;
}> {
  let remoteKey = transport.fetchIdentityKey
    ? await transport.fetchIdentityKey(peerId)
    : null;
  if (!remoteKey) {
    const legacy = await transport.fetchLegacyPublicKey(peerId);
    remoteKey =
      typeof legacy === "string"
        ? legacy
        : legacy
          ? JSON.stringify(legacy)
          : null;
  }
  const pin = await store.getPin(myId, peerId);
  if (!remoteKey) return { publicKey: null, keyChanged: false, verified: Boolean(pin?.verified) };
  if (!pin) {
    await store.putPin({ id: `${myId}:${peerId}`, publicKey: remoteKey, verified: false });
    return { publicKey: remoteKey, keyChanged: false, verified: false };
  }
  return {
    publicKey: remoteKey,
    keyChanged: pin.publicKey !== remoteKey,
    verified: pin.publicKey === remoteKey && Boolean(pin.verified),
  };
}

export async function trustPeerKey(
  myId: string,
  peerId: string,
  publicKey: string,
  verified = true,
  store: SecretKeyStore = defaultStore
): Promise<void> {
  await store.putPin({
    id: `${myId}:${peerId}`,
    publicKey,
    verified,
    verifiedAt: Date.now(),
  });
}

async function assertPeerPinValid(
  myId: string,
  peerId: string,
  identityKey: string,
  store: SecretKeyStore
): Promise<void> {
  const pin = await store.getPin(myId, peerId);
  if (!pin) {
    await store.putPin({ id: `${myId}:${peerId}`, publicKey: identityKey, verified: false });
    return;
  }
  if (pin.publicKey !== identityKey) {
    throw new Error("KEY_CHANGED: Peer identity key changed. Verify their safety number first.");
  }
}

/* ----------------------------------------------------------- v2 ratchet */

async function verifyBundleSignature(bundle: PrekeyBundle): Promise<void> {
  const sigKey = await crypto.subtle.importKey(
    "spki",
    bs(from64(bundle.signing_key)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    sigKey,
    bs(from64(bundle.signed_prekey_sig)),
    bs(from64(bundle.signed_prekey))
  );
  if (!ok) {
    throw new Error("Invalid signed prekey signature from peer");
  }
}

async function deriveX3dhSecret(
  chatId: string,
  parts: Uint8Array[]
): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", bs(concat(...parts)), "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bs(enc.encode(`luma:x3dh:v2:${chatId}`)))
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(enc.encode("LumaX3DHv2")) },
      ikm,
      256
    )
  );
}

async function createInitiatorSession(
  myId: string,
  peerId: string,
  chatId: string,
  identity: StoredIdentity,
  store: SecretKeyStore,
  transport: SecretTransport
): Promise<StoredRatchetSession> {
  const bundle = await transport.claimBundle(peerId);
  if (!bundle) {
    throw new Error("Peer has not opened updated Luma yet to publish secret prekeys.");
  }
  await verifyBundleSignature(bundle);
  await assertPeerPinValid(myId, peerId, bundle.identity_key, store);

  const ek = await genEcdh();
  const dh1 = await ecdhBits(identity.privateKey, bundle.signed_prekey);
  const dh2 = await ecdhBits(ek.privateKey, bundle.identity_key);
  const dh3 = await ecdhBits(ek.privateKey, bundle.signed_prekey);
  const parts = [dh1, dh2, dh3];
  if (bundle.one_time_key) {
    parts.push(await ecdhBits(ek.privateKey, bundle.one_time_key));
  }
  const sk = await deriveX3dhSecret(chatId, parts);

  const dhSend = await genEcdh();
  const dhOut = await ecdhBits(dhSend.privateKey, bundle.signed_prekey);
  const { rootKey, chainKey } = await kdfRoot(sk, dhOut);

  const sid = crypto.randomUUID().slice(0, 12);
  const session: StoredRatchetSession = {
    id: `${myId}:${chatId}:${sid}`,
    userId: myId,
    chatId,
    peerId,
    sid,
    rk: to64(rootKey),
    dhSendPub: dhSend.publicKey,
    dhSendPriv: dhSend.privateKey,
    dhRecvPub: bundle.signed_prekey,
    ckSend: to64(chainKey),
    ckRecv: null,
    ns: 0,
    nr: 0,
    pn: 0,
    pendingX3dh: {
      ik: identity.publicKey,
      ek: ek.publicKey,
      spkId: bundle.signed_prekey_id,
      opkId: bundle.one_time_key_id ?? null,
    },
    skipped: {},
    updatedAt: Date.now(),
  };
  await store.putSession(session);
  await store.setActiveSid(myId, chatId, sid);
  return session;
}

async function createResponderSession(
  myId: string,
  peerId: string,
  chatId: string,
  identity: StoredIdentity,
  hdr: RatchetHeader,
  store: SecretKeyStore
): Promise<StoredRatchetSession> {
  const x3dh = hdr.x3dh!;
  await assertPeerPinValid(myId, peerId, x3dh.ik, store);

  const dh1 = await ecdhBits(identity.signedPrekeyPrivate, x3dh.ik);
  const dh2 = await ecdhBits(identity.privateKey, x3dh.ek);
  const dh3 = await ecdhBits(identity.signedPrekeyPrivate, x3dh.ek);
  const parts = [dh1, dh2, dh3];
  if (x3dh.opkId != null) {
    const opk = await store.getOpk(myId, x3dh.opkId);
    if (!opk) {
      throw new Error("Missing one-time prekey for incoming secret session.");
    }
    parts.push(await ecdhBits(opk.privateKey, x3dh.ek));
    await store.deleteOpk(myId, x3dh.opkId);
  }
  const sk = await deriveX3dhSecret(chatId, parts);
  const dhOut = await ecdhBits(identity.signedPrekeyPrivate, hdr.dh);
  const { rootKey, chainKey } = await kdfRoot(sk, dhOut);

  const session: StoredRatchetSession = {
    id: `${myId}:${chatId}:${hdr.sid}`,
    userId: myId,
    chatId,
    peerId,
    sid: hdr.sid,
    rk: to64(rootKey),
    dhSendPub: identity.signedPrekeyPublic,
    dhSendPriv: identity.signedPrekeyPrivate,
    dhRecvPub: hdr.dh,
    ckSend: null,
    ckRecv: to64(chainKey),
    ns: 0,
    nr: 0,
    pn: 0,
    pendingX3dh: null,
    skipped: {},
    updatedAt: Date.now(),
  };
  await store.putSession(session);
  // Concurrent initiation tie-breaker: deterministically converge onto lower peer's active session
  const existingSid = await store.getActiveSid(myId, chatId);
  if (!existingSid || peerId < myId) {
    await store.setActiveSid(myId, chatId, hdr.sid);
  }
  return session;
}

async function skipMessageKeys(session: StoredRatchetSession, until: number): Promise<void> {
  if (!session.ckRecv || !session.dhRecvPub) return;
  if (session.nr + MAX_SKIP < until) {
    throw new Error("Skipped message limit exceeded");
  }
  let ck = from64(session.ckRecv);
  while (session.nr < until) {
    const { nextChainKey, messageKey } = await kdfChain(ck);
    ck = nextChainKey;
    const keys = Object.keys(session.skipped);
    if (keys.length >= MAX_STORED_SKIPPED) {
      delete session.skipped[keys[0]];
    }
    session.skipped[`${session.dhRecvPub}:${session.nr}`] = to64(messageKey);
    session.nr += 1;
  }
  session.ckRecv = to64(ck);
}

async function dhRatchetStep(session: StoredRatchetSession, remoteDhPub: string): Promise<void> {
  session.pn = session.ns;
  session.ns = 0;
  session.nr = 0;
  session.dhRecvPub = remoteDhPub;

  const dhIn = await ecdhBits(session.dhSendPriv, remoteDhPub);
  const step1 = await kdfRoot(from64(session.rk), dhIn);
  session.rk = to64(step1.rootKey);
  session.ckRecv = to64(step1.chainKey);

  const nextDh = await genEcdh();
  session.dhSendPub = nextDh.publicKey;
  session.dhSendPriv = nextDh.privateKey;

  const dhOut = await ecdhBits(session.dhSendPriv, remoteDhPub);
  const step2 = await kdfRoot(from64(session.rk), dhOut);
  session.rk = to64(step2.rootKey);
  session.ckSend = to64(step2.chainKey);
  session.pendingX3dh = null;
}

export async function encryptSecretMessage(
  chatId: string,
  senderId: string,
  recipientId: string,
  plaintext: string,
  opts?: {
    store?: SecretKeyStore;
    transport?: SecretTransport;
    media?: SecretMediaPayload;
    expiresAt?: number;
  }
): Promise<string> {
  const store = opts?.store ?? defaultStore;
  const transport = opts?.transport ?? defaultTransport;

  return withChatLock(chatId, async () => {
    const identity = await ensureSecretIdentity(senderId, store, transport);
    const activeSid = await store.getActiveSid(senderId, chatId);
    let session = activeSid ? await store.getSession(senderId, chatId, activeSid) : undefined;

    if (!session) {
      session = await createInitiatorSession(senderId, recipientId, chatId, identity, store, transport);
    } else if (!session.ckSend) {
      // Responder session that hasn't sent yet: generate fresh DH sending key if needed
      if (!session.dhRecvPub) throw new Error("Missing peer ratchet key");
      const nextDh = await genEcdh();
      const dhOut = await ecdhBits(nextDh.privateKey, session.dhRecvPub);
      const { rootKey, chainKey } = await kdfRoot(from64(session.rk), dhOut);
      session.dhSendPub = nextDh.publicKey;
      session.dhSendPriv = nextDh.privateKey;
      session.rk = to64(rootKey);
      session.ckSend = to64(chainKey);
      session.ns = 0;
    }

    const { nextChainKey, messageKey } = await kdfChain(from64(session.ckSend!));
    const hdr: RatchetHeader = {
      v: 2,
      sid: session.sid,
      dh: session.dhSendPub,
      n: session.ns,
      pn: session.pn,
      ...(session.pendingX3dh ? { x3dh: session.pendingX3dh } : {}),
    };

    const payloadObj: SecretEnvelopePayload = opts?.media
      ? { t: "media", text: plaintext || undefined, media: opts.media }
      : { t: "text", text: plaintext };
    const payloadStr = JSON.stringify(payloadObj);

    const aad = buildAad(chatId, senderId, recipientId, hdr);
    const { iv, ct } = await aesGcmEncrypt(messageKey, enc.encode(payloadStr), aad);

    session.ckSend = to64(nextChainKey);
    session.ns += 1;
    session.updatedAt = Date.now();
    await store.putSession(session);

    const encoded = SECRET_PREFIX_V2 + to64(enc.encode(JSON.stringify({ h: hdr, iv, ct })));
    await store.putCachedPlaintext(
      senderId,
      `${chatId}:${senderId}:${recipientId}:${encoded}`,
      payloadStr,
      opts?.expiresAt
    );
    return encoded;
  });
}

export async function decryptSecretEnvelope(
  chatId: string,
  senderId: string,
  recipientId: string,
  viewerId: string,
  body: string,
  opts?: {
    store?: SecretKeyStore;
    transport?: SecretTransport;
    expiresAt?: number;
  }
): Promise<SecretEnvelopePayload | null> {
  const store = opts?.store ?? defaultStore;
  const transport = opts?.transport ?? defaultTransport;

  if (body.startsWith(SECRET_PREFIX_V1)) {
    const legacy = await decryptV1Text(chatId, senderId, recipientId, viewerId, body, store, transport);
    return legacy !== null ? { t: "text", text: legacy } : null;
  }
  if (!body.startsWith(SECRET_PREFIX_V2)) return null;

  const cacheKey = `${chatId}:${senderId}:${recipientId}:${body}`;
  const cached = await store.getCachedPlaintext(viewerId, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as SecretEnvelopePayload;
    } catch {
      return { t: "text", text: cached };
    }
  }

  // Own outgoing message can only be read from local device cache
  if (senderId === viewerId) return null;

  return withChatLock(chatId, async () => {
    const again = await store.getCachedPlaintext(viewerId, cacheKey);
    if (again) return JSON.parse(again) as SecretEnvelopePayload;

    const raw = JSON.parse(dec.decode(from64(body.slice(SECRET_PREFIX_V2.length)))) as {
      h: RatchetHeader;
      iv: string;
      ct: string;
    };
    const hdr = raw.h;
    const identity = await ensureSecretIdentity(viewerId, store, transport);

    let session = await store.getSession(viewerId, chatId, hdr.sid);
    if (!session) {
      if (!hdr.x3dh) return null;
      session = await createResponderSession(viewerId, senderId, chatId, identity, hdr, store);
    }

    const skipKey = `${hdr.dh}:${hdr.n}`;
    let messageKey: Uint8Array;
    if (session.skipped[skipKey]) {
      messageKey = from64(session.skipped[skipKey]);
      delete session.skipped[skipKey];
    } else {
      if (hdr.dh !== session.dhRecvPub) {
        await skipMessageKeys(session, hdr.pn);
        await dhRatchetStep(session, hdr.dh);
      }
      await skipMessageKeys(session, hdr.n);
      if (!session.ckRecv) return null;
      const stepped = await kdfChain(from64(session.ckRecv));
      session.ckRecv = to64(stepped.nextChainKey);
      session.nr += 1;
      messageKey = stepped.messageKey;
    }

    const aad = buildAad(chatId, senderId, recipientId, hdr);
    const ptBytes = await aesGcmDecrypt(messageKey, raw.iv, raw.ct, aad);
    const payloadStr = dec.decode(ptBytes);
    session.updatedAt = Date.now();
    await store.putSession(session);
    await store.putCachedPlaintext(viewerId, cacheKey, payloadStr, opts?.expiresAt);
    return JSON.parse(payloadStr) as SecretEnvelopePayload;
  });
}

export function isSecretBody(body: string | null | undefined): boolean {
  return Boolean(body && (body.startsWith(SECRET_PREFIX_V2) || body.startsWith(SECRET_PREFIX_V1)));
}

export async function getSecretChatInfo(
  myId: string,
  peerId: string,
  _chatId: string,
  store: SecretKeyStore = defaultStore,
  transport: SecretTransport = defaultTransport
): Promise<{
  code: string;
  emojis: string[];
  peerPublicKey: string | null;
  keyChanged: boolean;
  verified: boolean;
}> {
  const id = await ensureSecretIdentity(myId, store, transport);
  const pin = await inspectPeerPin(myId, peerId, store, transport);
  if (!pin.publicKey) {
    throw new Error("Ask your contact to open Luma once so their device publishes secret keys.");
  }
  const code = await safetyCode(myId, id.publicKey, peerId, pin.publicKey);
  const emojis = await safetyEmojis(code);
  return {
    code,
    emojis,
    peerPublicKey: pin.publicKey,
    keyChanged: pin.keyChanged,
    verified: pin.verified,
  };
}

/** Backward-compatible helper returning the formatted safety number string. */
export async function secretSecurityCode(
  myId: string,
  peerId: string,
  chatId: string,
  store: SecretKeyStore = defaultStore,
  transport: SecretTransport = defaultTransport
): Promise<string> {
  const info = await getSecretChatInfo(myId, peerId, chatId, store, transport);
  return info.code;
}

/** Convenience wrapper matching legacy UI arg order: (senderId, recipientId, chatId, text). */
export async function encryptSecretText(
  senderId: string,
  recipientId: string,
  chatId: string,
  plaintext: string,
  opts?: {
    store?: SecretKeyStore;
    transport?: SecretTransport;
    media?: SecretMediaPayload;
    expiresAt?: number;
  }
): Promise<string> {
  return encryptSecretMessage(chatId, senderId, recipientId, plaintext, opts);
}

/** Convenience wrapper matching legacy UI arg order: (viewerId, peerId, chatId, senderId, body). */
export async function decryptSecretText(
  viewerId: string,
  peerId: string,
  chatId: string,
  senderId: string,
  body: string,
  opts?: { store?: SecretKeyStore; transport?: SecretTransport; expiresAt?: number }
): Promise<string | null> {
  const env = await decryptSecretEnvelopeByViewer(viewerId, peerId, chatId, senderId, body, opts);
  return env?.text ?? null;
}

export async function decryptSecretEnvelopeByViewer(
  viewerId: string,
  peerId: string,
  chatId: string,
  senderId: string,
  body: string,
  opts?: { store?: SecretKeyStore; transport?: SecretTransport; expiresAt?: number }
): Promise<SecretEnvelopePayload | null> {
  const recipientId = senderId === viewerId ? peerId : viewerId;
  return decryptSecretEnvelope(chatId, senderId, recipientId, viewerId, body, opts);
}

/* ----------------------------------------------------- encrypted media */

export async function encryptSecretMediaFile(file: File | Blob): Promise<{
  encryptedBlob: Blob;
  mediaKey: string;
  mediaIv: string;
}> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", bs(rawKey), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const buf = await file.arrayBuffer();
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, aesKey, buf);
  return {
    encryptedBlob: new Blob([cipherBuf], { type: "application/octet-stream" }),
    mediaKey: to64(rawKey),
    mediaIv: to64(iv),
  };
}

export async function decryptSecretMediaBlob(
  encryptedBlob: Blob,
  mediaKey: string,
  mediaIv: string,
  mimeType: string
): Promise<Blob> {
  const aesKey = await crypto.subtle.importKey(
    "raw",
    bs(from64(mediaKey)),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const cipherBuf = await encryptedBlob.arrayBuffer();
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(from64(mediaIv)) },
    aesKey,
    cipherBuf
  );
  return new Blob([plainBuf], { type: mimeType || "application/octet-stream" });
}

/* ----------------------------------------------------------- v1 fallback */

async function decryptV1Text(
  chatId: string,
  senderId: string,
  recipientId: string,
  viewerId: string,
  body: string,
  store: SecretKeyStore,
  transport: SecretTransport
): Promise<string | null> {
  try {
    const peerId = senderId === viewerId ? recipientId : senderId;
    const legacy = await readLegacyV1Identity(viewerId);
    const idV2 = await store.getIdentity(viewerId);
    const priv = legacy?.privateKey ?? idV2?.privateKey;
    const remotePub = await transport.fetchLegacyPublicKey(peerId);
    if (!priv || !remotePub) return null;

    let remoteKey: CryptoKey;
    if (typeof remotePub === "object") {
      remoteKey = await crypto.subtle.importKey(
        "jwk",
        remotePub,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      );
    } else if (remotePub.trim().startsWith("{")) {
      remoteKey = await crypto.subtle.importKey(
        "jwk",
        JSON.parse(remotePub) as JsonWebKey,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      );
    } else {
      remoteKey = await importEcdhPub(remotePub);
    }

    const secret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: remoteKey }, priv, 256)
    );
    const ikm = await crypto.subtle.importKey("raw", bs(secret), "HKDF", false, ["deriveKey"]);
    const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", bs(enc.encode(`luma-chat:${chatId}`))));
    const aesKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(enc.encode("luma-secret-v1")) },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const raw = from64(body.slice(SECRET_PREFIX_V1.length));
    const aad = enc.encode(`${chatId}:${senderId}:${recipientId}`);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(raw.slice(0, 12)), additionalData: bs(aad) },
      aesKey,
      bs(raw.slice(12))
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export async function clearSecretStateForUser(
  userId: string,
  store: SecretKeyStore = defaultStore
): Promise<void> {
  await store.clearUser(userId);
}
