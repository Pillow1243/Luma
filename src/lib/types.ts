export type Profile = {
  id: string;
  display_name: string;
  avatar_path: string | null;
  created_at: string;
  username: string | null;
  bio: string;
  show_last_seen: boolean;
  last_seen_at: string | null;
  public_key: string | null;
};

export type ChatKind = "direct" | "group" | "saved" | "channel";

export type Chat = {
  id: string;
  name: string | null;
  is_group: boolean;
  created_by: string;
  created_at: string;
  avatar_path: string | null;
  is_secret: boolean;
  ttl_seconds: number | null;
  kind: ChatKind;
  description: string;
  username: string | null;
  is_public: boolean;
};

export type ChatParticipant = {
  chat_id: string;
  user_id: string;
  last_read_at: string;
  last_seen_at: string | null;
  typing_until: string | null;
  is_admin: boolean;
  muted_until: string | null;
  archived_at: string | null;
};

export type Message = {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string | null;
  reply_to: string | null;
  media_path: string | null;
  media_name: string | null;
  media_type: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  pinned_at: string | null;
  forwarded_from: string | null;
  expires_at: string | null;
  mentions: string[];
  media_duration: number | null;
  media_waveform: number[] | null;
};

export type Reaction = {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
};

/** A chat row joined with everything the sidebar needs. */
export type ChatSummary = {
  chat: Chat;
  participants: Profile[];
  lastMessage: Message | null;
  unreadCount: number;
  typing: Profile[];
  /** Viewer's own membership row flags. */
  mutedUntil: string | null;
  archivedAt: string | null;
  isAdmin: boolean;
};

export type MessageWithMeta = Message & {
  sender?: Profile;
  reactions: Reaction[];
  replyTo?: MessageWithMeta | null;
  pending?: boolean;
  failed?: boolean;
};

export type Invite = {
  token: string;
  chat_id: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number;
  uses: number;
  revoked_at: string | null;
};

export type JoinRequest = {
  chat_id: string;
  user_id: string;
  created_at: string;
  profile?: Profile;
};

export type LumaNotification = {
  id: string;
  user_id: string;
  chat_id: string | null;
  message_id: string | null;
  actor_id: string | null;
  kind: "mention" | "join_approved" | "join_rejected" | "system";
  body: string;
  read_at: string | null;
  created_at: string;
};

export type ChannelSuggestion = {
  id: string;
  name: string;
  username: string;
  description: string;
  is_public: boolean;
  avatar_path: string | null;
  subscribers: number;
  is_member: boolean;
};

export type SearchFilters = {
  term: string;
  chatId?: string | null;
  fromMe?: boolean;
  mediaOnly?: boolean;
  senderId?: string | null;
};
