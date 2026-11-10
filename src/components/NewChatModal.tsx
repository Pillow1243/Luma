import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  Compass,
  Globe,
  Hash,
  Loader2,
  Lock,
  Megaphone,
  MessageCircle,
  Search,
  Users,
  AtSign,
} from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import {
  searchProfiles,
  searchChannels,
  subscribeChannel,
  createChat,
  createChannel,
} from "../lib/data";
import type { ChannelSuggestion, Profile } from "../lib/types";
import { useToast } from "../context/ToastContext";
import { useI18n } from "../lib/i18n";

type Tab = "direct" | "group" | "channel" | "discover";

export function NewChatModal({
  open,
  onClose,
  meId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  meId: string;
  onCreated: (chatId: string) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("direct");
  const [term, setTerm] = useState("");
  const [people, setPeople] = useState<Profile[]>([]);
  const [channels, setChannels] = useState<ChannelSuggestion[]>([]);
  const [selected, setSelected] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [channelName, setChannelName] = useState("");
  const [channelHandle, setChannelHandle] = useState("");
  const [channelDesc, setChannelDesc] = useState("");
  const [channelPublic, setChannelPublic] = useState(true);
  const toast = useToast();

  useEffect(() => {
    if (!open || (tab !== "direct" && tab !== "group")) return;
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchProfiles(term, meId)
        .then((rows) => alive && setPeople(rows))
        .catch(() => alive && setPeople([]))
        .finally(() => alive && setLoading(false));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [term, open, meId, tab]);

  useEffect(() => {
    if (!open || tab !== "discover") return;
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      searchChannels(term.trim().replace(/^@/, ""))
        .then((rows) => alive && setChannels(rows))
        .catch(() => alive && setChannels([]))
        .finally(() => alive && setLoading(false));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [term, open, tab]);

  useEffect(() => {
    if (!open) {
      setSelected([]);
      setTerm("");
      setGroupName("");
      setTab("direct");
      setChannelName("");
      setChannelHandle("");
      setChannelDesc("");
      setChannelPublic(true);
    }
  }, [open]);

  const isGroup = tab === "group";
  const canCreateDirect = tab === "direct" && selected.length === 1;
  const canCreateGroup = isGroup && selected.length >= 2 && groupName.trim().length > 0;
  const handleValid = /^[a-z0-9_]{3,32}$/.test(channelHandle);
  const canCreateChannel = tab === "channel" && channelName.trim().length >= 2 && handleValid;

  const sorted = useMemo(
    () =>
      [...people].sort((a, b) => {
        const sa = selected.some((s) => s.id === a.id) ? 0 : 1;
        const sb = selected.some((s) => s.id === b.id) ? 0 : 1;
        return sa - sb || a.display_name.localeCompare(b.display_name);
      }),
    [people, selected]
  );

  function toggle(p: Profile) {
    setSelected((s) => {
      if (tab === "direct") return s.some((x) => x.id === p.id) ? [] : [p];
      return s.some((x) => x.id === p.id) ? s.filter((x) => x.id !== p.id) : [...s, p];
    });
  }

  async function joinPublicChannel(c: ChannelSuggestion) {
    if (c.is_member) {
      onCreated(c.id);
      onClose();
      return;
    }
    setJoiningId(c.id);
    try {
      await subscribeChannel(c.id);
      toast.push(`Subscribed to ${c.name}`, "success");
      onCreated(c.id);
      onClose();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not subscribe", "error");
    } finally {
      setJoiningId(null);
    }
  }

  async function create() {
    setCreating(true);
    try {
      if (tab === "channel") {
        const id = await createChannel({
          name: channelName.trim(),
          username: channelHandle,
          description: channelDesc.trim() || undefined,
          isPublic: channelPublic,
        });
        toast.push("Channel created", "success");
        onCreated(id);
        onClose();
        return;
      }
      const id = await createChat(
        selected.map((p) => p.id),
        isGroup ? groupName.trim() : undefined
      );
      toast.push(isGroup ? "Group created" : "Conversation started", "success");
      onCreated(id);
      onClose();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not create", "error");
    } finally {
      setCreating(false);
    }
  }

  const footerLabel =
    tab === "channel" ? "Create channel" : tab === "group" ? "Create group" : "Start chat";
  const canCreate = canCreateDirect || canCreateGroup || canCreateChannel;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("newChat")}
      subtitle="Start a direct message, create a group, or explore public channels."
      maxWidth="max-w-lg"
      footer={
        tab !== "discover" ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-slate-500">
              {tab === "channel"
                ? channelPublic
                  ? "Public · anyone can subscribe"
                  : "Private · invite link or request"
                : `${selected.length} selected${isGroup ? " · group" : ""}`}
            </span>
            <button onClick={create} disabled={!canCreate || creating} className="btn-primary px-5">
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : tab === "channel" ? (
                <Megaphone className="h-4 w-4" />
              ) : (
                <Users className="h-4 w-4" />
              )}
              {footerLabel}
            </button>
          </div>
        ) : undefined
      }
    >
      {/* tabs */}
      <div className="mb-4 grid grid-cols-4 gap-1 rounded-2xl border border-white/10 bg-white/[0.04] p-1">
        {(
          [
            { id: "direct", label: "Direct", icon: MessageCircle },
            { id: "group", label: "Group", icon: Users },
            { id: "channel", label: "Channel", icon: Megaphone },
            { id: "discover", label: "Discover", icon: Compass },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setTab(item.id);
              setSelected([]);
            }}
            role="tab"
            aria-selected={tab === item.id}
            className={`flex items-center justify-center gap-1 rounded-xl px-2 py-2 text-[12px] font-medium transition-all ${
              tab === item.id
                ? "bg-luma-gradient text-white shadow-bubble"
                : "text-slate-400 hover:text-slate-100"
            }`}
          >
            <item.icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>

      {tab === "discover" ? (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              className="field ps-11"
              placeholder="Search public channels by name or @handle…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pe-1 no-scrollbar">
            {loading && (
              <div className="flex items-center justify-center py-8 text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!loading && channels.length === 0 && (
              <p className="py-8 text-center text-[13px] text-slate-500">
                No public channels matched. Create one from the Channel tab!
              </p>
            )}
            {channels.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5"
              >
                <Avatar
                  label={c.name}
                  group
                  chatAvatarPath={c.avatar_path}
                  size={42}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[14px] font-medium text-white">
                    <Hash className="h-3.5 w-3.5 shrink-0 text-luma-300" />
                    <span className="truncate">{c.name}</span>
                  </div>
                  <div className="truncate text-[11px] text-slate-400">
                    @{c.username} · {c.subscribers} subscriber{c.subscribers === 1 ? "" : "s"}
                    {c.description ? ` · ${c.description}` : ""}
                  </div>
                </div>
                <button
                  onClick={() => void joinPublicChannel(c)}
                  disabled={joiningId === c.id}
                  className={c.is_member ? "btn-ghost px-3 py-1.5 text-[12px]" : "btn-primary px-3 py-1.5 text-[12px]"}
                >
                  {joiningId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : c.is_member ? (
                    "Open"
                  ) : (
                    t("joinChannel")
                  )}
                </button>
              </div>
            ))}
          </div>
        </>
      ) : tab !== "channel" ? (
        <>
          {isGroup && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="mb-3">
              <label className="label" htmlFor="group-name">Group name</label>
              <input
                id="group-name"
                className="field"
                placeholder="e.g. Weekend plans"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={80}
              />
            </motion.div>
          )}

          <div className="relative mb-3">
            <Search className="pointer-events-none absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              className="field ps-11"
              placeholder={
                tab === "direct"
                  ? "Search people by name or @username…"
                  : "Search people to add…"
              }
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              autoFocus
            />
          </div>

          {selected.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {selected.map((p) => (
                <button
                  key={p.id}
                  onClick={() => toggle(p)}
                  className="chip hover:border-rose-400/40 hover:text-rose-200"
                >
                  {p.display_name}
                  <Check className="h-3 w-3" />
                </button>
              ))}
            </div>
          )}

          <div className="max-h-[42vh] space-y-1 overflow-y-auto pe-1 no-scrollbar">
            {loading && (
              <div className="flex items-center justify-center py-8 text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!loading && sorted.length === 0 && (
              <p className="py-8 text-center text-[13px] text-slate-500">
                No people found. Invite a friend to sign up, then search again.
              </p>
            )}
            {sorted.map((p) => {
              const isSel = selected.some((s) => s.id === p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => toggle(p)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-start transition-colors ${
                    isSel ? "bg-luma-500/15" : "hover:bg-white/[0.06]"
                  }`}
                >
                  <Avatar profile={p} size={40} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-slate-200">
                      {p.display_name}
                    </span>
                    {p.username && (
                      <span className="block text-[11px] text-slate-500">@{p.username}</span>
                    )}
                  </span>
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-full border transition-colors ${
                      isSel
                        ? "border-luma-400 bg-luma-500 text-white"
                        : "border-white/20 text-transparent"
                    }`}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="channel-name">Channel name</label>
            <input
              id="channel-name"
              className="field"
              placeholder="e.g. Amsterdam tech weekly"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="channel-handle">Handle</label>
            <div className="relative">
              <AtSign className="pointer-events-none absolute start-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="channel-handle"
                className="field ps-10 font-mono"
                placeholder="amsterdam_tech"
                value={channelHandle}
                onChange={(e) =>
                  setChannelHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32))
                }
                maxLength={32}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <p
              className={`mt-1.5 text-[11px] ${
                channelHandle && !handleValid ? "text-rose-300" : "text-slate-500"
              }`}
            >
              3–32 characters: a–z, 0–9, underscores. Unique across Luma.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="channel-desc">
              Description <span className="text-slate-600">(optional)</span>
            </label>
            <textarea
              id="channel-desc"
              rows={2}
              className="field resize-none"
              placeholder="What will you publish here?"
              value={channelDesc}
              onChange={(e) => setChannelDesc(e.target.value)}
              maxLength={300}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: true, label: "Public", desc: "Discoverable by anyone", icon: Globe },
                { value: false, label: "Private", desc: "Invite / request to join", icon: Lock },
              ] as const
            ).map((opt) => (
              <button
                key={opt.label}
                onClick={() => setChannelPublic(opt.value)}
                aria-pressed={channelPublic === opt.value}
                className={`rounded-2xl border px-4 py-3 text-start transition-all ${
                  channelPublic === opt.value
                    ? "border-luma-400/50 bg-luma-500/15 ring-2 ring-luma-500/30"
                    : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]"
                }`}
              >
                <opt.icon
                  className={`h-4 w-4 ${
                    channelPublic === opt.value ? "text-luma-300" : "text-slate-500"
                  }`}
                />
                <span className="mt-1.5 block text-[13px] font-semibold text-slate-100">
                  {opt.label}
                </span>
                <span className="block text-[10.5px] text-slate-500">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
