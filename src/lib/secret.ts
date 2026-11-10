import { offlineDB } from "./offline";
import { supabase } from "./supabase";

// Experimental opt-in secret text. Not a Signal protocol implementation: no
// ratchet, forward secrecy, multi-device recovery, or encrypted attachments.
export const SECRET_PREFIX = "luma:e2ee:v1:";
export const isSecretBody = (body: string | null | undefined) => Boolean(body?.startsWith(SECRET_PREFIX));
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sameKey = (a: JsonWebKey, b: JsonWebKey) => a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;
const to64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (v) => String.fromCharCode(v)).join(""));
const from64 = (value: string) => Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

async function serverKey(userId: string): Promise<JsonWebKey | null> {
  const { data, error } = await supabase.from("user_public_keys").select("public_key").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data?.public_key as JsonWebKey | undefined) ?? null;
}

async function ensureIdentityUnlocked(userId: string) {
  if (!globalThis.crypto?.subtle) throw new Error("Secret messages require a secure browser with Web Crypto.");
  const db = await offlineDB();
  let local = await db.get("keys", userId);
  if (!navigator.onLine) {
    if (!local) throw new Error("Set up secret messages online on this device first.");
    return local;
  }
  let remote: JsonWebKey | null;
  try { remote = await serverKey(userId); }
  catch (error) { if (local) return local; throw error; }
  if (!local && remote) throw new Error("Your secret key is on another device. Secret messages cannot be recovered here.");
  if (local && remote && !sameKey(local.publicKey, remote)) throw new Error("Your secret identity changed. Sending is blocked on this device.");
  if (!local) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    local = { userId, privateKey: pair.privateKey, publicKey };
    await db.put("keys", local);
  }
  if (!remote) {
    const { error } = await supabase.from("user_public_keys").insert({ user_id: userId, public_key: local.publicKey });
    if (error) {
      // Another tab/device may have registered while we were generating.
      const now = await serverKey(userId);
      if (!now || !sameKey(now, local.publicKey)) throw new Error("Another device registered a different secret key. Sending is blocked.");
    }
  }
  return local;
}
const identities = new Map<string, { expires: number; value: ReturnType<typeof ensureIdentityUnlocked> }>();
const peers = new Map<string, { expires: number; value: Promise<JsonWebKey> }>();
export async function ensureSecretIdentity(userId: string) {
  const cacheKey = `${userId}:${navigator.onLine}`;
  const cached = identities.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value: ReturnType<typeof ensureIdentityUnlocked> = (async () => {
    if (navigator.locks) return await navigator.locks.request(`luma-secret-identity:${userId}`, async () => await ensureIdentityUnlocked(userId));
    return await ensureIdentityUnlocked(userId);
  })();
  identities.set(cacheKey, { expires: Date.now() + 60_000, value });
  value.catch(() => identities.delete(cacheKey));
  return value;
}
async function readPeerKey(owner: string, peer: string): Promise<JsonWebKey> {
  const db = await offlineDB();
  const key = `${owner}:${peer}`;
  const cached = await db.get("peerKeys", key);
  if (!navigator.onLine) {
    if (!cached) throw new Error("Connect once to establish your contact's secret key.");
    return cached.publicKey;
  }
  let remote: JsonWebKey | null;
  try { remote = await serverKey(peer); }
  catch (error) { if (cached) return cached.publicKey; throw error; }
  if (!remote) throw new Error("Your contact must open Luma on their device before you can use secret messages.");
  if (cached && !sameKey(cached.publicKey, remote)) throw new Error("Your contact's security key changed. Secret sending is blocked; verify their identity.");
  if (!cached) await db.put("peerKeys", { key, publicKey: remote });
  return remote;
}
async function peerKey(owner: string, peer: string): Promise<JsonWebKey> {
  const key = `${owner}:${peer}:${navigator.onLine}`;
  const cached = peers.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = readPeerKey(owner, peer);
  peers.set(key, { expires: Date.now() + 60_000, value });
  value.catch(() => peers.delete(key));
  return value;
}
async function sharedKey(owner: string, peer: string, chatId: string) {
  const identity = await ensureSecretIdentity(owner);
  const other = await peerKey(owner, peer);
  const publicKey = await crypto.subtle.importKey("jwk", other, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, identity.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = await crypto.subtle.digest("SHA-256", encoder.encode(`luma-chat:${chatId}`));
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("luma-secret-text-v1") }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function aad(chatId: string, sender: string, recipient: string) {
  return encoder.encode(`luma:e2ee:v1|${chatId}|${sender}|${recipient}`);
}
export async function encryptSecretText(owner: string, peer: string, chatId: string, text: string) {
  const key = await sharedKey(owner, peer, chatId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(chatId, owner, peer) }, key, encoder.encode(text));
  const result = `${SECRET_PREFIX}${to64(iv)}:${to64(new Uint8Array(encrypted))}`;
  if (result.length > 5000) throw new Error("Secret message is too long. Try a shorter message.");
  return result;
}
export async function decryptSecretText(owner: string, peer: string, chatId: string, sender: string, body: string) {
  if (!isSecretBody(body) || (sender !== owner && sender !== peer)) throw new Error("Invalid secret message");
  const [encodedIv, encodedCipher, extra] = body.slice(SECRET_PREFIX.length).split(":");
  if (!encodedIv || !encodedCipher || extra) throw new Error("Invalid secret message");
  const iv = from64(encodedIv);
  if (iv.length !== 12) throw new Error("Invalid secret message");
  const key = await sharedKey(owner, peer, chatId);
  const recipient = sender === owner ? peer : owner;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(chatId, sender, recipient) }, key, from64(encodedCipher));
  return decoder.decode(plain);
}
export async function secretSecurityCode(owner: string, peer: string, chatId: string) {
  const own = (await ensureSecretIdentity(owner)).publicKey;
  const other = await peerKey(owner, peer);
  const keys = [{ id: owner, x: own.x, y: own.y }, { id: peer, x: other.x, y: other.y }].sort((a, b) => a.id.localeCompare(b.id));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify({ chatId, keys }))));
  return Array.from(digest.slice(0, 16), (v) => v.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{4}/g)?.join(" ") ?? "";
}
