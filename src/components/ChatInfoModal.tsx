import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  Check,
  Copy,
  Crown,
  Globe,
  Hash,
  Loader2,
  Link2,
  LogOut,
  Pencil,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
  Ban,
  Flag,
  Timer,
} from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import {
  addChatMember,
  archiveChat,
  blockUser,
  createInvite,
  getChatParticipants,
  listInvites,
  listJoinRequests,
  approveJoin,
  rejectJoin,
  leaveChat,
  muteChat,
  removeChatMember,
  revokeInvite,
  searchProfiles,
  setChatTtl,
  setGroupAdmin,
  updateChannel,
  updateGroup,
  uploadChatAvatar,
} from "../lib/data";
import type { ChatParticipant, ChatSummary, Invite, JoinRequest, Profile } from "../lib/types";
import { useToast } from "../context/ToastContext";
import { useNavigate } from "react-router-dom";
import { ReportModal } from "./ReportModal";
import { reportMessage } from "../lib/data";

const TTL_OPTIONS = [
  { label: "Off", value: null as number | null },
  { label: "1 hour", value: 3600 },
  { label: "24 hours", value: 86400 },
  { label: "7 days", value: 604800 },
];

export function ChatInfoModal({
  open,
  onClose,
  summary,
  meId,
}: {
  open: boolean;
  onClose: () => void;
  summary: ChatSummary | null;
  meId: string;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<ChatParticipant[]>([]);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addResults, setAddResults] = useState<Profile[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [descDraft, setDescDraft] = useState("");
  const [savingDesc, setSavingDesc] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const chatId = summary?.chat.id ?? null;
  const isSaved = summary?.chat.kind === "saved";
  const isChannel = summary?.chat.kind === "channel";
  const isGroup = summary?.chat.is_group ?? false;
  const canModerate = summary?.isAdmin ?? false;
  const isDirect = summary?.chat.kind === "direct";
  const other = summary?.participants.find((p) => p.id !== meId) ?? null;
  const creatorId = summary?.chat.created_by;

  // Load membership table (is_admin flags live there) + invites + join requests.
  const reload = useCallback(async () => {
    if (!chatId || !summary) return;
    try {
      setRows(await getChatParticipants(chatId));
    } catch {
      setRows([]);
    }
    if (summary.chat.kind !== "direct" && summary.chat.kind !== "saved") {
      listInvites(chatId).then(setInvites).catch(() => setInvites([]));
      if (summary.chat.kind === "channel" && !summary.chat.is_public && (summary.isAdmin ?? false)) {
        listJoinRequests(chatId).then(setRequests).catch(() => setRequests([]));
      }
    }
  }, [chatId, summary]);

  useEffect(() => {
    if (open) {
      reload();
      setRenameDraft(summary?.chat.name ?? "");
      setDescDraft(summary?.chat.description ?? "");
      setMemberQuery("");
      setAddOpen(false);
      setInvitesOpen(false);
      setRenaming(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chatId]);

  useEffect(() => {
    let alive = true;
    if (!addOpen) return;
    setAddBusy(true);
    const t = window.setTimeout(() => {
      searchProfiles(memberQuery, meId)
        .then((p) => alive && setAddResults(p))
        .catch(() => alive && setAddResults([]))
        .finally(() => alive && setAddBusy(false));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [memberQuery, addOpen, meId]);

  const adminIds = useMemo(
    () => new Set(rows.filter((r) => r.is_admin).map((r) => r.user_id)),
    [rows]
  );
  const memberProfiles = useMemo(() => {
    if (!summary) return [];
    const t = memberQuery.trim().toLowerCase();
    return summary.participants.filter(
      (p) => !t || p.display_name.toLowerCase().includes(t) || (p.username ?? "").includes(t)
    );
  }, [summary, memberQuery]);
  const memberIdSet = useMemo(
    () => new Set(summary?.participants.map((p) => p.id) ?? []),
    [summary]
  );

  if (!summary) return null;

  const chat = summary.chat;
  const muted = Boolean(summary.mutedUntil && new Date(summary.mutedUntil) > new Date());
  const archived = Boolean(summary.archivedAt);

  async function saveRename() {
    const name = renameDraft.trim();
    if (!name || name === chat.name) {
      setRenaming(false);
      return;
    }
    setSavingName(true);
    try {
      if (isChannel) await updateChannel(chat.id, { name });
      else await updateGroup(chat.id, name);
      toast.push("Name updated", "success");
      setRenaming(false);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not rename", "error");
    } finally {
      setSavingName(false);
    }
  }

  async function saveDescription() {
    setSavingDesc(true);
    try {
      await updateChannel(chat.id, { description: descDraft.trim() });
      toast.push("Description updated", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not update description", "error");
    } finally {
      setSavingDesc(false);
    }
  }

  async function pickAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.push("Choose an image", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.push("Avatars must be under 5 MB", "error");
      return;
    }
    setAvatarBusy(true);
    try {
      const path = await uploadChatAvatar(chat.id, meId, file);
      await updateGroup(chat.id, undefined, path);
      toast.push("Avatar updated", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function setMute(kind: "8h" | "1w" | "forever" | "off") {
    try {
      if (kind === "off") await muteChat(chat.id, meId, null);
      else if (kind === "8h") await muteChat(chat.id, meId, new Date(Date.now() + 8 * 3600_000));
      else if (kind === "1w") await muteChat(chat.id, meId, new Date(Date.now() + 7 * 86400_000));
      else await muteChat(chat.id, meId, new Date(Date.now() + 100 * 365 * 86400_000));
      toast.push(kind === "off" ? "Unmuted" : "Muted", "success");
    } catch {
      toast.push("Could not update mute", "error");
    }
  }

  async function toggleArchive() {
    try {
      await archiveChat(chat.id, meId, !archived);
      toast.push(archived ? "Unarchived" : "Archived", "success");
    } catch {
      toast.push("Could not update archive", "error");
    }
  }

  async function setTtl(seconds: number | null) {
    try {
      await setChatTtl(chat.id, seconds);
      toast.push(seconds ? "Disappearing messages updated" : "Disappearing messages off", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Only admins can change this", "error");
    }
  }

  async function addMember(p: Profile) {
    try {
      await addChatMember(chat.id, p.id);
      toast.push(`${p.display_name} added`, "success");
      setAddOpen(false);
      setMemberQuery("");
      reload();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not add member", "error");
    }
  }

  async function removeMember(p: Profile) {
    try {
      await removeChatMember(chat.id, p.id);
      toast.push(`${p.display_name} removed`, "success");
      reload();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not remove member", "error");
    }
  }

  async function toggleAdmin(p: Profile) {
    const makeAdmin = !adminIds.has(p.id);
    try {
      await setGroupAdmin(chat.id, p.id, makeAdmin);
      toast.push(makeAdmin ? `${p.display_name} is now an admin` : `${p.display_name} is no longer an admin`, "success");
      reload();
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not change admin", "error");
    }
  }

  async function copyInvite(token: string) {
    const link = `${window.location.origin}/join/${token}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.push("Invite link copied", "success");
    } catch {
      toast.push("Could not copy link", "error");
    }
  }

  async function createNewInvite() {
    setInviteBusy(true);
    try {
      const invite = await createInvite(chat.id, { ttlSeconds: 86400, maxUses: 50 });
      setInvites((prev) => [invite, ...prev]);
      await copyInvite(invite.token);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not create invite", "error");
    } finally {
      setInviteBusy(false);
    }
  }

  async function revoke(token: string) {
    try {
      await revokeInvite(token);
      setInvites((prev) => prev.filter((i) => i.token !== token));
      toast.push("Invite revoked", "success");
    } catch {
      toast.push("Could not revoke invite", "error");
    }
  }

  async function handleJoinRequest(userId: string, approve: boolean) {
    try {
      if (approve) await approveJoin(chat.id, userId);
      else await rejectJoin(chat.id, userId);
      setRequests((prev) => prev.filter((r) => r.user_id !== userId));
      toast.push(approve ? "Member approved" : "Request rejected", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not process request", "error");
    }
  }

  async function blockOther() {
    if (!other) return;
    try {
      await blockUser(meId, other.id);
      toast.push("User blocked", "success");
      onClose();
    } catch {
      toast.push("Could not block user", "error");
    }
  }

  async function leave() {
    try {
      await leaveChat(chat.id);
      toast.push("You left the conversation", "success");
      onClose();
      navigate("/");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not leave", "error");
    }
  }

  const title = isSaved ? "Saved Messages" : isDirect ? other?.display_name ?? "Direct message" : chat.name ?? (isChannel ? "Channel" : "Group chat");
  const subtitle = isSaved
    ? "Private space"
    : isChannel
      ? `${chat.is_public ? "Public" : "Private"} channel${chat.username ? ` · @${chat.username}` : ""}`
      : isDirect
        ? other?.username ? `@${other.username}` : "Direct message"
        : `${summary.participants.length} members${chat.username ? ` · @${chat.username}` : ""}`;

  const manageable = (isGroup || isChannel) && !isSaved;

  return (
    <Modal open={open} onClose={onClose} title="Details" subtitle={subtitle} maxWidth="max-w-lg">
      {/* header */}
      <div className="flex flex-col items-center">
        <div className="relative">
          <Avatar
            profile={isDirect ? other : null}
            label={isSaved ? "Saved" : title}
            group={!isDirect}
            saved={isSaved}
            chatAvatarPath={!isDirect && !isSaved ? chat.avatar_path : null}
            size={88}
            ring
          />
          {manageable && canModerate && (
            <>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={avatarBusy}
                className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-luma-600 text-white shadow-bubble transition-transform hover:scale-105"
                aria-label="Change avatar"
              >
                {avatarBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  pickAvatar(e.target.files);
                  e.currentTarget.value = "";
                }}
              />
            </>
          )}
        </div>

        {renaming ? (
          <div className="mt-3 flex w-full items-center gap-2">
            <input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              className="field py-2 text-[15px]"
              maxLength={80}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
            <button onClick={saveRename} disabled={savingName} className="btn-ghost h-11 px-3" aria-label="Save name">
              {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <h3 className="text-[17px] font-semibold text-white">{title}</h3>
            {manageable && canModerate && (
              <button onClick={() => setRenaming(true)} className="rounded-full p-1.5 text-slate-500 hover:bg-white/10 hover:text-white" aria-label="Rename">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        <div className="mt-1 flex items-center gap-2 text-[11.5px] text-slate-500">
          {isChannel && (chat.is_public ? <Globe className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />)}
          <span>Created {new Date(chat.created_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</span>
        </div>
      </div>

      {/* channel description */}
      {isChannel && (
        <div className="mt-4">
          <label className="label" htmlFor="channel-desc">Description</label>
          {canModerate ? (
            <div className="flex items-start gap-2">
              <textarea
                id="channel-desc"
                rows={2}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                className="field resize-none text-[13px]"
                maxLength={300}
                placeholder="What is this channel about?"
              />
              <button onClick={saveDescription} disabled={savingDesc} className="btn-ghost h-11 px-3" aria-label="Save description">
                {savingDesc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </button>
            </div>
          ) : (
            chat.description && <p className="text-[13px] leading-relaxed text-slate-300">{chat.description}</p>
          )}
        </div>
      )}

      {/* quick actions */}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <button onClick={() => setMute(muted ? "off" : "8h")} className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition-colors hover:bg-white/[0.08]">
          <BellOff className="h-4 w-4 text-luma-300" />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-slate-100">{muted ? "Unmute" : "Mute 8h"}</span>
            <span className="block text-[10.5px] text-slate-500">{muted ? "Notifications on" : "Silence pings"}</span>
          </span>
        </button>
        <button onClick={() => setMute("1w")} className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition-colors hover:bg-white/[0.08]">
          <BellOff className="h-4 w-4 text-slate-400" />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-slate-100">Mute 1 week</span>
            <span className="block text-[10.5px] text-slate-500">Long silence</span>
          </span>
        </button>
        <button onClick={toggleArchive} className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition-colors hover:bg-white/[0.08]">
          {archived ? <ArchiveRestore className="h-4 w-4 text-emerald-300" /> : <Archive className="h-4 w-4 text-sky-300" />}
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-slate-100">{archived ? "Unarchive" : "Archive"}</span>
            <span className="block text-[10.5px] text-slate-500">{archived ? "Back to inbox" : "Tuck away"}</span>
          </span>
        </button>
        {manageable && canModerate ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
              <Timer className="h-3.5 w-3.5" /> Disappearing
            </span>
            <div className="mt-1 flex flex-wrap gap-1">
              {TTL_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  onClick={() => setTtl(o.value)}
                  className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                    (chat.ttl_seconds ?? null) === o.value || (!chat.ttl_seconds && o.value === null)
                      ? "bg-luma-500/30 text-luma-100 ring-1 ring-luma-400/40"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-3">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
              <Timer className="h-3.5 w-3.5" /> Disappearing
            </span>
            <span className="mt-1 block text-[12.5px] text-slate-300">
              {chat.ttl_seconds ? `After ${Math.round(chat.ttl_seconds / 3600)}h` : "Off"}
            </span>
          </div>
        )}
      </div>

      {/* members */}
      {manageable && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-slate-500">
              <Users className="h-3.5 w-3.5" /> {isChannel ? "Subscribers" : "Members"} · {summary.participants.length}
            </div>
            {canModerate && (
              <button onClick={() => setAddOpen((v) => !v)} className="flex items-center gap-1.5 rounded-full border border-luma-400/30 bg-luma-500/15 px-2.5 py-1 text-[11px] font-medium text-luma-200 transition-colors hover:bg-luma-500/25">
                <UserPlus className="h-3.5 w-3.5" /> Add
              </button>
            )}
          </div>

          {addOpen && (
            <div className="mb-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2">
              <input
                autoFocus
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder="Search people to add…"
                className="field py-2 text-[13px]"
              />
              <div className="mt-1.5 max-h-40 overflow-y-auto no-scrollbar">
                {addBusy && <Loader2 className="mx-auto my-3 h-4 w-4 animate-spin text-slate-500" />}
                {addResults.filter((p) => !memberIdSet.has(p.id)).map((p) => (
                  <button key={p.id} onClick={() => addMember(p)} className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.06]">
                    <Avatar profile={p} size={30} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">{p.display_name}</span>
                    <UserPlus className="h-3.5 w-3.5 text-luma-300" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="max-h-52 space-y-1 overflow-y-auto no-scrollbar">
            {memberProfiles.map((p) => {
              const isAdmin = adminIds.has(p.id);
              const isCreator = p.id === creatorId;
              const isMe = p.id === meId;
              return (
                <div key={p.id} className="flex items-center gap-2.5 rounded-2xl px-2 py-1.5 hover:bg-white/[0.04]">
                  <Avatar profile={p} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[13.5px] text-slate-200">
                      <span className="truncate">{p.display_name}{isMe ? " (you)" : ""}</span>
                      {isCreator && <Crown className="h-3 w-3 shrink-0 text-amber-400" aria-label="Owner" />}
                      {isAdmin && !isCreator && <ShieldCheck className="h-3 w-3 shrink-0 text-luma-300" aria-label="Admin" />}
                    </div>
                    <div className="text-[11px] text-slate-500">{p.username ? `@${p.username}` : "Member"}</div>
                  </div>
                  {canModerate && !isMe && !isCreator && (
                    <>
                      <button
                        onClick={() => toggleAdmin(p)}
                        title={isAdmin ? "Remove admin" : "Make admin"}
                        className="rounded-full p-1.5 text-slate-500 transition-colors hover:bg-white/10 hover:text-white"
                      >
                        {isAdmin ? <ShieldOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                      </button>
                      <button
                        onClick={() => removeMember(p)}
                        title="Remove from chat"
                        className="rounded-full p-1.5 text-slate-500 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
                      >
                        <UserMinus className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* join requests */}
      {isChannel && !chat.is_public && canModerate && requests.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-amber-300/80">
            Join requests · {requests.length}
          </div>
          <div className="space-y-1.5">
            {requests.map((r) => (
              <div key={r.user_id} className="flex items-center gap-2.5 rounded-2xl border border-amber-400/15 bg-amber-500/[0.06] px-2.5 py-2">
                <Avatar profile={r.profile ?? null} label="?" size={34} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">
                  {r.profile?.display_name ?? "Unknown user"}
                </span>
                <button onClick={() => handleJoinRequest(r.user_id, true)} className="grid h-8 w-8 place-items-center rounded-full bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30" aria-label="Approve">
                  <Check className="h-4 w-4" />
                </button>
                <button onClick={() => handleJoinRequest(r.user_id, false)} className="grid h-8 w-8 place-items-center rounded-full bg-rose-500/15 text-rose-300 hover:bg-rose-500/25" aria-label="Reject">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* invite links */}
      {manageable && canModerate && (
        <div className="mt-5">
          <button onClick={() => setInvitesOpen((v) => !v)} className="flex w-full items-center gap-2 text-[12px] font-medium uppercase tracking-wider text-slate-500 hover:text-slate-300">
            <Link2 className="h-3.5 w-3.5" /> Invite links
            <span className="ml-auto text-[10.5px] normal-case tracking-normal text-slate-600">{invites.length} active</span>
          </button>
          {invitesOpen && (
            <div className="mt-2 space-y-1.5">
              <button onClick={createNewInvite} disabled={inviteBusy} className="btn-ghost w-full justify-center text-[13px]">
                {inviteBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                Create invite link
              </button>
              {invites.map((inv) => (
                <div key={inv.token} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11.5px] text-luma-200">/join/{inv.token.slice(0, 12)}…</div>
                    <div className="text-[10px] text-slate-500">
                      {inv.uses}/{inv.max_uses} uses{inv.expires_at ? ` · expires ${new Date(inv.expires_at).toLocaleDateString()}` : ""}
                    </div>
                  </div>
                  <button onClick={() => copyInvite(inv.token)} className="rounded-full p-1.5 text-slate-400 hover:text-white" aria-label="Copy link">
                    <Copy className="h-4 w-4" />
                  </button>
                  <button onClick={() => revoke(inv.token)} className="rounded-full p-1.5 text-slate-500 hover:text-rose-300" aria-label="Revoke">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* danger zone */}
      <div className="mt-6 border-t border-white/[0.07] pt-4">
        {isDirect && other && (
          <button onClick={blockOther} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-[13px] text-rose-300/90 transition-colors hover:bg-rose-500/[0.08]">
            <Ban className="h-4 w-4" /> Block {other.display_name}
          </button>
        )}
        {(isDirect || isGroup || isChannel) && (
          <button onClick={() => setReportOpen(true)} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-[13px] text-slate-400 transition-colors hover:bg-white/[0.05]">
            <Flag className="h-4 w-4" /> Report conversation
          </button>
        )}
        {!isSaved && (
          <button onClick={leave} className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-[13px] text-rose-300 transition-colors hover:bg-rose-500/[0.08]">
            <LogOut className="h-4 w-4" /> {isDirect ? "Delete conversation" : isChannel ? "Leave channel" : "Leave group"}
          </button>
        )}
        <p className="mt-2 px-3 text-[10.5px] leading-relaxed text-slate-600">
          Messages are stored securely. Media is served via short-lived signed URLs.
          Only participants can read this conversation.
        </p>
      </div>
      <ReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title="Report this conversation to the Luma team"
        onSubmit={async (reason, details) => {
          await reportMessage({ chatId: chat.id, messageId: null, reporter: meId, reason, details });
          toast.push("Report submitted", "success");
        }}
      />
    </Modal>
  );
}
