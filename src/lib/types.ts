export type ProfileVisibility = "public" | "contacts" | "private";

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
  show_online_status?: boolean;
  show_read_receipts?: boolean;
  show_typing?: boolean;
  profile_visibility?: ProfileVisibility;
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
  slow_mode_seconds?: number;
  member_limit?: number;
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
  failureReason?: string;
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

export type CallRecord = {
  id: string; chat_id: string; started_by: string; kind: "audio" | "video";
  status: "ringing" | "active" | "ended"; created_at: string;
  answered_at: string | null; ended_at: string | null;
};
export type CallParticipant = {
  call_id: string; user_id: string; status: "ringing" | "joined" | "declined" | "left" | "missed";
  joined_at: string | null; left_at: string | null;
};
export type CallSignal = {
  id: string; call_id: string; from_user: string; to_user: string;
  kind: "offer" | "answer" | "ice"; payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

export type ScheduledMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string | null;
  reply_to: string | null;
  media_path: string | null;
  media_name: string | null;
  media_type: string | null;
  mentions: string[];
  scheduled_at: string;
  created_at: string;
};

export type MessageDraft = {
  user_id: string;
  chat_id: string;
  body: string;
  reply_to: string | null;
  updated_at: string;
};

export type AuditAction =
  | "member_added" | "member_removed" | "admin_granted" | "admin_revoked"
  | "invite_created" | "invite_revoked" | "slow_mode_changed" | "member_limit_changed"
  | "chat_updated" | "join_approved" | "join_rejected" | "message_deleted" | "bot_message";

export type ChatAuditEntry = {
  id: string;
  chat_id: string;
  actor_id: string | null;
  action: AuditAction;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
  actor?: Profile | null;
};

export type UserSession = {
  id: string;
  user_id: string;
  device_name: string;
  user_agent: string;
  ip_hash: string | null;
  last_seen_at: string;
  created_at: string;
  revoked_at: string | null;
};

export type Bot = {
  id: string;
  owner_id: string;
  name: string;
  username: string;
  description: string;
  webhook_url: string | null;
  is_active: boolean;
  created_at: string;
};

export type BotTokenMeta = {
  id: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type LinkPreview = {
  url: string;
  title: string;
  description: string;
  imageUrl: string | null;
  cached: boolean;
};

export type ChatAnalytics = {
  messages_total: number;
  messages_7d: number;
  members: number;
  media_total: number;
};
