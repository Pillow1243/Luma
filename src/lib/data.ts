import { supabase, BUCKET_AVATARS, BUCKET_MEDIA } from "./supabase";
import type {
  Chat,
  ChatParticipant,
  ChatSummary,
  Message,
  MessageWithMeta,
  Profile,
  Reaction,
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
  const { data, error } = await supabase.from("profiles").select("*").in("id", ids);
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export async function searchProfiles(term: string, excludeId: string): Promise<Profile[]> {
  const clean = term.trim();
  let query = supabase.from("profiles").select("*").neq("id", excludeId).limit(24);
  if (clean) query = query.ilike("display_name", `%${clean}%`);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Profile[];
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<Profile, "display_name" | "avatar_path">>
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

/** Signed avatar URL (private bucket), cached for 45 minutes. */
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
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `${userId}/avatar-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET_AVATARS).upload(path, file, {
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
  file: File
): Promise<{ path: string; name: string; type: string }> {
  const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${chatId}/${userId}/${Date.now()}-${safe}`;
  const { error } = await supabase.storage.from(BUCKET_MEDIA).upload(path, file, {
    cacheControl: "31536000",
    upsert: false,
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw error;
  return { path, name: file.name, type: file.type || "application/octet-stream" };
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
  const readMap = new Map(myChats.map((m) => [m.chat_id, m.last_read_at]));

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

  // Latest message + unread count per chat. One query, filtered client-side —
  // bounded by the number of chats the user is actually in.
  const { data: msgs, error: msgErr } = await supabase
    .from("messages")
    .select("*")
    .in("chat_id", chatIds)
    .order("created_at", { ascending: false })
    .limit(600);
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
    const lastRead = new Date(readMap.get(chat.id) ?? 0).getTime();
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
    };
  });

  summaries.sort((a, b) => {
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

/* -------------------------------- messages ------------------------------- */

export async function loadMessages(chatId: string, limit = 120): Promise<MessageWithMeta[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = ((data ?? []) as Message[]).slice().reverse();
  return hydrateMessages(rows);
}

export async function hydrateMessages(rows: Message[]): Promise<MessageWithMeta[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const senderIds = Array.from(new Set(rows.map((r) => r.sender_id)));

  const [{ data: reactions }, profiles] = await Promise.all([
    supabase.from("message_reactions").select("*").in("message_id", ids),
    fetchProfiles(senderIds),
  ]);

  const profileMap = new Map(profiles.map((p) => [p.id, p]));
  const reactionMap = new Map<string, Reaction[]>();
  for (const r of (reactions ?? []) as Reaction[]) {
    const arr = reactionMap.get(r.message_id);
    if (arr) arr.push(r);
    else reactionMap.set(r.message_id, [r]);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));

  return rows.map((m) => ({
    ...m,
    sender: profileMap.get(m.sender_id),
    reactions: reactionMap.get(m.id) ?? [],
    replyTo: m.reply_to
      ? ({
          ...(byId.get(m.reply_to) as Message),
          reactions: [],
        } as MessageWithMeta)
      : null,
  }));
}

export async function sendMessage(input: {
  chatId: string;
  senderId: string;
  body?: string;
  media?: { path: string; name: string; type: string } | null;
  replyTo?: string | null;
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
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Message;
}

export async function deleteMessage(id: string): Promise<void> {
  const { error } = await supabase.from("messages").delete().eq("id", id);
  if (error) throw error;
}

/* ------------------------------- reactions ------------------------------- */

export async function toggleReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<void> {
  const { data: existing, error: findErr } = await supabase
    .from("message_reactions")
    .select("*")
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

/* --------------------------- chat name / helpers ------------------------- */

export function chatTitle(summary: ChatSummary, meId: string): string {
  if (summary.chat.is_group) return summary.chat.name || "Group chat";
  const other = summary.participants.find((p) => p.id !== meId);
  return other?.display_name ?? "Direct message";
}

export function chatAvatarProfile(
  summary: ChatSummary,
  meId: string
): Profile | null {
  if (summary.chat.is_group) return null;
  return summary.participants.find((p) => p.id !== meId) ?? null;
}
