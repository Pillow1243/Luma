import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Ban,
  Camera,
  Check,
  Eye,
  EyeOff,
  Loader2,
  LogOut,
  Moon,
  Sun,
  KeyRound,
  AtSign,
  Type,
  Wallpaper,
  Sparkles,
} from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { useAuth } from "../context/AuthContext";
import { useTheme, type Accent, type MsgSize, type Wallpaper as WallpaperChoice } from "../context/ThemeContext";
import { useToast } from "../context/ToastContext";
import {
  fetchProfiles,
  listBlockedIds,
  unblockUser,
  updateProfile,
  uploadAvatar,
} from "../lib/data";
import { supabase } from "../lib/supabase";
import type { Profile } from "../lib/types";

const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "violet", label: "Violet", swatch: "from-violet-400 to-purple-700" },
  { id: "azure", label: "Azure", swatch: "from-sky-300 to-indigo-500" },
  { id: "emerald", label: "Emerald", swatch: "from-emerald-300 to-teal-600" },
  { id: "rose", label: "Rose", swatch: "from-rose-300 to-rose-600" },
  { id: "amber", label: "Amber", swatch: "from-amber-300 to-orange-600" },
];

export function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, refreshProfile, renameMe, setAvatarPath, signOut, user } = useAuth();
  const { theme, toggle, accent, setAccent, msgSize, setMsgSize, wallpaper, setWallpaper } =
    useTheme();
  const toast = useToast();

  const [name, setName] = useState(profile?.display_name ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [showLastSeen, setShowLastSeen] = useState(profile?.show_last_seen ?? true);
  const [saving, setSaving] = useState(false);
  const [savingUser, setSavingUser] = useState(false);
  const [savingBio, setSavingBio] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [blocked, setBlocked] = useState<Profile[]>([]);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(profile?.display_name ?? "");
    setUsername(profile?.username ?? "");
    setBio(profile?.bio ?? "");
    setShowLastSeen(profile?.show_last_seen ?? true);
  }, [profile]);

  const loadBlocked = useCallback(async () => {
    if (!profile) return;
    try {
      const ids = await listBlockedIds(profile.id);
      setBlocked(await fetchProfiles(ids));
    } catch {
      setBlocked([]);
    }
  }, [profile]);

  useEffect(() => {
    if (open) loadBlocked();
  }, [open, loadBlocked]);

  async function saveName() {
    const value = name.trim();
    if (!value || value === profile?.display_name) return;
    setSaving(true);
    try {
      await renameMe(value);
      toast.push("Display name updated", "success");
    } catch {
      toast.push("Could not update name", "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveUsername() {
    if (!profile) return;
    const value = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    setUsername(value);
    if (value === (profile.username ?? "")) return;
    if (value && !/^[a-z0-9_]{3,32}$/.test(value)) {
      toast.push("Usernames are 3–32 chars: a–z, 0–9, underscore", "error");
      return;
    }
    setSavingUser(true);
    try {
      await updateProfile(profile.id, { username: value || null });
      await refreshProfile();
      toast.push("Username updated", "success");
    } catch (err) {
      toast.push(
        err instanceof Error && err.message.includes("duplicate")
          ? "That username is taken"
          : "Could not update username",
        "error"
      );
    } finally {
      setSavingUser(false);
    }
  }

  async function saveBio() {
    if (!profile) return;
    const value = bio.trim();
    if (value === (profile.bio ?? "")) return;
    setSavingBio(true);
    try {
      await updateProfile(profile.id, { bio: value });
      await refreshProfile();
      toast.push("Bio updated", "success");
    } catch {
      toast.push("Could not update bio", "error");
    } finally {
      setSavingBio(false);
    }
  }

  async function toggleLastSeen() {
    if (!profile) return;
    const next = !showLastSeen;
    setShowLastSeen(next);
    try {
      await updateProfile(profile.id, { show_last_seen: next });
      await refreshProfile();
    } catch {
      setShowLastSeen(!next);
      toast.push("Could not update privacy", "error");
    }
  }

  async function onPickAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file || !profile) return;
    if (!file.type.startsWith("image/")) {
      toast.push("Choose an image file", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.push("Avatars must be under 5 MB", "error");
      return;
    }
    setUploading(true);
    try {
      const path = await uploadAvatar(profile.id, file);
      await setAvatarPath(path);
      toast.push("Avatar updated", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function unblock(p: Profile) {
    if (!profile) return;
    try {
      await unblockUser(profile.id, p.id);
      setBlocked((prev) => prev.filter((x) => x.id !== p.id));
      toast.push(`${p.display_name} unblocked`, "success");
    } catch {
      toast.push("Could not unblock", "error");
    }
  }

  async function changePassword() {
    if (pw.length < 8) {
      toast.push("Password must be at least 8 characters", "error");
      return;
    }
    setPwBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      setPw("");
      setPwOpen(false);
      toast.push("Password changed", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Could not change password", "error");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="You" subtitle={user?.email ?? undefined} maxWidth="max-w-lg">
      {/* identity */}
      <div className="flex flex-col items-center">
        <div className="relative">
          <Avatar profile={profile} size={92} ring />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-luma-600 text-white shadow-bubble transition-transform hover:scale-105 active:scale-95"
            aria-label="Change avatar"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              onPickAvatar(e.target.files);
              e.currentTarget.value = "";
            }}
          />
        </div>
        <p className="mt-3 text-[15px] font-semibold text-white">{profile?.display_name ?? "Luma user"}</p>
        {profile?.username && <p className="text-[12px] text-luma-300">@{profile.username}</p>}
      </div>

      <div className="mt-5 space-y-4">
        {/* display name */}
        <div>
          <label className="label" htmlFor="display-name">Display name</label>
          <div className="flex gap-2">
            <input id="display-name" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} onBlur={saveName} />
            <button onClick={saveName} disabled={saving} className="btn-ghost px-4">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </button>
          </div>
        </div>

        {/* username */}
        <div>
          <label className="label" htmlFor="username">Username</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <AtSign className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="username"
                className="field pl-10 font-mono"
                placeholder="your_handle"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                onBlur={saveUsername}
                maxLength={32}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <button onClick={saveUsername} disabled={savingUser} className="btn-ghost px-4">
              {savingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">People can find and mention you by @username.</p>
        </div>

        {/* bio */}
        <div>
          <label className="label" htmlFor="bio">Bio</label>
          <div className="flex items-start gap-2">
            <textarea
              id="bio"
              rows={2}
              className="field resize-none text-[13.5px]"
              placeholder="A line about you"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              onBlur={saveBio}
              maxLength={160}
            />
            <button onClick={saveBio} disabled={savingBio} className="btn-ghost h-12 px-4">
              {savingBio ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* appearance */}
      <div className="mt-6">
        <div className="label">Appearance</div>
        <div className="space-y-2">
          <button
            onClick={toggle}
            className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.08]"
          >
            {theme === "dark" ? <Moon className="h-4 w-4 text-luma-300" /> : <Sun className="h-4 w-4 text-amber-300" />}
            <span className="flex-1 text-[14px] text-slate-200">{theme === "dark" ? "Dark" : "Light"}</span>
            <span className="relative h-6 w-11 rounded-full bg-white/10">
              <motion.span
                layout
                transition={{ type: "spring", stiffness: 500, damping: 34 }}
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-luma-gradient shadow ${theme === "dark" ? "left-0.5" : "left-[1.375rem]"}`}
              />
            </span>
          </button>

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-slate-200">Accent</span>
              <div className="flex gap-1.5">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setAccent(a.id)}
                    title={a.label}
                    aria-pressed={accent === a.id}
                    className={`h-6 w-6 rounded-full bg-gradient-to-br ${a.swatch} transition-transform hover:scale-110 ${
                      accent === a.id ? "ring-2 ring-white/80 ring-offset-2 ring-offset-luma-ink" : "opacity-70"
                    }`}
                  />
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] font-medium text-slate-200"><Type className="h-3.5 w-3.5 text-slate-500" /> Text size</span>
              <div className="flex gap-1 rounded-full border border-white/10 p-0.5">
                {(["small", "medium", "large"] as MsgSize[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setMsgSize(s)}
                    aria-pressed={msgSize === s}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${msgSize === s ? "bg-luma-500/30 text-luma-100" : "text-slate-500 hover:text-slate-200"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] font-medium text-slate-200"><Wallpaper className="h-3.5 w-3.5 text-slate-500" /> Wallpaper</span>
              <div className="flex gap-1 rounded-full border border-white/10 p-0.5">
                {(["default", "stars", "aurora"] as WallpaperChoice[]).map((w) => (
                  <button
                    key={w}
                    onClick={() => setWallpaper(w)}
                    aria-pressed={wallpaper === w}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${wallpaper === w ? "bg-luma-500/30 text-luma-100" : "text-slate-500 hover:text-slate-200"}`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* privacy */}
      <div className="mt-6">
        <div className="label">Privacy</div>
        <button
          onClick={toggleLastSeen}
          className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.08]"
        >
          {showLastSeen ? <Eye className="h-4 w-4 text-luma-300" /> : <EyeOff className="h-4 w-4 text-slate-500" />}
          <span className="flex-1">
            <span className="block text-[14px] text-slate-200">Last seen &amp; online</span>
            <span className="block text-[11px] text-slate-500">
              {showLastSeen ? "Contacts can see when you were last here" : "Hidden from everyone"}
            </span>
          </span>
          <span className={`relative h-6 w-11 rounded-full transition-colors ${showLastSeen ? "bg-luma-500/60" : "bg-white/10"}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${showLastSeen ? "left-[1.375rem]" : "left-0.5"}`} />
          </span>
        </button>
      </div>

      {/* account */}
      <div className="mt-6 space-y-2">
        <button onClick={() => setPwOpen((v) => !v)} className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.08]">
          <KeyRound className="h-4 w-4 text-luma-300" />
          <span className="flex-1 text-[14px] text-slate-200">Change password</span>
        </button>
        {pwOpen && (
          <div className="flex gap-2">
            <input
              type="password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="New password (8+ characters)"
              className="field"
              autoComplete="new-password"
            />
            <button onClick={changePassword} disabled={pwBusy || pw.length < 8} className="btn-ghost px-4">
              {pwBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update"}
            </button>
          </div>
        )}

        <button onClick={() => setBlockedOpen((v) => !v)} className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.08]">
          <Ban className="h-4 w-4 text-rose-300" />
          <span className="flex-1 text-[14px] text-slate-200">Blocked users</span>
          <span className="chip">{blocked.length}</span>
        </button>
        {blockedOpen && (
          <div className="space-y-1 rounded-2xl border border-white/10 bg-white/[0.03] p-2">
            {blocked.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-slate-500">Nobody blocked.</p>
            ) : (
              blocked.map((p) => (
                <div key={p.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                  <Avatar profile={p} size={32} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">{p.display_name}</span>
                  <button onClick={() => unblock(p)} className="text-[12px] font-medium text-luma-300 hover:text-luma-200">
                    Unblock
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
          <Sparkles className="h-4 w-4 text-luma-300" />
          <span className="flex-1 text-[14px] text-slate-200">Luma</span>
          <span className="chip">v2.0.0</span>
        </div>

        <button
          onClick={() => {
            onClose();
            signOut();
          }}
          className="flex w-full items-center gap-3 rounded-2xl border border-rose-400/20 bg-rose-500/[0.08] px-4 py-3 text-left transition-colors hover:bg-rose-500/[0.16]"
        >
          <LogOut className="h-4 w-4 text-rose-300" />
          <span className="flex-1 text-[14px] text-rose-200">Sign out</span>
        </button>
      </div>
    </Modal>
  );
}
