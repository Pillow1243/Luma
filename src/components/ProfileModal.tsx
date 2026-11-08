import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { Camera, Loader2, LogOut, Moon, Sun, Sparkles } from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useToast } from "../context/ToastContext";
import { uploadAvatar } from "../lib/data";
import { supabase } from "../lib/supabase";
import { motion as m } from "framer-motion";

export function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { profile, renameMe, setAvatarPath, signOut, user } = useAuth();
  const { theme, toggle } = useTheme();
  const toast = useToast();
  const [name, setName] = useState(profile?.display_name ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function saveName() {
    if (!name.trim() || name.trim() === profile?.display_name) return;
    setSaving(true);
    try {
      await renameMe(name);
      toast.push("Display name updated", "success");
    } catch {
      toast.push("Could not update name", "error");
    } finally {
      setSaving(false);
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
      await supabase.from("profiles").update({ avatar_path: path }).eq("id", profile.id);
      await setAvatarPath(path);
      toast.push("Avatar updated", "success");
    } catch (err) {
      toast.push(err instanceof Error ? err.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Your profile" subtitle={user?.email ?? undefined}>
      <div className="flex flex-col items-center">
        <div className="relative">
          <Avatar profile={profile} size={92} ring />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="absolute -bottom-1 -right-1 grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-luma-600 text-white shadow-bubble transition-transform hover:scale-105 active:scale-95"
            aria-label="Change avatar"
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
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
        <p className="mt-3 text-[13px] text-slate-400">
          {profile?.display_name ?? "Luma user"}
        </p>
      </div>

      <div className="mt-6">
        <label className="label" htmlFor="display-name">
          Display name
        </label>
        <div className="flex gap-2">
          <input
            id="display-name"
            className="field"
            value={name || profile?.display_name || ""}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            onBlur={saveName}
          />
          <button onClick={saveName} disabled={saving} className="btn-ghost px-4">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        <button
          onClick={toggle}
          className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left transition-colors hover:bg-white/[0.08]"
        >
          {theme === "dark" ? (
            <Moon className="h-4 w-4 text-luma-300" />
          ) : (
            <Sun className="h-4 w-4 text-amber-300" />
          )}
          <span className="flex-1 text-[14px] text-slate-200">
            {theme === "dark" ? "Dark appearance" : "Light appearance"}
          </span>
          <span className="relative h-6 w-11 rounded-full bg-white/10">
            <m.span
              layout
              transition={{ type: "spring", stiffness: 500, damping: 34 }}
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-luma-gradient shadow ${
                theme === "dark" ? "left-0.5" : "left-[1.375rem]"
              }`}
            />
          </span>
        </button>

        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
          <Sparkles className="h-4 w-4 text-luma-300" />
          <span className="flex-1 text-[14px] text-slate-200">Luma</span>
          <span className="chip">v1.0.0</span>
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
