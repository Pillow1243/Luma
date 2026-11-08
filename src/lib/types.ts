export type Profile = {
  id: string;
  display_name: string;
  avatar_path: string | null;
  created_at: string;
};

export type Chat = {
  id: string;
  name: string | null;
  is_group: boolean;
  created_by: string;
  created_at: string;
};

export type ChatParticipant = {
  chat_id: string;
  user_id: string;
  last_read_at: string;
  last_seen_at: string | null;
  typing_until: string | null;
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
};

export type MessageWithMeta = Message & {
  sender?: Profile;
  reactions: Reaction[];
  replyTo?: MessageWithMeta | null;
  pending?: boolean;
  failed?: boolean;
};
