import { supabase, BUCKET_AVATARS, BUCKET_MEDIA } from "./supabase";
import type {
  Chat,
  ChatParticipant,
  ChatSummary,
  ChannelSuggestion,
  Invite,
  JoinRequest,
  LumaNotification,
  Message,
  MessageWithMeta,
  Profile,
  Reaction,
  SearchFilters,
} from "./types";

/* ------------------------------- profiles -------------------------------- */

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export async function fetchProfiles(ids: string[]): Promise<Profile[]> {
  if (!ids.length) return [];
  const unique = Array.from(new Set(ids));
  const { data, error } = await supabase.from("profiles").select("*").in("id", unique);
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export async function searchProfiles(term: string, excludeId: string): Promise<Profile[]> {
  const clean = term.trim().replace(/^@/, "");
  let query = supabase.from("profiles").select("*").neq("id", excludeId).limit(24);
  if (clean) {
    query = query.or(`display_name.ilike.%${clean}%,username.ilike.%${clean}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export async function searchProfilesInChat(
  chatId: string,
  term: string,
  excludeId: string
): Promise<Profile[]> {
  const { data: rows, error } = await supabase
    .from("chat_participants")
    .select("user_id")
    .eq("chat_id", chatId);
  if (error) throw error;
  const ids = (rows ?? []).map((r) => r.user_id).filter((id) => id !== excludeId);
  if (!ids.length) return [];
  const clean = term.trim().replace(/^@/, "").toLowerCase();
  const profiles = await fetchProfiles(ids);
  if (!clean) return profiles;
  return profiles.filter(
    (p) =>
      p.display_name.toLowerCase().includes(clean) ||
      (p.username ?? "").toLowerCase().includes(clean)
  );
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<Profile, "display_name" | "avatar_path" | "username" | "bio" | "show_last_seen">>
): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as Profile;
}

/* -------------------------------- avatars -------------------------------- */

const avatarCache = new Map<string, { url: string; expires: number }>();

export async function avatarUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const hit = avatarCache.get(path);
  if (hit && hit.expires > Date.now()) return hit.url;
  const { data, error } = await supabase.storage
    .from(BUCKET_AVATARS)
    .createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  avatarCache.set(path, { url: data.signedUrl, expires: Date.now() + 45 * 60_000 });
  return data.signedUrl;
}

export async function uploadAvatar(userId: string, file: File): Promise<string> {
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${userId}/avatar-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET_AVATARS).upload(path, file, {
    cacheControl: "31536000",
    upsert: true,
    contentType: file.type || "image/png",
  });
  if (error) throw error;
  return path;
}

/** Group/channel avatars are stored in the chat_media bucket so members can read them. */
export async function chatAvatarUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  return mediaUrl(path);
}

export async function uploadChatAvatar(chatId: string, userId: string, file: File): Promise<string> {
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${chatId}/${userId}/avatar-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET_MEDIA).upload(path, file, {
    cacheControl: "31536000",
    upsert: true,
    contentType: file.type || "image/png",
  });
  if (error) throw error;
  return path;
}

/* ------------------------------- chat media ------------------------------ */

const mediaCache = new Map<string, { url: string; expires: number }>();

export async function mediaUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const hit = mediaCache.get(path);
  if (hit && hit.expires > Date.now()) return hit.url;
  const { data, error } = await supabase.storage
    .from(BUCKET_MEDIA)
    .createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  mediaCache.set(path, { url: data.signedUrl, expires: Date.now() + 45 * 60_000 });
  return data.signedUrl;
}

export async function uploadChatMedia(
  chatId: string,
  userId: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ path: string; name: string; type: string }> {
  const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${chatId}/${userId}/${Date.now()}-${safe}`;
  void onProgress; // supabase-js has no progress events; reserved for XHR backend
  const { error } = await supabase.storage.from(BUCKET_MEDIA).upload(path, file, {
    cacheControl: "31536000",
    upsert: false,
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw error;
  return { path, name: file.name, type: file.type || "application/octet-stream" };
}

const ALLOWED_MIME = new Set([
  "image/", "video/", "audio/", "application/pdf", "application/zip",
  "application/msword", "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
  "text/plain", "text/csv", "application/json",
]);

/** Cheap client-side sanity gate — the storage bucket is the enforcing boundary. */
export function validateUpload(file: File, maxBytes = 20 * 1024 * 1024): string | null {
  if (file.size > maxBytes) return `${file.name} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`;
  const ok = [...ALLOWED_MIME].some((p) => file.type.startsWith(p)) || file.type === "";
  if (!ok) return `${file.name}: that file type is not allowed`;
  return null;
}

/** Copy a stored media object into another chat (used when forwarding media). */
export async function copyMediaToChat(
  sourcePath: string,
  targetChatId: string,
  userId: string,
  suggestedName?: string
): Promise<{ path: string; name: string; type: string }> {
  const ext = sourcePath.split(".").pop()?.split("?")[0] ?? "bin";
  const safeName = (suggestedName ?? `forwarded.${ext}`).replace(/[^\w.\-]+/g, "_").slice(-80);
  const dest = `${targetChatId}/${userId}/${Date.now()}-${safeName}`;
  const { error } = await supabase.storage.from(BUCKET_MEDIA).copy(sourcePath, dest);
  if (error) throw error;
  return { path: dest, name: suggestedName ?? safeName, type: "application/octet-stream" };
}

/* --------------------------------- chats --------------------------------- */

export async function createChat(memberIds: string[], chatName?: string): Promise<string> {
  const { data, error } = await supabase.rpc("create_chat", {
    member_ids: memberIds,
    chat_name: chatName ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function createSavedChat(): Promise<string> {
  const { data, error } = await supabase.rpc("create_saved_chat");
  if (error) throw error;
  return data as string;
}

export async function createChannel(input: {
  name: string;
  username: string;
  description?: string;
  isPublic?: boolean;
}): Promise<string> {
  const { data, error } = await supabase.rpc("create_channel", {
    channel_name: input.name,
    channel_username: input.username,
    channel_description: input.description ?? "",
    channel_public: input.isPublic ?? true,
  });
  if (error) throw error;
  return data as string;
}

export async function updateChannel(
  chatId: string,
  patch: { name?: string; description?: string; username?: string; isPublic?: boolean }
): Promise<void> {
  const { error } = await supabase.rpc("update_channel", {
    cid: chatId,
    new_name: patch.name ?? null,
    new_description: patch.description ?? null,
    new_username: patch.username ?? null,
    new_public: patch.isPublic ?? null,
  });
  if (error) throw error;
}

export async function subscribeChannel(chatId: string): Promise<void> {
  const { error } = await supabase.rpc("subscribe_channel", { cid: chatId });
  if (error) throw error;
}

export async function requestJoin(chatId: string): Promise<void> {
  const { error } = await supabase.rpc("request_join", { cid: chatId });
  if (error) throw error;
}

export async function approveJoin(chatId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_join", { request_chat: chatId, request_user: userId });
  if (error) throw error;
}

export async function rejectJoin(chatId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("reject_join", { request_chat: chatId, request_user: userId });
  if (error) throw error;
}

export async function listJoinRequests(chatId: string): Promise<JoinRequest[]> {
  const { data, error } = await supabase
    .from("join_requests")
    .select("chat_id,user_id,created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as JoinRequest[];
  const profiles = await fetchProfiles(rows.map((r) => r.user_id));
  const map = new Map(profiles.map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, profile: map.get(r.user_id) }));
}

export async function searchChannels(term: string): Promise<ChannelSuggestion[]> {
  const { data, error } = await supabase.rpc("search_channels", { term });
  if (error) throw error;
  return (data ?? []) as ChannelSuggestion[];
}

export async function channelSubscriberCount(chatId: string): Promise<number> {
  const { data, error } = await supabase.rpc("channel_subscriber_count", { cid: chatId });
  if (error) return 0;
  return (data ?? 0) as number;
}

export async function leaveChat(chatId: string): Promise<void> {
  const { error } = await supabase.rpc("leave_chat", { cid: chatId });
  if (error) throw error;
}

export async function addChatMember(chatId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("add_chat_member", { cid: chatId, new_member: userId });
  if (error) throw error;
}

export async function removeChatMember(chatId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_chat_member", { cid: chatId, target: userId });
  if (error) throw error;
}

export async function setGroupAdmin(chatId: string, userId: string, makeAdmin: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_group_admin", { cid: chatId, target: userId, make_admin: makeAdmin });
  if (error) throw error;
}

export async function updateGroup(chatId: string, name?: string, avatarPath?: string): Promise<void> {
  const { error } = await supabase.rpc("update_group", {
    cid: chatId,
    new_name: name ?? null,
    new_avatar_path: avatarPath ?? null,
  });
  if (error) throw error;
}

export async function setChatTtl(chatId: string, ttlSeconds: number | null): Promise<void> {
  const { error } = await supabase.rpc("set_chat_ttl", { cid: chatId, ttl_seconds: ttlSeconds ?? 0 });
  if (error) throw error;
}

/* ------------------------------ invite links ----------------------------- */

export async function createInvite(
  chatId: string,
  opts: { ttlSeconds?: number; maxUses?: number } = {}
): Promise<Invite> {
  const { data, error } = await supabase.rpc("create_invite", {
    cid: chatId,
    ttl_seconds: opts.ttlSeconds ?? 86400,
    max_uses: opts.maxUses ?? 50,
  });
  if (error) throw error;
  return data as Invite;
}

export async function listInvites(chatId: string): Promise<Invite[]> {
  const { data, error } = await supabase
    .from("chat_invites")
    .select("*")
    .eq("chat_id", chatId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Invite[];
}

export async function revokeInvite(token: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_invite", { invite_token: token });
  if (error) throw error;
}

export async function redeemInvite(token: string): Promise<string> {
  const { data, error } = await supabase.rpc("redeem_invite", { invite_token: token });
  if (error) throw error;
  return data as string;
}

/* ---------------------------- block / report ----------------------------- */

export async function blockUser(blocker: string, blocked: string): Promise<void> {
  const { error } = await supabase.from("blocks").upsert({ blocker, blocked }, { onConflict: "blocker,blocked" });
  if (error) throw error;
}

export async function unblockUser(blocker: string, blocked: string): Promise<void> {
  const { error } = await supabase.from("blocks").delete().eq("blocker", blocker).eq("blocked", blocked);
  if (error) throw error;
}

export async function listBlockedIds(blocker: string): Promise<string[]> {
  const { data, error } = await supabase.from("blocks").select("blocked").eq("blocker", blocker);
  if (error) throw error;
  return (data ?? []).map((r) => r.blocked as string);
}

export async function reportMessage(input: {
  chatId: string;
  messageId?: string | null;
  reporter: string;
  reason: string;
  details?: string;
}): Promise<void> {
  const { error } = await supabase.from("message_reports").insert({
    chat_id: input.chatId,
    message_id: input.messageId ?? null,
    reporter: input.reporter,
    reason: input.reason,
    details: input.details ?? "",
  });
  if (error) throw error;
}

/* --------------------------- mute / archive / star ----------------------- */

async function setParticipantFlag(
  chatId: string,
  userId: string,
  patch: Partial<Pick<ChatParticipant, "muted_until" | "archived_at">>
): Promise<void> {
  const { error } = await supabase
    .from("chat_participants")
    .update(patch)
    .eq("chat_id", chatId)
    .eq("user_id", userId);
  if (error) throw error;
}

export const muteChat = (chatId: string, userId: string, until: Date | null) =>
  setParticipantFlag(chatId, userId, { muted_until: until ? until.toISOString() : null });
export const archiveChat = (chatId: string, userId: string, archived: boolean) =>
  setParticipantFlag(chatId, userId, { archived_at: archived ? new Date().toISOString() : null });

export async function starMessage(userId: string, messageId: string): Promise<void> {
  const { error } = await supabase
    .from("starred_messages")
    .upsert({ user_id: userId, message_id: messageId }, { onConflict: "user_id,message_id" });
  if (error) throw error;
}

export async function unstarMessage(userId: string, messageId: string): Promise<void> {
  const { error } = await supabase
    .from("starred_messages")
    .delete()
    .eq("user_id", userId)
    .eq("message_id", messageId);
  if (error) throw error;
}

export async function listStarredIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase.from("starred_messages").select("message_id").eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((r) => r.message_id as string);
}

export async function loadStarredMessages(userId: string): Promise<MessageWithMeta[]> {
  const { data, error } = await supabase
    .from("starred_messages")
    .select("created_at, message:messages(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as { message: Message | Message[] | null }[])
    .map((r) => (Array.isArray(r.message) ? r.message[0] : r.message))
    .filter((m): m is Message => Boolean(m));
  return hydrateMessages(rows);
}

/** Every chat the signed-in user belongs to, fully hydrated for the sidebar. */
export async function loadChats(userId: string): Promise<ChatSummary[]> {
  const { data: memberships, error: mErr } = await supabase
    .from("chat_participants")
    .select("*")
    .eq("user_id", userId);
  if (mErr) throw mErr;
  const myChats = (memberships ?? []) as ChatParticipant[];
  if (!myChats.length) return [];

  const chatIds = myChats.map((m) => m.chat_id);
  const membershipMap = new Map(myChats.map((m) => [m.chat_id, m]));

  const [{ data: chats, error: cErr }, { data: parts, error: pErr }] = await Promise.all([
    supabase.from("chats").select("*").in("id", chatIds),
    supabase.from("chat_participants").select("*").in("chat_id", chatIds),
  ]);
  if (cErr) throw cErr;
  if (pErr) throw pErr;

  const participantRows = (parts ?? []) as ChatParticipant[];
  const profileIds = Array.from(new Set(participantRows.map((p) => p.user_id)));
  const profiles = await fetchProfiles(profileIds);
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  // Latest message per chat — one bounded query, split client-side.
  const { data: msgs, error: msgErr } = await supabase
    .from("messages")
    .select("*")
    .in("chat_id", chatIds)
    .order("created_at", { ascending: false })
    .limit(Math.min(600, Math.max(150, chatIds.length * 30)));
  if (msgErr) throw msgErr;
  const messages = (msgs ?? []) as Message[];

  const byChat = new Map<string, Message[]>();
  for (const m of messages) {
    const arr = byChat.get(m.chat_id);
    if (arr) arr.push(m);
    else byChat.set(m.chat_id, [m]);
  }

  const now = Date.now();
  const summaries: ChatSummary[] = (chats ?? []).map((chat: Chat) => {
    const chatMsgs = byChat.get(chat.id) ?? [];
    const me = membershipMap.get(chat.id);
    const lastRead = new Date(me?.last_read_at ?? 0).getTime();
    const members = participantRows
      .filter((p) => p.chat_id === chat.id)
      .map((p) => profileMap.get(p.user_id))
      .filter((p): p is Profile => Boolean(p));
    const typing = participantRows
      .filter(
        (p) =>
          p.chat_id === chat.id &&
          p.user_id !== userId &&
          p.typing_until &&
          new Date(p.typing_until).getTime() > now
      )
      .map((p) => profileMap.get(p.user_id))
      .filter((p): p is Profile => Boolean(p));
    return {
      chat,
      participants: members,
      lastMessage: chatMsgs[0] ?? null,
      unreadCount: chatMsgs.filter(
        (m) => m.sender_id !== userId && new Date(m.created_at).getTime() > lastRead
      ).length,
      typing,
      mutedUntil: me?.muted_until ?? null,
      archivedAt: me?.archived_at ?? null,
      isAdmin: Boolean(me?.is_admin) || chat.created_by === userId,
    };
  });

  summaries.sort((a, b) => {
    // Saved Messages always first.
    if (a.chat.kind === "saved") return -1;
    if (b.chat.kind === "saved") return 1;
    const at = a.lastMessage?.created_at ?? a.chat.created_at;
    const bt = b.lastMessage?.created_at ?? b.chat.created_at;
    return new Date(bt).getTime() - new Date(at).getTime();
  });
  return summaries;
}

export async function getChat(chatId: string): Promise<Chat | null> {
  const { data, error } = await supabase.from("chats").select("*").eq("id", chatId).maybeSingle();
  if (error) throw error;
  return data as Chat | null;
}

export async function getChatParticipants(chatId: string): Promise<ChatParticipant[]> {
  const { data, error } = await supabase
    .from("chat_participants")
    .select("*")
    .eq("chat_id", chatId);
  if (error) throw error;
  return (data ?? []) as ChatParticipant[];
}

export async function getMyParticipant(chatId: string, userId: string): Promise<ChatParticipant | null> {
  const { data, error } = await supabase
    .from("chat_participants")
    .select("*")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ChatParticipant | null) ?? null;
}

/* -------------------------------- messages ------------------------------- */

export async function loadMessages(
  chatId: string,
  opts: { limit?: number; before?: string | null } = {}
): Promise<MessageWithMeta[]> {
  const limit = opts.limit ?? 80;
  let query = supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.before) query = query.lt("created_at", opts.before);
  const { data, error } = await query;
  if (error) throw error;
  const rows = ((data ?? []) as Message[]).slice().reverse();
  return hydrateMessages(rows);
}

export async function hydrateMessages(rows: Message[]): Promise<MessageWithMeta[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const senderIds = Array.from(new Set(rows.map((r) => r.sender_id)));
  const replyIds = Array.from(new Set(rows.map((r) => r.reply_to).filter((x): x is string => Boolean(x))));

  const [{ data: reactions }, profiles, { data: replyRows }] = await Promise.all([
    supabase.from("message_reactions").select("*").in("message_id", ids),
    fetchProfiles(senderIds),
    replyIds.length
      ? supabase.from("messages").select("*").in("id", replyIds)
      : Promise.resolve({ data: [] as Message[] }),
  ]);

  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const reactionMap = new Map<string, Reaction[]>();
  for (const r of (reactions ?? []) as Reaction[]) {
    const arr = reactionMap.get(r.message_id);
    if (arr) arr.push(r);
    else reactionMap.set(r.message_id, [r]);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of (replyRows ?? []) as Message[]) byId.set(r.id, r);

  return rows.map((m) => {
    const replyTarget = m.reply_to ? byId.get(m.reply_to) : null;
    return {
      ...m,
      sender: profileMap.get(m.sender_id),
      reactions: reactionMap.get(m.id) ?? [],
      replyTo: replyTarget
        ? ({ ...replyTarget, reactions: [], sender: profileMap.get(replyTarget.sender_id) } as MessageWithMeta)
        : null,
    };
  });
}

export async function sendMessage(input: {
  chatId: string;
  senderId: string;
  body?: string;
  media?: { path: string; name: string; type: string } | null;
  replyTo?: string | null;
  mentions?: string[];
  forwardedFrom?: string | null;
  mediaDuration?: number | null;
  mediaWaveform?: number[] | null;
  expiresAt?: string | null;
}): Promise<Message> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      chat_id: input.chatId,
      sender_id: input.senderId,
      body: input.body?.trim() ? input.body.trim() : null,
      media_path: input.media?.path ?? null,
      media_name: input.media?.name ?? null,
      media_type: input.media?.type ?? null,
      reply_to: input.replyTo ?? null,
      mentions: input.mentions ?? [],
      forwarded_from: input.forwardedFrom ?? null,
      media_duration: input.mediaDuration ?? null,
      media_waveform: input.mediaWaveform ?? null,
      expires_at: input.expiresAt ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Message;
}

export async function editMessage(id: string, newBody: string): Promise<Message> {
  const { data, error } = await supabase.rpc("edit_message", { msg_id: id, new_body: newBody });
  if (error) throw error;
  return data as Message;
}

export async function deleteMessageForEveryone(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_message_for_everyone", { msg_id: id });
  if (error) throw error;
}

export async function deleteMessageForMe(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_message_for_me", { msg_id: id });
  if (error) throw error;
}

export async function setMessagePinned(id: string, pin: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_message_pinned", { msg_id: id, pin });
  if (error) throw error;
}

export async function listPinnedMessages(chatId: string): Promise<MessageWithMeta[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .not("pinned_at", "is", null)
    .order("pinned_at", { ascending: false });
  if (error) throw error;
  return hydrateMessages((data ?? []) as Message[]);
}

export async function searchMessages(filters: SearchFilters): Promise<MessageWithMeta[]> {
  let query = supabase
    .from("messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(40);
  const term = filters.term.trim();
  if (term) query = query.ilike("body", `%${term}%`);
  if (filters.chatId) query = query.eq("chat_id", filters.chatId);
  if (filters.fromMe && filters.senderId) query = query.eq("sender_id", filters.senderId);
  else if (filters.senderId) query = query.eq("sender_id", filters.senderId);
  if (filters.mediaOnly) query = query.not("media_path", "is", null);
  const { data, error } = await query;
  if (error) throw error;
  return hydrateMessages((data ?? []) as Message[]);
}

/* ------------------------------- reactions ------------------------------- */

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<void> {
  const { data: existing, error: findErr } = await supabase
    .from("message_reactions")
    .select("message_id")
    .eq("message_id", messageId)
    .eq("user_id", userId)
    .eq("emoji", emoji)
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    const { error } = await supabase
      .from("message_reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", userId)
      .eq("emoji", emoji);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from("message_reactions")
    .insert({ message_id: messageId, user_id: userId, emoji });
  if (error) throw error;
}

/* -------------------------- read / presence / typing --------------------- */

export async function markRead(chatId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("chat_participants")
    .update({ last_read_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", userId);
  if (error) throw error;
}

let lastProfileBeat = 0;

export async function setTyping(chatId: string, userId: string, isTyping: boolean): Promise<void> {
  const until = new Date(Date.now() + (isTyping ? 5000 : 0)).toISOString();
  const { error } = await supabase
    .from("chat_participants")
    .update({ typing_until: until })
    .eq("chat_id", chatId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function heartbeat(chatId: string, userId: string): Promise<void> {
  await supabase
    .from("chat_participants")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .eq("user_id", userId);
}

/** Throttled profile-level presence (once per 45s) so DMs show online/last seen. */
export async function profileHeartbeat(userId: string): Promise<void> {
  const now = Date.now();
  if (now - lastProfileBeat < 45_000) return;
  lastProfileBeat = now;
  await supabase.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", userId);
}

/* ------------------------------ notifications ---------------------------- */

export async function fetchNotifications(userId: string, limit = 20): Promise<LumaNotification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LumaNotification[];
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

export async function markNotificationsRead(): Promise<void> {
  const { error } = await supabase.rpc("mark_notifications_read");
  if (error) throw error;
}

/* --------------------------- chat name / helpers ------------------------- */

export function chatTitle(summary: ChatSummary, meId: string): string {
  if (summary.chat.kind === "saved") return "Saved Messages";
  if (summary.chat.kind === "channel") return summary.chat.name || "Channel";
  if (summary.chat.is_group) return summary.chat.name || "Group chat";
  const other = summary.participants.find((p) => p.id !== meId);
  return other?.display_name ?? "Direct message";
}

export function chatAvatarProfile(
  summary: ChatSummary,
  meId: string
): Profile | null {
  if (summary.chat.is_group || summary.chat.kind === "channel" || summary.chat.kind === "saved") return null;
  return summary.participants.find((p) => p.id !== meId) ?? null;
}
