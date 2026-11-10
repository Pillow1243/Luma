import { format, isSameDay, isToday, isYesterday } from "date-fns";

export function timeOfDay(iso: string): string {
  return format(new Date(iso), "HH:mm");
}

export function relativeDay(iso: string, lang: "en" | "fa" = "en"): string {
  const d = new Date(iso);
  if (isToday(d)) return lang === "fa" ? "امروز" : "Today";
  if (isYesterday(d)) return lang === "fa" ? "دیروز" : "Yesterday";
  if (lang === "fa") {
    return new Intl.DateTimeFormat("fa-IR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(d);
  }
  return format(d, "EEEE, d MMMM");
}

export function shortStamp(iso: string, lang: "en" | "fa" = "en"): string {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return lang === "fa" ? "دیروز" : "Yesterday";
  const now = new Date();
  if (lang === "fa") {
    return new Intl.DateTimeFormat(
      "fa-IR",
      now.getFullYear() === d.getFullYear()
        ? { day: "numeric", month: "short" }
        : { year: "numeric", month: "2-digit", day: "2-digit" }
    ).format(d);
  }
  if (now.getFullYear() === d.getFullYear()) return format(d, "d MMM");
  return format(d, "dd/MM/yyyy");
}

export function shouldShowDayGroup(a: string, b?: string): boolean {
  if (!b) return true;
  return !isSameDay(new Date(a), new Date(b));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic, brand-aligned avatar tint from a user id. */
export function avatarTint(seed: string): string {
  const palettes = [
    "from-violet-400 to-indigo-600",
    "from-fuchsia-400 to-purple-700",
    "from-sky-400 to-violet-600",
    "from-purple-400 to-rose-500",
    "from-indigo-400 to-violet-700",
    "from-teal-300 to-indigo-500",
    "from-pink-400 to-violet-600",
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return palettes[Math.abs(hash) % palettes.length];
}

export function isImage(type: string | null, name?: string | null): boolean {
  if (type === "image/svg+xml") return false;
  if (type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(name ?? "");
}

export function isVideo(type: string | null, name?: string | null): boolean {
  if (type?.startsWith("video/")) return true;
  return /\.(mp4|mov|webm|m4v)$/i.test(name ?? "");
}

export function isAudio(type: string | null, name?: string | null): boolean {
  if (type?.startsWith("audio/")) return true;
  return /\.(mp3|wav|m4a|ogg|opus|aac)$/i.test(name ?? "");
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function previewOf(body: string | null, hasMedia: boolean, mediaName?: string | null): string {
  if (body?.startsWith("luma:e2ee:")) return "🔒 Encrypted message";
  if (body?.startsWith("luma:sticker:v1:")) return "✨ Sticker";
  if (body?.startsWith("luma:gif:v1:")) return "GIF";
  if (body && body.trim()) return body.trim().replace(/\s+/g, " ");
  if (hasMedia) return mediaName ? `📎 ${mediaName}` : "📎 Attachment";
  return "No messages yet";
}
