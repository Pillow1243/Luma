import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { avatarUrl, chatAvatarUrl } from "../lib/data";
import { avatarTint, initials } from "../lib/format";
import type { Profile } from "../lib/types";
import { Bookmark, Users } from "lucide-react";

type Props = {
  profile?: Profile | null;
  label?: string;
  size?: number;
  online?: boolean;
  group?: boolean;
  ring?: boolean;
  className?: string;
  saved?: boolean;
  chatAvatarPath?: string | null;
};

export function Avatar({
  profile,
  label,
  size = 44,
  online = false,
  group = false,
  ring = false,
  className = "",
  saved = false,
  chatAvatarPath = null,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const name = profile?.display_name ?? label ?? "?";
  const seed = profile?.id ?? name;

  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (chatAvatarPath) {
      chatAvatarUrl(chatAvatarPath)
        .then((u) => alive && setSrc(u))
        .catch(() => {});
    } else if (profile?.avatar_path) {
      avatarUrl(profile.avatar_path)
        .then((u) => alive && setSrc(u))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [profile?.avatar_path, profile?.id, chatAvatarPath]);

  const dim = { width: size, height: size };
  const iconSize = Math.max(14, Math.round(size * 0.44));

  return (
    <div className={`relative shrink-0 ${className}`} style={dim}>
      <div
        className={`grid h-full w-full place-items-center overflow-hidden rounded-[30%] bg-gradient-to-br ${avatarTint(
          seed
        )} font-semibold text-white ${ring ? "ring-2 ring-luma-400/40 ring-offset-2 ring-offset-luma-ink" : ""}`}
        style={{ fontSize: Math.max(11, size * 0.34) }}
      >
        {src ? (
          <img src={src} alt={name} className="h-full w-full object-cover" loading="lazy" />
        ) : saved ? (
          <Bookmark style={{ width: iconSize, height: iconSize }} strokeWidth={2} className="fill-white/90" />
        ) : group ? (
          <Users style={{ width: size * 0.45, height: size * 0.45 }} strokeWidth={2} />
        ) : (
          <span className="select-none drop-shadow-sm">{initials(name)}</span>
        )}
      </div>

      {online && (
        <span
          className="absolute -bottom-0.5 -end-0.5 block rounded-full border-2 border-luma-ink bg-emerald-400"
          style={{ width: Math.max(9, size * 0.26), height: Math.max(9, size * 0.26) }}
        >
          <motion.span
            className="absolute inset-0 rounded-full bg-emerald-400/70"
            animate={{ scale: [1, 1.9], opacity: [0.7, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        </span>
      )}
    </div>
  );
}
